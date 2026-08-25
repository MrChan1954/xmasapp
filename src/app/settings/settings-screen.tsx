"use client";

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { scopeReminder, settingsFor } from "@/lib/settings-scopes.ts";
import { AppShell, PageHeader } from "../components/app-shell";
import { useFestive } from "../components/festive/festive-context";
import { IconBell, IconSettings, IconUser } from "../components/icons";
import { InstallCard } from "../components/install-card";
import { SettingsGroup, SettingsRow } from "../components/settings-list";
import { cx } from "../components/ui";

const ICONS: Record<string, React.ReactNode> = {
  account: <IconUser size={20} />,
  notifications: <IconBell size={20} />,
  appearance: <IconSettings size={20} />,
};

/**
 * YOUR settings: the ones that follow you into every family.
 *
 * Nothing on this screen is about a family, which is exactly why it is a screen
 * of its own. Somebody who belongs to two should never have to wonder whether
 * turning notifications off here turned them off in both -- the answer is on
 * the page, in the first line under the title.
 */
export function GlobalSettingsScreen({ areaName }: { areaName: string }) {
  const { snow, setSnow, reducedMotion } = useFestive();
  const entries = settingsFor("global", { isAdmin: false }).filter((entry) => entry.key !== "appearance");

  return (
    <AppShell width="narrow">
      <PageHeader eyebrow="Settings" title="Your settings" description={scopeReminder("global", areaName)} />

      <InstallCard />

      <SettingsGroup label="Your account">
        {entries.map((entry) => (
          <SettingsRow
            key={entry.key}
            href={entry.href}
            title={entry.title}
            description={entry.description}
            icon={ICONS[entry.key] ?? <IconSettings size={20} />}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup label="Appearance">
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
              <h3 className="font-display text-lg font-semibold">Falling snow</h3>
              <p className="mt-1 text-sm leading-6 text-ink-600">
                {reducedMotion
                  ? "Off while your device asks for reduced motion."
                  : "Decorative snow on the dashboard."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={snow && !reducedMotion}
              disabled={reducedMotion}
              onClick={() => setSnow(!snow)}
              className={cx(
                "relative h-7 w-12 shrink-0 rounded-full border transition disabled:opacity-50",
                snow && !reducedMotion ? "border-accent bg-accent" : "border-line-strong bg-surface-3",
              )}
            >
              <span className="sr-only">Falling snow</span>
              <span
                aria-hidden
                className={cx(
                  "absolute top-1/2 block h-5 w-5 -translate-y-1/2 rounded-full bg-surface shadow-card transition-[left]",
                  snow && !reducedMotion ? "left-[calc(100%-1.375rem)]" : "left-0.5",
                )}
              />
            </button>
          </div>
        </div>
      </SettingsGroup>
    </AppShell>
  );
}
