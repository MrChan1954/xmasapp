import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { assertValidVapidKeys, base64UrlToBytes, bytesToBase64Url, createVapidToken, encryptPushPayload, MAX_PAYLOAD_BYTES, sendPushNotification, type PushSubscriptionKeys, type VapidKeys } from "./web-push.ts";

/**
 * These tests stand in for a push service. There is no way to assert against
 * Apple's or Google's servers from CI, so instead the encryption is verified by
 * decrypting it the way a browser would, and the VAPID token by decoding and
 * verifying the signature with the public half of the pair.
 *
 * If this file passes, the bytes on the wire are RFC 8291 and RFC 8292
 * compliant, which is the part that cannot be checked by reading the code.
 */

function toBase64Url(buffer: ArrayBuffer | Uint8Array) {
  return bytesToBase64Url(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
}

/** A throwaway VAPID pair, generated per run. Never a real key. */
async function generateVapidKeys(): Promise<VapidKeys & { verifyKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    publicKey: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: jwk.d!,
    subject: "mailto:christmas@example.com",
    verifyKey: pair.publicKey,
  };
}

/** Stands in for a browser: an ECDH pair plus a 16-byte auth secret. */
async function generateDevice() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keyPair: pair,
    subscription: {
      endpoint: "https://push.example.com/send/abc123",
      p256dh: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
      auth: bytesToBase64Url(auth),
    } satisfies PushSubscriptionKeys,
  };
}

/** The receiving half of RFC 8291, written independently of the sender. */
async function decryptAsDevice(body: Uint8Array, devicePrivateKey: CryptoKey, subscription: PushSubscriptionKeys) {
  const salt = body.slice(0, 16);
  const keyIdLength = body[20];
  const senderPublicKeyBytes = body.slice(21, 21 + keyIdLength);
  const ciphertext = body.slice(21 + keyIdLength);

  const senderKey = await crypto.subtle.importKey(
    "raw",
    senderPublicKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, devicePrivateKey, 256);

  const devicePublicKeyBytes = base64UrlToBytes(subscription.p256dh);
  const keyInfo = new Uint8Array([
    ...new TextEncoder().encode("WebPush: info\0"),
    ...devicePublicKeyBytes,
    ...senderPublicKeyBytes,
  ]);
  const ikm = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: base64UrlToBytes(subscription.auth),
      info: keyInfo,
    },
    await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]),
    256,
  );

  const hkdf = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cek = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("Content-Encoding: aes128gcm\0") },
    hkdf,
    128,
  );
  const nonce = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("Content-Encoding: nonce\0") },
    hkdf,
    96,
  );

  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
    ciphertext,
  ));

  // Trailing 0x02 is the RFC 8188 last-record delimiter.
  assert.equal(plaintext[plaintext.length - 1], 0x02, "payload must end with the last-record delimiter");
  return new TextDecoder().decode(plaintext.slice(0, -1));
}

test("base64url survives a round trip and tolerates missing padding", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(65));
  const encoded = bytesToBase64Url(bytes);

  assert.doesNotMatch(encoded, /[+/=]/, "base64url uses -_ and drops padding");
  assert.deepEqual([...base64UrlToBytes(encoded)], [...bytes]);
});

test("malformed VAPID configuration is rejected before anything is sent", async () => {
  const keys = await generateVapidKeys();

  assert.doesNotThrow(() => assertValidVapidKeys(keys));
  assert.throws(
    () => assertValidVapidKeys({ ...keys, publicKey: bytesToBase64Url(new Uint8Array(65)) }),
    /uncompressed P-256/,
    "a 65-byte blob that does not start with 0x04 is not a public point",
  );
  assert.throws(
    () => assertValidVapidKeys({ ...keys, privateKey: bytesToBase64Url(new Uint8Array(16)) }),
    /32 bytes/,
  );
  assert.throws(() => assertValidVapidKeys({ ...keys, subject: "christmas@example.com" }), /mailto:/);
});

test("the VAPID token is a verifiable ES256 JWT scoped to the push service origin", async () => {
  const keys = await generateVapidKeys();
  const now = 1_800_000_000;
  const token = await createVapidToken("https://push.example.com/send/secret-device-path", keys, now);

  const [header, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(base64UrlToBytes(header))), { typ: "JWT", alg: "ES256" });

  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(claims)));
  // The origin only. The endpoint path identifies the device and must not be
  // handed to the push service operator inside a signed token.
  assert.equal(payload.aud, "https://push.example.com");
  assert.doesNotMatch(claims, /secret-device-path/);
  assert.equal(payload.sub, keys.subject);
  assert.ok(payload.exp > now && payload.exp <= now + 24 * 60 * 60, "RFC 8292 caps the lifetime at 24 hours");

  const signatureBytes = base64UrlToBytes(signature);
  assert.equal(signatureBytes.length, 64, "ES256 is a raw r||s pair, not DER");
  assert.ok(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.verifyKey,
      signatureBytes,
      new TextEncoder().encode(`${header}.${claims}`),
    ),
    "the push service must be able to verify the signature with the advertised public key",
  );
});

