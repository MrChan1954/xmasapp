/**
 * Regenerates the app icons from the tree ornament that the app already uses as
 * its mark (`src/app/components/festive/ornaments.tsx`).
 *
 * Run with `pnpm run icons`. The PNGs it writes are committed, so neither the
 * production build nor Cloudflare ever needs sharp — this is an author-time
 * tool, which is why sharp is a devDependency.
 *
 * The ornament draws with `currentColor` and CSS variables. Those cannot exist
 * in a standalone file, so the palette below resolves them to the same literal
 * hexes `globals.css` defines. An icon is a single static asset shown on both
 * light and dark home screens, so it always uses the LIGHT palette: a cream
 * tile with a green tree reads correctly either way, whereas a transparent or
 * dark-tinted mark would disappear on one of them.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// From globals.css `:root` (light). Kept literal on purpose — see the note above.
const INK = "#0f6b4f"; // --accent
const GOLD = "#c99b2e"; // --gold-fill
const BERRY = "#a32e22"; // --berry
const GROUND = "#fbf8f3"; // --ground

/**
 * The `tree` ornament, verbatim from ornaments.tsx, on its native 48-unit grid.
 * `strokeWidth` is 1.6 rather than the component default of 1.3 because that is
 * what the rail and top bar actually render it at.
 */
/**
 * The drawing occupies y=2 (star apex) to roughly y=41.8 (base line plus half a
 * stroke), so its midpoint is ~21.9 rather than the canvas midpoint of 24. Left
 * alone it renders visibly top-heavy in a square tile. Nudging it down by the
 * 2.1-unit difference centres it optically. Horizontally it already spans
 * x=11..37, centred on 24, so only the vertical axis needs correcting.
 */
const TREE = `
<g transform="translate(0 2.1)">
  <g fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M24 11 15 24h18L24 11Z" />
    <path d="M24 19 11 34h26L24 19Z" />
    <path d="M21 34h6v7h-6z" />
    <path d="M17 41h14" />
  </g>
  <path fill="${GOLD}" d="m24 2 1.5 3.4 3.7.4-2.7 2.5.7 3.7L24 10.2l-3.2 1.8.7-3.7-2.7-2.5 3.7-.4L24 2Z" />
  <circle fill="${BERRY}" cx="19" cy="21.5" r="1.3" />
  <circle fill="${BERRY}" cx="28.5" cy="30" r="1.3" />
  <circle fill="${GOLD}" cx="24" cy="27" r="1.3" />
</g>
`;

/**
 * `scale` is the fraction of the canvas the artwork occupies.
 *
 * Maskable icons are cropped by the platform to a circle or squircle, and only
 * the middle 80% — a circle of radius 0.4 × size — is guaranteed to survive.
 *
 * The artwork's furthest points from its own centre are the ends of the base
 * line, at (±7, 19.9) on the 48 grid once recentred, giving a radius of ~21.1
 * against a half-width of 24 — 88%. So the largest safe scale is
 * 0.40 / (0.88 / 2) ≈ 0.90. Drawing at 0.8 keeps a 12% margin inside the safe
 * circle while still filling the tile; at the 0.6 this started from, the tree
 * used barely two-thirds of the room it had and read as lost in a field of
 * cream on Android launchers.
 *
 * Every icon is fully opaque. iOS does not honour transparency in a home-screen
 * icon — it composites the image onto black, which would swallow the dark green
 * strokes.
 */
function svg(size, scale) {
  const artwork = size * scale;
  const offset = (size - artwork) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${GROUND}" />
  <svg x="${offset}" y="${offset}" width="${artwork}" height="${artwork}" viewBox="0 0 48 48">${TREE}</svg>
</svg>`;
}

/**
 * `density` supersamples the vector before it is sampled down, which keeps the
 * star's points and the round stroke caps clean at small sizes. It must be
 * paired with an explicit `resize`: sharp treats the SVG's intrinsic pixel size
 * as 72 DPI, so a raised density silently multiplies the output (at 384 a
 * nominal 192px icon rasterises to 1024px).
 */
const png = (size, scale) =>
  sharp(Buffer.from(svg(size, scale)), { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

/**
 * The Android notification badge: the small glyph drawn into the status bar
 * alongside the app name.
 *
 * Android ignores every colour in this image and keeps only its alpha channel,
 * so the tile background and the green/gold/berry palette above are all wrong
 * here — a fully opaque square would come out as a solid blob. This draws the
 * tree as flat white on transparency instead, which is what the platform then
 * tints for the user's status bar. It is the one asset in this file that is
 * deliberately NOT opaque.
 */
function badgeSvg(size) {
  const artwork = size * 0.86;
  const offset = (size - artwork) / 2;
  const silhouette = `
  <g fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M24 11 15 24h18L24 11Z" />
    <path d="M24 19 11 34h26L24 19Z" />
    <path d="M21 34h6v7h-6z" />
    <path d="M17 41h14" />
  </g>
  <path fill="#ffffff" d="m24 2 1.5 3.4 3.7.4-2.7 2.5.7 3.7L24 10.2l-3.2 1.8.7-3.7-2.7-2.5 3.7-.4L24 2Z" />`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <svg x="${offset}" y="${offset}" width="${artwork}" height="${artwork}" viewBox="0 0 48 48"><g transform="translate(0 2.1)">${silhouette}</g></svg>
</svg>`;
}

const targets = [
  // Android / manifest.
  { file: "public/icons/icon-192.png", size: 192, scale: 0.78 },
  { file: "public/icons/icon-512.png", size: 512, scale: 0.78 },
  { file: "public/icons/maskable-192.png", size: 192, scale: 0.8 },
  { file: "public/icons/maskable-512.png", size: 512, scale: 0.8 },
  // Next file conventions: these produce the <link rel="icon"> and
  // <link rel="apple-touch-icon"> tags automatically.
  { file: "src/app/icon.png", size: 512, scale: 0.78 },
  { file: "src/app/apple-icon.png", size: 180, scale: 0.78 },
];

await mkdir(path.join(root, "public/icons"), { recursive: true });

for (const { file, size, scale } of targets) {
  await writeFile(path.join(root, file), await png(size, scale));
  console.log(`wrote ${file} (${size}x${size})`);
}

await writeFile(
  path.join(root, "public/icons/badge-96.png"),
  await sharp(Buffer.from(badgeSvg(96)), { density: 384 })
    .resize(96, 96)
    .png({ compressionLevel: 9 })
    .toBuffer(),
);
console.log("wrote public/icons/badge-96.png (96x96, transparent)");

/**
 * favicon.ico, replacing the create-next-app default. Hand-assembled because
 * sharp has no .ico encoder: an ICO is a small header plus, for each entry, a
 * complete PNG. 32px and 16px cover tab and bookmark rendering.
 */
const icoSizes = [32, 16];
const icoImages = await Promise.all(icoSizes.map((size) => png(size, 0.82)));

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
