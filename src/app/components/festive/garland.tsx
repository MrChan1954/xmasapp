import type { CSSProperties } from "react";
import { cx } from "../cx";

type GarlandVariant = "hairline" | "lights" | "swag";

/**
 * The divider that carries the festive tone.
 *
 * `hairline` is the workhorse — a gold rule that fades at both ends. `lights`
 * hangs a string of baubles from a slack wire, `swag` adds a faint warm band
 * of light behind it.
 *
 * Only the wire is drawn in SVG, because the wire is the one part that *should*
 * stretch with the container. The baubles are real elements positioned in
 * percentages off the same curve, so they stay circular at any width (a
 * `preserveAspectRatio="none"` circle turns into an ellipse on a wide screen)
 * and can carry a gradient, a cap and a glow that SVG fills can't.
 */
export function GarlandRule({
  variant = "hairline",
  className = "",
}: {
  variant?: GarlandVariant;
  className?: string;
}) {
  if (variant === "hairline") {
    return <span aria-hidden className={cx("garland-hairline block h-px w-full shrink-0", className)} />;
  }

  return (
    <span
      aria-hidden
      className={cx("garland-lights relative block w-full shrink-0", variant === "swag" && "garland-swag", className)}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
        <path
          d={WIRE_PATH}
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth={1}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {PINS.map((pin) => (
        <span key={`pin-${pin.x}`} className="garland-pin" style={{ left: `${pin.x}%`, top: `${pin.y}%` }} />
      ))}

      {BULBS.map((bulb) => (
        <span
          key={`bulb-${bulb.x}`}
          className={cx("garland-bulb", `garland-bulb-${bulb.tone}`)}
          style={{
            left: `${bulb.x}%`,
            top: `${bulb.y}%`,
            "--bulb-scale": bulb.scale,
            // Custom property, not animation-delay: the twinkle lives on the
            // ::after halo, which would not inherit the shorthand.
            "--bulb-delay": bulb.delay,
          } as CSSProperties}
        />
      ))}
    </span>
  );
}

/*
 * Geometry, in percentages of the band so the curve keeps its proportions at
 * every width. Three swags read as "hung on purpose" where one long sag reads
 * as a drooping line; the sine is the honest catenary shape at this shallow a
 * drop, and sampling it means the baubles sit exactly on the wire rather than
 * near it.
 */
const SWAGS = 3;
const ANCHOR_Y = 15; // where the wire is pinned up
const SAG = 45; // extra drop at the belly of each swag
const SAMPLES = 90;

function wireY(x: number) {
  const t = (x / 100) * SWAGS;
  return ANCHOR_Y + SAG * Math.sin(Math.PI * (t - Math.floor(t)));
}

const WIRE_PATH = Array.from({ length: SAMPLES + 1 }, (_, i) => {
  const x = (i / SAMPLES) * 100;
  return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${wireY(x).toFixed(2)}`;
}).join(" ");

// Rotating so no two neighbours share a colour and each tone gets even weight.
const TONES = ["gold", "berry", "warm", "green"] as const;
// Held close to 1 — this is glassblowing variance, not a size gradient.
const SCALES = [1, 0.88, 1.06, 0.94, 1.02];
const PER_SWAG = 5;

const BULBS = Array.from({ length: SWAGS * PER_SWAG }, (_, i) => {
  const swag = Math.floor(i / PER_SWAG);
  const step = i % PER_SWAG;
  // Inset from the anchors, evenly spaced along the swag.
  const x = ((swag + (step + 1) / (PER_SWAG + 1)) / SWAGS) * 100;
  return {
    x,
    y: wireY(x),
    tone: TONES[i % TONES.length],
    scale: SCALES[(i + swag) % SCALES.length],
    // Spread over the cycle so the string never pulses in unison.
    delay: `-${((i * 2.3) % 7).toFixed(2)}s`,
  };
});

// Interior anchors only; the outer two sit on the edge and would be half cut.
const PINS = Array.from({ length: SWAGS - 1 }, (_, i) => ({
  x: ((i + 1) / SWAGS) * 100,
  y: ANCHOR_Y,
}));
