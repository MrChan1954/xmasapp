import type { ReactNode } from "react";
import { Ornament } from "./festive/ornaments";
import { GarlandRule } from "./festive/garland";
import { IconSparkle } from "./icons";

/**
 * Shared frame for the signed-out pages (login, password flows, account setup)
 * so the public entrance matches the app's identity.
 *
 * Light is a plain warm-paper ground with a large faint ornament watermark;
 * dark keeps the evergreen gradient. This is one of the few places where the
 * two themes genuinely want different structure rather than different values,
 * which is why it uses `dark:` rather than tokens alone.
 */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ground px-5 py-10 text-ink-900 dark:bg-linear-to-b dark:from-pine-950 dark:via-pine-900 dark:to-pine-800">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage: "radial-gradient(color-mix(in srgb, var(--ink-900) 10%, transparent) 1px, transparent 1.5px)",
          backgroundSize: "26px 26px",
        }}
      />
      {/*
        Opacity on the element, not on the stroke colour: the ornament's accent
        shapes are filled from --gold-fill / --berry, so a translucent
        currentColor would fade the outline and leave the baubles at full
        strength.
      */}
      <Ornament
        name="tree"
        size={520}
        aria-hidden
        className="pointer-events-none absolute -right-24 -bottom-32 text-ink-900 opacity-[0.05] dark:text-white dark:opacity-[0.06]"
      />
      <div className="relative w-full max-w-md">
        <div className="flex items-center justify-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gold-fill text-gold-fill-contrast shadow-card" aria-hidden>
            <IconSparkle size={22} strokeWidth={1.6} />
          </span>
          <span className="font-display text-xl font-semibold text-ink-900 dark:text-white">Family Gift Planner</span>
        </div>
        <section className="mt-6 overflow-hidden rounded-3xl border border-line bg-surface shadow-modal dark:border-transparent dark:bg-surface-2">
          <GarlandRule variant="lights" />
          <div className="px-7 pt-5 pb-7 sm:px-9 sm:pb-9">{children}</div>
        </section>
        <p aria-hidden className="mt-6 text-center text-[11px] font-medium tracking-[0.35em] text-ink-400">✦ ✦ ✦</p>
      </div>
    </main>
  );
}

export function AuthHeading({ eyebrow, title, description }: { eyebrow?: string; title: string; description?: string }) {
  return (
    <div>
      {eyebrow && <p className="text-xs font-semibold tracking-eyebrow text-gold uppercase">{eyebrow}</p>}
      <h1 className={`font-display text-3xl font-semibold text-ink-900 ${eyebrow ? "mt-2" : ""}`}>{title}</h1>
      {description && <p className="mt-3 text-sm leading-6 text-ink-600">{description}</p>}
    </div>
  );
}
