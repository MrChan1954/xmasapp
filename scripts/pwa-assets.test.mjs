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

/**
 * ===========================================================================
 * THE APP'S OWN ICON, AFTER THE CHRISTMAS TREE
 * ===========================================================================
 *
 * Every icon used to be drawn in `scripts/generate-pwa-icons.mjs` from the
 * `tree` ornament: a green Christmas tree on a cream tile. The application is
 * not a Christmas application -- it plans birthdays, Mother's Day and anything
 * else a family buys for together -- and the tree said otherwise on every home
 * screen, every browser tab and every push notification. The approved artwork
 * is `app-logo.png`, a rounded-square tile carrying a gift box with a checklist
 * on its front.
 *
 * The tree itself is NOT gone from the product, and must not be: it is still
 * the glyph for a Christmas event, in the ornaments, the garland and the snow.
 * What changed is the application's identity, which is a different thing.
 *
 * What these check is the part that cannot be seen by looking at the app in a
 * browser on a desktop:
 *
 *   1. nothing still points at an icon file that no longer exists;
 *   2. the maskable icons keep the artwork inside the circle Android will crop
 *      them to -- invisible until somebody installs it on a phone;
 *   3. the notification badge is a SILHOUETTE and not a solid block, because
 *      Android discards its colours and keeps only the alpha.
 */

const RETIRED_ICONS = [
  "icon-192.png", "icon-512.png", "maskable-192.png", "maskable-512.png", "badge-96.png",
];

test("the master artwork is committed, square, and is what the icons come from", async () => {
  const master = join(root, "app-logo.png");
  assert.ok(existsSync(master), "app-logo.png is the source of every icon and must be committed");

  const metadata = await sharp(master).metadata();
  assert.equal(metadata.width, metadata.height, "the master is a square app tile");

  const generator = readFileSync(join(root, "scripts", "generate-pwa-icons.mjs"), "utf8");
  assert.match(generator, /app-logo\.png/u, "the generator must read the approved artwork");
  // The tree was drawn in code. If that ever comes back, so has the old brand.
  assert.doesNotMatch(generator, /const TREE =/u, "the icons are no longer drawn from the tree ornament");
});

test("NOTHING STILL POINTS AT A RETIRED ICON", () => {
  const sources = [
    join(root, "src", "app", "manifest.ts"),
    join(root, "public", "sw.js"),
  ];
  for (const file of sources) {
    const source = readFileSync(file, "utf8");
    for (const retired of RETIRED_ICONS) {
      // `icon-192-v2.png` must not match `icon-192.png`, hence the boundary.
      const pattern = new RegExp(retired.replace(".", "\.") + "(?![\w-])", "u");
      assert.doesNotMatch(source, pattern, `${file} still names the retired ${retired}`);
    }
  }

  // And the retired files are actually gone, so a stale reference cannot
  // silently keep working against a leftover on disk.
  for (const retired of RETIRED_ICONS) {
    assert.ok(!existsSync(join(root, "public", "icons", retired)),
      `public/icons/${retired} is unused and should not still be committed`);
  }
});

test("everything the app asks for by name is actually on disk", async () => {
  const declared = manifest().icons.map((icon) => icon.src);
  const worker = readFileSync(join(root, "public", "sw.js"), "utf8");
  const fromWorker = [...worker.matchAll(/"(\/icons\/[\w.-]+\.png)"/gu)].map((m) => m[1]);

  assert.ok(fromWorker.length >= 2, "the worker still names an icon and a badge");

  for (const src of [...declared, ...fromWorker]) {
    assert.ok(existsSync(join(root, "public", src)), `${src} is referenced but missing`);
  }
});

/**
 * A maskable icon is cropped by the platform to a circle or squircle, and only
 * the middle 80% -- a circle of radius 0.4 x size -- is guaranteed to survive.
 * The `any` icons are deliberately NOT held to this: they are shown as drawn,
 * and the tile is meant to reach their edges.
 */
test("the maskable icons keep the artwork inside the safe circle", async () => {
  const maskables = manifest().icons.filter((icon) => icon.purpose === "maskable");
  assert.ok(maskables.length > 0, "there are maskable icons to check");

  for (const icon of maskables) {
    const { data, info } = await sharp(join(root, "public", icon.src))
      .raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    let furthest = 0;
    let artworkPixels = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * channels;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // The mint artwork against a near-neutral, dark tile.
        if (g > 90 && g - r > 40 && g - b > 25) {
          artworkPixels += 1;
          const distance = Math.hypot(x - width / 2, y - height / 2);
          if (distance > furthest) furthest = distance;
        }
      }
    }

    assert.ok(artworkPixels > 0, `${icon.src} has no artwork in it at all`);
    const reach = furthest / (width / 2);
    assert.ok(reach <= 0.8,
      `${icon.src} puts artwork at ${(reach * 100).toFixed(1)}% of the half-width; Android may crop past 80%`);
  }
});

test("the notification badge is a silhouette, not a block", async () => {
  const badge = join(root, "public", "icons", "badge-96-v2.png");
  assert.ok(existsSync(badge), "the badge asset exists");

  const metadata = await sharp(badge).metadata();
  assert.ok(metadata.hasAlpha, "Android keeps only the alpha channel, so there must be one");

  const { data, info } = await sharp(badge).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0;
  const total = info.width * info.height;
  for (let p = 0; p < total; p += 1) if (data[p * 4 + 3] > 128) opaque += 1;

  const coverage = opaque / total;
  // A fully opaque image badges as a filled square, which is the failure this
  // catches; an empty one would badge as nothing at all.
  assert.ok(coverage > 0.05, `the badge is nearly empty (${(coverage * 100).toFixed(1)}% opaque)`);
  assert.ok(coverage < 0.6, `the badge is a solid block (${(coverage * 100).toFixed(1)}% opaque)`);
});
