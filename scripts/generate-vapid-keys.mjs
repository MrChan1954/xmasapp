/**
 * Generates one VAPID key pair for Web Push.
 *
 * Run with `pnpm run vapid`. Prints to the terminal and writes nothing: the
 * private key must never land in the repository, a log file, or a `.env` that
 * could be committed. Paste the two values straight into the deployment's
 * secrets.
 *
 * No dependency needed — this is Node's own WebCrypto, the same P-256 curve
 * `src/lib/web-push.ts` signs with. Running it again produces a different pair
 * and invalidates every existing subscription, so only rotate deliberately:
 * every device would have to be re-enabled afterwards.
 */
import { webcrypto } from "node:crypto";

const toBase64Url = (buffer) =>
  Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

// 65 raw bytes, 0x04 followed by x and y. This is the form PushManager.subscribe
// expects as its applicationServerKey.
const publicKey = toBase64Url(await webcrypto.subtle.exportKey("raw", pair.publicKey));
// Only the 32-byte private scalar `d` is kept; the rest of the JWK is
// recoverable from the public key at import time.
const { d } = await webcrypto.subtle.exportKey("jwk", pair.privateKey);

console.log("");
console.log("Set these on the server (Cloudflare secrets). Do not commit them.");
console.log("");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${d}`);
console.log("VAPID_SUBJECT=mailto:you@example.com   <- change to a real contact address");
console.log("");
