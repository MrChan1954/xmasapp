"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "../cx";
import { useFestive } from "./festive-context";

/**
 * Persistent, motionless marker that a recipient's gifts are done. Safe to
 * render at any time — it never animates, so reduced motion needs no special
 * case here.
 */
export function CompleteRibbon({ className = "", label = "All wrapped up" }: { className?: string; label?: string }) {
  return (
    <span
      className={cx(
        "pointer-events-none absolute -top-px -right-px z-10 flex items-center gap-1.5 rounded-tr-2xl rounded-bl-2xl bg-gold-fill px-3 py-1.5 text-[11px] font-semibold tracking-wide text-gold-fill-contrast",
        className,
      )}
    >
      {label}
    </span>
  );
}

const SPECKS = Array.from({ length: 14 }, (_, index) => {
  const angle = (index / 14) * Math.PI * 2;
  return {
    x: Math.round(Math.cos(angle) * 62),
    y: Math.round(Math.sin(angle) * 48),
    color: ["var(--gold-fill)", "var(--berry)", "var(--accent)"][index % 3],
    delay: (index % 5) * 25,
  };
});

/**
 * One-shot burst, fired only on the transition into completeness — pass a
 * `trigger` that changes at that moment. Keyed by `trigger` so a repeat replays
 * the animation, and it removes itself when the animation ends.
 *
 * Under reduced motion the specks are skipped entirely; the announcement still
 * fires, so the outcome is communicated either way.
 */
export function GiftCompleteBurst({ trigger, label }: { trigger: string | number | null; label?: string }) {
  const { reducedMotion } = useFestive();
  const [live, setLive] = useState(false);
  const previous = useRef<string | number | null>(null);

  useEffect(() => {
    if (trigger === null || trigger === previous.current) return;
    previous.current = trigger;
    setLive(true);
  }, [trigger]);

  if (!live) return null;

  return (
    <>
      <span role="status" className="sr-only">{label ?? "Gifts complete"}</span>
      {!reducedMotion && (
        <span key={trigger} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <span className="absolute top-1/2 left-1/2">
            {SPECKS.map((speck, index) => (
              <span
                key={index}
                className="burst-speck absolute block h-1.5 w-1.5 rounded-full"
                onAnimationEnd={index === 0 ? () => setLive(false) : undefined}
                style={{
                  background: speck.color,
                  animationDelay: `${speck.delay}ms`,
                  ["--burst-x" as string]: `${speck.x}px`,
                  ["--burst-y" as string]: `${speck.y}px`,
                }}
              />
            ))}
          </span>
        </span>
      )}
    </>
  );
}
