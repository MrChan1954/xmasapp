/**
 * The Web Push protocol: VAPID (RFC 8292) plus aes128gcm payload encryption
 * (RFC 8291), written against WebCrypto and `fetch` only.
 *
 * The obvious alternative is the `web-push` npm package, which cannot be used
 * here: it is built on Node's `crypto` and `https` modules, and this app is
 * deployed to Cloudflare Workers through OpenNext. WebCrypto and `fetch` are
 * the intersection of what Workers, Node and the Edge runtime all provide, so
 * everything below sticks to them. That also keeps the dependency count at
 * zero for the one part of the app that handles a private key.
 *
 * This module is pure protocol. It never touches the database, never decides
 * who should be notified, and never reads an environment variable — the caller
 * passes keys in. That is what makes it testable without a Supabase project.
 */

/** The three values a browser hands over from `PushSubscription.toJSON()`. */
export type PushSubscriptionKeys = {
  endpoint: string;
  /** Base64url of the device's uncompressed P-256 public key (65 bytes). */
  p256dh: string;
  /** Base64url of the device's 16-byte auth secret. */
  auth: string;
};

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or `https:` contact, required by RFC 8292 §2.1. */
  subject: string;
};

export type PushSendResult =
  | { outcome: "sent"; status: number }
  /** The push service says this endpoint is permanently gone. Delete the row. */
  | { outcome: "expired"; status: number }
  /** Temporary: rate limited, service down, network error. Keep the row. */
  | { outcome: "failed"; status: number; reason: string };

/**
 * One AES-GCM record. The payloads this app sends are a few hundred bytes, so
 * a single record always suffices; 4096 is the conventional value and every
 * push service accepts it.
 */
const RECORD_SIZE = 4096;

/**
 * The largest plaintext that fits one record after the padding delimiter and
 * the 16-byte GCM tag. Notification bodies are short by design, but a caller
 * assembling one from names should get a clear error rather than a 413 from a
 * push service.
 */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 17;

/** Twelve hours. RFC 8292 caps VAPID token lifetime at 24. */
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

/** How long a push service should hold an undelivered message: one day. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Reject malformed VAPID keys at configuration time rather than letting a push
 * service reject every send with an opaque 401. Deliberately reports only the
 * shape that is wrong — never any part of a key value.
 */
export function assertValidVapidKeys(keys: VapidKeys): void {
  const publicKey = base64UrlToBytes(keys.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point.");
  }
  if (base64UrlToBytes(keys.privateKey).length !== 32) {
    throw new Error("VAPID private key must be 32 bytes.");
  }
  if (!/^(mailto:|https:\/\/)/.test(keys.subject)) {
    throw new Error("VAPID subject must be a mailto: or https:// URL.");
  }
}

/**
 * WebCrypto cannot import a raw EC private scalar, so the 32-byte `d` is
 * recombined with the x and y halves of the public point into a JWK. This is
 * why both keys are required to sign: the public key is not merely advertised
 * alongside the token, it is structurally part of importing the private one.
 */
async function importVapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const publicKey = base64UrlToBytes(keys.publicKey);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64Url(publicKey.slice(1, 33)),
      y: bytesToBase64Url(publicKey.slice(33, 65)),
      d: keys.privateKey.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * A signed VAPID token for one push service origin.
 *
 * The audience is the push service's origin and nothing more — deliberately not
 * the full endpoint, which contains the device-identifying path and must not be
 * copied into a token that the service operator reads.
 */
export async function createVapidToken(
  endpoint: string,
  keys: VapidKeys,
  nowSeconds: number,
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = bytesToBase64Url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToBase64Url(
    utf8(JSON.stringify({
      aud: audience,
      exp: Math.floor(nowSeconds) + VAPID_TOKEN_LIFETIME_SECONDS,
      sub: keys.subject,
    })),
  );

  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await importVapidSigningKey(keys),
    toArrayBuffer(utf8(signingInput)),
  );

  // WebCrypto emits the raw r||s pair ES256 wants, not the DER wrapping that
  // Node's sign() produces, so no re-encoding step is needed here.
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/**
 * Encrypt one payload for one device, per RFC 8291.
 *
 * `salt` and `ephemeralKeyPair` are parameters purely so tests can pin them and
 * check the envelope byte-for-byte; production always takes the defaults, which
 * generate fresh random values for every single message. Reusing either across
 * two messages to the same device would be a real cryptographic failure, so
 * they are generated here rather than hoisted anywhere a caller could cache.
 */
