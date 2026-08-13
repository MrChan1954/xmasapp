import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

const root = process.cwd();
const { default: manifest } = await import("../src/app/manifest.ts");

test("the manifest declares an installable app", () => {
  const value = manifest();

  assert.equal(value.start_url, "/");
  assert.equal(value.scope, "/");
  assert.equal(value.display, "standalone");
  assert.ok(value.name && value.short_name);
  assert.match(value.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(value.background_color, /^#[0-9a-f]{6}$/i);

  // Chromium will not offer installation without a 192 and a 512, and Android
  // adaptive launchers need a maskable icon or they letterbox the square one.
  const purposes = (purpose) => value.icons.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes);
  assert.deepEqual(purposes("any").sort(), ["192x192", "512x512"]);
  assert.deepEqual(purposes("maskable").sort(), ["192x192", "512x512"]);
});

test("every declared icon exists, is square at its declared size, and is opaque", async () => {
  for (const icon of manifest().icons) {
    const file = join(root, "public", icon.src);
    assert.ok(existsSync(file), `${icon.src} is declared but missing — run \`pnpm run icons\``);

    const [width, height] = icon.sizes.split("x").map(Number);
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.width, width, `${icon.src} width`);
    assert.equal(metadata.height, height, `${icon.src} height`);

    // iOS ignores transparency and composites onto black, which would swallow
    // the dark green strokes.
    assert.equal((await sharp(file).stats()).isOpaque, true, `${icon.src} must be opaque`);
  }
});

test("the service worker cannot cache anything but hashed build output", () => {
  const source = readFileSync(join(root, "public", "sw.js"), "utf8");

  // The only two things ever written to Cache Storage — the offline page and a
  // hashed asset. A third write would have to be added deliberately, and would
  // fail here.
  const written = [...source.matchAll(/cache\.put\(\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  assert.deepEqual(written.sort(), ["OFFLINE_URL", "request"]);
  assert.match(source, /url\.pathname\.startsWith\("\/_next\/static\/"\)/);

  // `cache.add` follows redirects and keeps the redirected flag on what it
  // stores, and a redirected response cannot legally be returned from
  // `respondWith` for a navigation — which is the only thing the offline page
  // is ever used for. Cloudflare's asset handler really does redirect
  // `/offline.html` to `/offline`, so this is not hypothetical: the fallback
  // has to be re-wrapped in a fresh Response, and `cache.add` must stay unused.
  assert.doesNotMatch(source, /cache\.add\(/);
  assert.match(source, /new Response\(await response\.blob\(\)/);

  // Everything that must never reach respondWith. Financial values only ever
  // arrive cross-origin from Supabase or from /api/, so these two guards are
  // what make stale balances impossible rather than merely unlikely.
  assert.match(source, /request\.method !== "GET"\) return;/);
  assert.match(source, /url\.origin !== self\.location\.origin\) return;/);
  assert.match(source, /startsWith\("\/api\/"\) \|\| url\.pathname\.startsWith\("\/auth\/"\)/);

  // Documents are network-only, which is what stops anyone being pinned to an
  // old deploy.
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /self\.skipWaiting\(\)/);
  assert.match(source, /self\.clients\.claim\(\)/);
});

/**
 * The regression this file exists to prevent from returning.
 *
 * Before the PWA work the root layout exported no `viewport` at all, so no
 * `<meta name="viewport">` was emitted. Android then lays the page out at its
 * 980px fallback width and scales the result down to the screen: every `sm:`
 * and `lg:` utility matches, the contributor grid goes multi-column, and the
 * whole thing reads as a shrunken desktop site on a 360px phone. It is silent —
 * nothing errors, the page just renders at the wrong width — and it is
 * invisible on a desktop browser, so only an assertion catches it.
 */
test("the root layout emits exactly one device-width viewport", () => {
  const layout = readFileSync(join(root, "src", "app", "layout.tsx"), "utf8");

  assert.match(layout, /export const viewport: Viewport = \{/);
  assert.match(layout, /width: "device-width"/);
  assert.match(layout, /initialScale: 1\b/);

  // A hand-written tag anywhere in the tree would be a second, conflicting
  // declaration — Next already emits one from the export above.
  assert.doesNotMatch(layout, /<meta\s+name="viewport"/);

  // Neither may be set: both stop a user pinch-zooming, which fails WCAG 1.4.4
  // and is the usual accidental cause of "the text is too small to read".
  assert.doesNotMatch(layout, /maximumScale/);
  assert.doesNotMatch(layout, /userScalable/);
});

test("the offline page carries its own viewport", () => {
  // It is a standalone document served straight from `public/`, so it gets
  // nothing from the root layout and needs the tag written out.
  const offline = readFileSync(join(root, "public", "offline.html"), "utf8");
  const tags = offline.match(/<meta\s+name="viewport"[^>]*>/g) ?? [];

  assert.equal(tags.length, 1);
  assert.match(tags[0], /width=device-width/);
  assert.match(tags[0], /initial-scale=1/);
});

test("the install prompt is captured at app start, not when the card mounts", () => {
  // Chromium fires `beforeinstallprompt` once, shortly after the first load. A
  // listener attached when the More page renders would always miss it, leaving
  // the Install button permanently invisible on Android.
  const hook = readFileSync(join(root, "src", "app", "components", "use-pwa-install.ts"), "utf8");
  const runtime = readFileSync(join(root, "src", "app", "components", "pwa-runtime.tsx"), "utf8");
  const layout = readFileSync(join(root, "src", "app", "layout.tsx"), "utf8");

  assert.match(hook, /export function watchInstallPrompt\(\)/);
  assert.match(runtime, /watchInstallPrompt\(\)/);
  assert.match(layout, /<PwaRuntime \/>/);
});
