import type { SVGProps } from "react";

export type OrnamentName = "tree" | "bauble" | "stocking" | "star" | "wreath" | "sleigh";

/**
 * Decorative line art for empty states and watermarks.
 *
 * Drawn on a 48-unit grid and stroked in `currentColor`, with a single accent
 * shape filled from `--gold-fill` (or `--berry`) so each ornament tints itself
 * per theme without a second copy.
 */
export function Ornament({
  name,
  size = 96,
  className,
  ...rest
}: { name: OrnamentName; size?: number; className?: string } & Omit<SVGProps<SVGSVGElement>, "name" | "className">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      {SHAPES[name]}
    </svg>
  );
}

const accent = { fill: "var(--gold-fill)", stroke: "none" } as const;
const berry = { fill: "var(--berry)", stroke: "none" } as const;

const SHAPES: Record<OrnamentName, React.ReactNode> = {
  tree: (
    <>
      <path d="M24 11 15 24h18L24 11Z" />
      <path d="M24 19 11 34h26L24 19Z" />
      <path d="M21 34h6v7h-6z" />
      <path d="M17 41h14" />
      <path
        {...accent}
        d="m24 2 1.5 3.4 3.7.4-2.7 2.5.7 3.7L24 10.2l-3.2 1.8.7-3.7-2.7-2.5 3.7-.4L24 2Z"
      />
      <circle {...berry} cx="19" cy="21.5" r="1.3" />
      <circle {...berry} cx="28.5" cy="30" r="1.3" />
      <circle {...accent} cx="24" cy="27" r="1.3" />
    </>
  ),
  bauble: (
    <>
      <path d="M24 5v6" />
      <path d="M20.5 11h7v4.5h-7z" />
      <circle cx="24" cy="30" r="14.5" />
      <path d="M10.5 24.5c8.5 4.5 18.5 4.5 27 0" />
      <path d="M10.5 35.5c8.5-4.5 18.5-4.5 27 0" />
      <path {...accent} d="M17.5 22.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Z" />
    </>
  ),
  stocking: (
    <>
      <path d="M13 6h21v8.5H13z" />
      <path d="M16 14.5v13.2c0 3.3-7.5 5.4-7.5 10.8 0 3.2 2.8 5.5 6.4 5.5h10.7c6.2 0 10.9-4.4 10.9-9.9 0-5-3.8-7.1-6.8-8.6V14.5" />
      <path d="M8.7 36.5h27.4" />
      <path {...berry} d="M31 8.6h1.6v3.3H31z" />
      <path {...accent} d="M14.6 8.6h1.6v3.3h-1.6z" />
    </>
  ),
  star: (
    <>
      <path d="m24 4 5.6 11.9L42 17.6l-9 9 2.2 12.9L24 33.4l-11.2 6.1L15 26.6l-9-9 12.4-1.7L24 4Z" />
      <path {...accent} d="m24 15.5 2.4 5.1 5.3.7-3.9 3.8.9 5.5-4.7-2.6-4.7 2.6.9-5.5-3.9-3.8 5.3-.7 2.4-5.1Z" />
    </>
  ),
  wreath: (
    <>
      <circle cx="24" cy="26" r="16" />
      <circle cx="24" cy="26" r="11" />
      <path d="M24 10c1.5 2.6 3.6 4 6.5 4.5M40 26c-2.6 1.5-4 3.6-4.5 6.5M24 42c-1.5-2.6-3.6-4-6.5-4.5M8 26c2.6-1.5 4-3.6 4.5-6.5" />
      <path d="M24 6.5c-3.4-3.8-9-1.8-7.6 2.2 1.1 3.1 5.4 2.8 7.6-2.2Zm0 0c3.4-3.8 9-1.8 7.6 2.2-1.1 3.1-5.4 2.8-7.6-2.2Z" />
      <circle {...berry} cx="31" cy="18.5" r="1.4" />
      <circle {...berry} cx="17.5" cy="32" r="1.4" />
      <circle {...accent} cx="32" cy="33" r="1.4" />
      <circle {...accent} cx="16.5" cy="19.5" r="1.4" />
    </>
  ),
  sleigh: (
    <>
      <path d="M11 17h15.5c6.6 0 11.5 4.6 11.5 10.6V33H17.5C13.9 33 11 30.2 11 26.7V17Z" />
      <path d="M7 39h31c2.8 0 4.5-1.6 4.5-3.6" />
      <path d="M7 39c-2.8 0-4.5-2.2-2.9-4.4" />
      <path d="M17 33v6M32 33v6" />
      <path {...accent} d="M19 8h9v7h-9z" />
      <path d="M23.5 8v7M19 11.5h9" />
    </>
  ),
};

/* --------------------------------------------------------------------------
 * Small festive glyphs. These stay hand-drawn — lucide has no equivalents that
 * sit alongside the rest of the set. Re-exported from `icons.tsx` so existing
 * call sites are unaffected.
 * ------------------------------------------------------------------------ */

type GlyphProps = { size?: number; strokeWidth?: number; className?: string };

function glyph({ size = 20, strokeWidth = 1.8, className }: GlyphProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

export function IconTree(props: GlyphProps) {
  return <svg {...glyph(props)}><path d="m12 3 4.5 6H14l4 5.5h-3l3.5 5H5.5L9 14.5H6L10 9H7.5L12 3Z" /><path d="M12 19.5V21" /></svg>;
}

export function IconBauble(props: GlyphProps) {
  return <svg {...glyph(props)}><circle cx="12" cy="13.5" r="6.5" /><path d="M10 4.5h4v2.5h-4z" /><path d="M6 11.5c1.8 1.4 4 2.1 6 2.1s4.2-.7 6-2.1" /></svg>;
}

export function IconStocking(props: GlyphProps) {
  return <svg {...glyph(props)}><path d="M7.5 3.5h7V10l3.2 4.4a4 4 0 1 1-6.4 4.7L7.5 13V3.5Z" /><path d="M7.5 7h7" /></svg>;
}

export function IconSnowflake(props: GlyphProps) {
  return <svg {...glyph(props)}><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" /><path d="M12 3 10 5m2-2 2 2M12 21l-2-2m2 2 2-2M4.2 7.5l2.7-.7m-2.7.7.7 2.7M19.8 16.5l-2.7.7m2.7-.7-.7-2.7M4.2 16.5l.7-2.7m-.7 2.7 2.7.7M19.8 7.5l-.7 2.7m.7-2.7-2.7-.7" /></svg>;
}