test("an encrypted payload decrypts back to the original on the receiving device", async () => {
  const device = await generateDevice();
  const message = JSON.stringify({
    title: "🎁 New purchase for Mum",
    body: "Jade added £24.99 of gifts for Mum.",
    url: "/people?person=abc",
  });

  const body = await encryptPushPayload(device.subscription, message);
  assert.equal(await decryptAsDevice(body, device.keyPair.privateKey, device.subscription), message);
});

test("the aes128gcm envelope has the header the specification requires", async () => {
  const device = await generateDevice();
  const message = "hello";
  const body = await encryptPushPayload(device.subscription, message);

  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16, false), 4096, "record size");
  assert.equal(body[20], 65, "key id length is the uncompressed sender key");
  assert.equal(body[21], 0x04, "the key id is an uncompressed P-256 point");
  // 16 salt + 4 record size + 1 length + 65 key + plaintext + 1 delimiter + 16 tag.
  assert.equal(body.length, 21 + 65 + message.length + 1 + 16);
});

test("every message uses a fresh salt and ephemeral key", async () => {
  const device = await generateDevice();
  const first = await encryptPushPayload(device.subscription, "same message");
  const second = await encryptPushPayload(device.subscription, "same message");

  // Reusing either across two messages to one device would be a real
  // cryptographic failure, so identical plaintext must still differ on the wire.
  assert.notDeepEqual([...first.slice(0, 16)], [...second.slice(0, 16)], "salt must differ");
  assert.notDeepEqual([...first.slice(21, 86)], [...second.slice(21, 86)], "ephemeral key must differ");
});

test("oversized payloads and malformed device keys are refused", async () => {
  const device = await generateDevice();

  await assert.rejects(
    () => encryptPushPayload(device.subscription, "x".repeat(MAX_PAYLOAD_BYTES + 1)),
    /at most/,
  );
  await assert.rejects(
    () => encryptPushPayload({ ...device.subscription, auth: bytesToBase64Url(new Uint8Array(8)) }, "hi"),
    /16 bytes/,
  );
  await assert.rejects(
    () => encryptPushPayload({ ...device.subscription, p256dh: bytesToBase64Url(new Uint8Array(32)) }, "hi"),
    /65 bytes/,
  );
});

test("a push service reporting a gone endpoint is distinguished from a temporary failure", async () => {
  const keys = await generateVapidKeys();
  const device = await generateDevice();

  const send = (status: number) => sendPushNotification(device.subscription, "{}", keys, {
    fetchImpl: async () => new Response(null, { status }),
  });

  // Only `expired` may delete a stored subscription. Treating a 429 or a 503
  // that way would silently unsubscribe people whenever a push service wobbled.
  assert.equal((await send(201)).outcome, "sent");
  assert.equal((await send(404)).outcome, "expired");
  assert.equal((await send(410)).outcome, "expired");
  assert.equal((await send(429)).outcome, "failed");
  assert.equal((await send(503)).outcome, "failed");
});

test("a network failure is returned, never thrown, and carries no key material", async () => {
  const keys = await generateVapidKeys();
  const device = await generateDevice();

  const result = await sendPushNotification(device.subscription, "{}", keys, {
    fetchImpl: async () => { throw new TypeError(`connect ECONNREFUSED ${keys.privateKey}`); },
  });

  assert.equal(result.outcome, "failed");
  // One unreachable device must not abort the fan-out to the rest of the family,
  // and the reason reaches logs — so it carries the error's class name only.
  assert.equal(result.outcome === "failed" ? result.reason : "", "TypeError");
});

test("the request carries the VAPID header and the encrypted body", async () => {
  const keys = await generateVapidKeys();
  const device = await generateDevice();
  let seen: { url: string; init: RequestInit } | null = null;

  await sendPushNotification(device.subscription, JSON.stringify({ title: "hi" }), keys, {
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(null, { status: 201 });
    },
  });

  assert.ok(seen);
  const { url, init } = seen as unknown as { url: string; init: RequestInit };
  assert.equal(url, device.subscription.endpoint);
  const headers = init.headers as Record<string, string>;
  assert.match(headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(headers["Content-Encoding"], "aes128gcm");
  assert.equal(headers["Content-Type"], "application/octet-stream");
  assert.ok(init.body instanceof ArrayBuffer, "the body is raw encrypted bytes, not JSON");
});
