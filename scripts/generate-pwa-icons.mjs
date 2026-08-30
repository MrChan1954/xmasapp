/**
 * Regenerates the app icons from the approved master artwork, `app-logo.png`.
 *
 * Run with `npm run icons`. The PNGs it writes are committed, so neither the
 * production build nor Cloudflare ever needs sharp — this is an author-time
 * tool, which is why sharp is a devDependency.
 *
 * WHAT REPLACED WHAT
 *   Every icon used to be drawn here, in code, from the `tree` ornament in
 *   `src/app/components/festive/ornaments.tsx` — a green Christmas tree on a
 *   cream tile. The app is not a Christmas app; it plans birthdays, Mother's
 *   Day and anything else a family buys for together, and the tree said
 *   otherwise on every home screen. The approved artwork is a rounded-square
 *   app tile: a mint gift box with a checklist on its front, on charcoal.
 *
 *   The artwork is NOT redrawn here and must not be. This file only crops,
 *   scales and re-encodes the master file, so what ships is what was approved.
 *   The Christmas tree is still the app's own glyph INSIDE the product — the
 *   ornaments, the garland, the snow on a Christmas event — and none of that
 *   is touched. Only the application's identity changed.
 *
 * THE MASTER FILE
 *   `app-logo.png` is 1254x1254 and presents the tile the way a store listing
 *   would: the rounded square occupies the middle ~72%, on a near-black canvas,
 *   with a soft drop shadow. That outer canvas is redundant for an app icon, so
 *   TILE below is the measured bounding box of the tile itself. It was measured
 *   from the pixels rather than eyeballed: the tile face is ~3x the luminance
 *   of the surround, and the box is the same to within a pixel on both axes.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = path.join(root, "app-logo.png");

/**
 * The rounded-square tile inside the master file, measured from the pixels.
 * Cropping to this is the one permitted alteration: it removes redundant outer
 * canvas so the approved icon fills the asset, and changes nothing inside it.
 */
const TILE = { left: 175, top: 158, width: 903, height: 903 };

/** The tile, edge to edge — what an ordinary app icon should be. */
const tile = () => sharp(MASTER).extract(TILE);

/**
 * A square icon at `size`, drawn from the cropped tile.
 *
 * Flattened onto the artwork's own charcoal rather than left with an alpha
 * channel: iOS does not honour transparency in a home-screen icon, it
 * composites onto black, and `scripts/pwa-assets.test.mjs` requires every
 * declared icon to be opaque. The source has no alpha anyway; this makes that
 * a guarantee rather than a coincidence.
 *
 * PALETTE ENCODING IS RE-ENCODING, NOT REDRAWING. The master is a rendered
 * image with soft gradients, so a truecolour 512 lands at ~340KB against the
 * ~9KB the old flat vector tree cost, and every one of these is uploaded to
 * Cloudflare on every deploy. Quantising costs 66% of the bytes for a mean
 * per-pixel channel difference of 1.1/255 — measured, and invisible at any size
 * an icon is ever shown. The ICO images below opt out: their directory entry
 * declares 32bpp and some parsers take that literally.
 */
const icon = (size, { palette = true, rgba = false } = {}) => {
  const pipeline = tile().resize(size, size, { fit: "fill" }).flatten({ background: "#1d2422" });
  // `flatten` drops the alpha channel, which is right for a PNG on disk and
  // wrong inside an ICO: Next's icon decoder rejects an embedded PNG that is
  // not RGBA outright ("The PNG is not in RGBA format!") and the build fails.
  // `ensureAlpha` puts a fully opaque channel back without changing a pixel.
  return (rgba ? pipeline.ensureAlpha() : pipeline)
    .png({ compressionLevel: 9, ...(palette ? { palette: true, quality: 100, effort: 10 } : {}) })
    .toBuffer();
};

/**
 * A MASKABLE icon is cropped by the platform to a circle or squircle, and only
 * the middle 80% — a circle of radius 0.4 x size — is guaranteed to survive.
 *
 * So these are made from the UNCROPPED master, which is already exactly that
 * drawing: the tile inset on its own canvas. Measured on the master, the
 * furthest green pixel sits at 65% of the half-width from centre, comfortably
 * inside the 80% safe circle, while the tile's straight edges reach 72% and its
 * corners fall outside — so what a circular mask trims is the tile's own
 * rounded corner and never the gift.
 *
 * Cropping to the tile and padding it back would have produced the same picture
 * with an extra resample, and inventing a new background would have altered
 * approved artwork.
 */
