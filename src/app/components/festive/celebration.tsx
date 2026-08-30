"use client";

import { cx } from "../cx";

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

/*
 * `GiftCompleteBurst` stood here until Q17: a one-shot speck animation for the
 * moment a recipient's gifts were finished. It was added in the redesign that
 * introduced `CompleteRibbon` above and was never rendered — `git log -S` finds
 * no commit that ever wrote `<GiftCompleteBurst`. Its `.burst-speck` rule and
 * `@keyframes burst` went from `globals.css` with it.
 *
 * The festive layer this file belongs to is otherwise live and deliberate:
 * `CompleteRibbon` is on every completed recipient card, and the snow, garland
 * and ornaments are event decoration, not leftovers.
 */
