"use client";

import { useIsIosSafari, usePwaInstall } from "./use-pwa-install";

/**
 * Optional install help for the More page, built from the same card markup as
 * the Appearance section next to it.
 *
 * Renders nothing at all once the app is installed, and nothing on a browser
 * that can neither prompt nor be given useful manual instructions — so it never
 * becomes a permanent nag on desktop.
 *
 * It renders its own section heading (matching the `Group` helper on the More
 * page) rather than being wrapped in one, so that when there is nothing to say
 * the heading disappears too instead of leaving an empty "App" label behind.
 */
export function InstallCard() {
  const { installed, canPrompt, promptInstall } = usePwaInstall();
  const isIosSafari = useIsIosSafari();

  if (installed) return null;
  if (!canPrompt && !isIosSafari) return null;

  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold tracking-eyebrow text-gold uppercase">App</h2>
      <div className="mt-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold">Install the app</h3>
          <p className="mt-1 text-sm leading-6 text-ink-600">
            {isIosSafari
              ? "Tap Share, then Add to Home Screen, to open Family Gift Planner like an app."
              : "Add Family Gift Planner to your device for a full-screen app window."}
          </p>
        </div>
        {canPrompt && (
          <button
            type="button"
            onClick={() => void promptInstall()}
            className="shrink-0 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-contrast shadow-card transition hover:brightness-110 active:scale-95"
          >
            Install
          </button>
        )}
        </div>
      </div>
    </section>
  );
}