const maskable = (size) =>
  sharp(MASTER)
    .resize(size, size, { fit: "fill" })
    .flatten({ background: "#0d1211" })
    .png({ compressionLevel: 9, palette: true, quality: 100, effort: 10 })
    .toBuffer();

/**
 * The Android notification badge: the small glyph drawn into the status bar
 * beside the app name.
 *
 * Android throws away every colour in this image and keeps only its ALPHA, then
 * tints the result. The master is fully opaque, so handing it over unchanged
 * would badge as a solid square. This lifts the silhouette out of the artwork
 * instead — every pixel that is unmistakably the mint green rather than the
 * charcoal tile becomes opaque white, everything else transparent.
 *
 * That is still the approved artwork: nothing is redrawn, only separated from
 * its background. It is the one asset here that is deliberately NOT opaque.
 */
async function badge(size) {
  const { data, info } = await tile().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // White everywhere; alpha carries the shape.
  const mask = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; p < width * height; p += 1, i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // The mint reads as strongly green and bright; the tile, its shadow and the
    // surround are all near-neutral and dark. A generous margin either side of
    // that boundary keeps the anti-aliased edges from fraying.
    const isArtwork = g > 90 && g - r > 40 && g - b > 25;
    const out = p * 4;
    mask[out] = 255;
    mask[out + 1] = 255;
    mask[out + 2] = 255;
    mask[out + 3] = isArtwork ? 255 : 0;
  }

  // A little breathing room: Android draws the badge small and clips tight.
  const artwork = Math.round(size * 0.92);
  const pad = Math.round((size - artwork) / 2);
  return sharp(mask, { raw: { width, height, channels: 4 } })
    .resize(artwork, artwork, { fit: "fill" })
    .extend({ top: pad, bottom: size - artwork - pad, left: pad, right: size - artwork - pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * WHY THE MANIFEST ICONS CARRY `-v2` AND THE OTHERS DO NOT.
 *
 * `public/_headers` gives `/icons/*` a day of caching precisely because those
 * paths are not content-hashed — but an installed PWA is worse than an HTTP
 * cache: Android copies the launcher icon at install time and may keep it until
 * the manifest names a different URL. A new filename is what actually moves it,
 * and it costs nothing.
 *
 * `src/app/icon.png`, `apple-icon.png` and `favicon.ico` keep their names
 * because Next already busts them itself — the emitted tags are
 * `/icon.png?icon.<hash>.png`, and the hash is derived from the file, so
 * replacing the bytes changes the URL with no help from here.
 */
const targets = [
  // Android / manifest.
  { file: "public/icons/icon-192-v2.png", make: () => icon(192) },
  { file: "public/icons/icon-512-v2.png", make: () => icon(512) },
  { file: "public/icons/maskable-192-v2.png", make: () => maskable(192) },
  { file: "public/icons/maskable-512-v2.png", make: () => maskable(512) },
  { file: "public/icons/badge-96-v2.png", make: () => badge(96) },
  // Next file conventions: these produce the <link rel="icon"> and
  // <link rel="apple-touch-icon"> tags automatically.
  { file: "src/app/icon.png", make: () => icon(512) },
  { file: "src/app/apple-icon.png", make: () => icon(180) },
];

await mkdir(path.join(root, "public/icons"), { recursive: true });

for (const { file, make } of targets) {
  await writeFile(path.join(root, file), await make());
  console.log(`wrote ${file}`);
}

/**
 * favicon.ico, hand-assembled because sharp has no .ico encoder: an ICO is a
 * small header plus, for each entry, a complete PNG. 32px and 16px cover tab
 * and bookmark rendering.
 */
const icoSizes = [32, 16];
const icoImages = await Promise.all(icoSizes.map((size) => icon(size, { palette: false, rgba: true })));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type 1 = icon
header.writeUInt16LE(icoImages.length, 4);

let dataOffset = 6 + icoImages.length * 16;
const entries = icoImages.map((image, index) => {
  const entry = Buffer.alloc(16);
  entry[0] = icoSizes[index]; // width  (0 would mean 256)
  entry[1] = icoSizes[index]; // height
  entry[2] = 0; // palette colours
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(dataOffset, 12);
  dataOffset += image.length;
  return entry;
});

await writeFile(
  path.join(root, "src/app/favicon.ico"),
  Buffer.concat([header, ...entries, ...icoImages]),
);
console.log(`wrote src/app/favicon.ico (${icoSizes.join(", ")})`);