export async function encryptPushPayload(
  subscription: PushSubscriptionKeys,
  payload: string,
  options: { salt?: Uint8Array; ephemeralKeyPair?: CryptoKeyPair } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = utf8(payload);
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Push payload must be at most ${MAX_PAYLOAD_BYTES} bytes.`);
  }

  const devicePublicKeyBytes = base64UrlToBytes(subscription.p256dh);
  const authSecret = base64UrlToBytes(subscription.auth);
  if (devicePublicKeyBytes.length !== 65) throw new Error("Subscription p256dh key must be 65 bytes.");
  if (authSecret.length !== 16) throw new Error("Subscription auth secret must be 16 bytes.");

  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("Push salt must be 16 bytes.");

  const ephemeral = options.ephemeralKeyPair ?? (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ));
  const ephemeralPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey),
  );

  const devicePublicKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(devicePublicKeyBytes),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: devicePublicKey },
    ephemeral.privateKey,
    256,
  );

  // First HKDF: mix the ECDH secret with the device's auth secret, binding the
  // result to both public keys so a message cannot be replayed at another
  // device. `deriveBits` performs extract-then-expand in one step, with the
  // auth secret acting as the HKDF salt.
  const keyInfo = concat(
    utf8("WebPush: info\0"),
    devicePublicKeyBytes,
    ephemeralPublicKeyBytes,
  );
  const inputKeyMaterial = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(authSecret), info: toArrayBuffer(keyInfo) },
    await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]),
    256,
  ));

  // Second HKDF: the per-message content key and nonce, separated by their
  // RFC 8188 labels and salted with the random value carried in the header.
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(inputKeyMaterial),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const contentKeyBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(utf8("Content-Encoding: aes128gcm\0")),
    },
    hkdfKey,
    128,
  );
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(utf8("Content-Encoding: nonce\0")),
    },
    hkdfKey,
    96,
  ));

  const contentKey = await crypto.subtle.importKey("raw", contentKeyBits, "AES-GCM", false, ["encrypt"]);
  // 0x02 is the RFC 8188 delimiter for the last record. There is only ever one
  // record here, so it is always the last.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    contentKey,
    toArrayBuffer(concat(plaintext, Uint8Array.from([0x02]))),
  ));

  // aes128gcm header: salt(16) | record size(4, big endian) | key id length(1) |
  // key id, which for Web Push is the sender's ephemeral public key.
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = ephemeralPublicKeyBytes.length;

  return concat(header, ephemeralPublicKeyBytes, ciphertext);
}

/**
 * Deliver one notification to one device.
 *
 * Never throws: a single unreachable device must not abort a fan-out to the
 * rest of the family, so every failure comes back as a value the caller can
 * act on. `expired` is the only outcome that should ever delete a stored
 * subscription — a 429 or a 503 means try again later, not forget this device.
 */
export async function sendPushNotification(
  subscription: PushSubscriptionKeys,
  payload: string,
  keys: VapidKeys,
  options: { ttlSeconds?: number; nowSeconds?: number; fetchImpl?: typeof fetch } = {},
): Promise<PushSendResult> {
  const request = options.fetchImpl ?? fetch;
  try {
    const [body, token] = await Promise.all([
      encryptPushPayload(subscription, payload),
      createVapidToken(subscription.endpoint, keys, options.nowSeconds ?? Date.now() / 1000),
    ]);

    const response = await request(subscription.endpoint, {
      method: "POST",
      headers: {
        // RFC 8292 §3.1. The public key travels in the header, never the body.
        Authorization: `vapid t=${token}, k=${keys.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
        // Christmas admin, not an alarm: let a dozing phone batch these.
        Urgency: "normal",
      },
      body: toArrayBuffer(body),
    });

    if (response.status === 404 || response.status === 410) {
      return { outcome: "expired", status: response.status };
    }
    if (response.ok) return { outcome: "sent", status: response.status };
    return { outcome: "failed", status: response.status, reason: `push service returned ${response.status}` };
  } catch (error) {
    // The message is kept generic on purpose: this string reaches logs, and an
    // exception thrown out of the crypto path could otherwise carry key
    // material or the full endpoint into them.
    return {
      outcome: "failed",
      status: 0,
      reason: error instanceof Error ? error.name : "unknown error",
    };
  }
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  // Copied into a plain ArrayBuffer view: TextEncoder is typed over
  // ArrayBufferLike, which WebCrypto will not accept.
  const encoded = new TextEncoder().encode(value);
  const bytes = new Uint8Array(encoded.length);
  bytes.set(encoded);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * WebCrypto and `fetch` want an ArrayBuffer. A Uint8Array view may sit at an
 * offset inside a larger buffer, so handing over `.buffer` directly can silently
 * pass the wrong bytes; slice to exactly the view's own range.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
