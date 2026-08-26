"use client";

import { Check } from "lucide-react";
import { CREATE_AREA_LABEL, CREATE_AREA_PATH } from "@/lib/areas";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { scopeMeta, scopeReminder, settingsFor } from "@/lib/settings-scopes.ts";
import { AppShell, PageHeader } from "../components/app-shell";
import { useFestive } from "../components/festive/festive-context";
import { IconBell, IconHome, IconPlus, IconSettings, IconUser } from "../components/icons";
import { InstallCard } from "../components/install-card";
import { SettingsGroup, SettingsRow } from "../components/settings-list";
import { cx } from "../components/ui";
import { useAreas } from "../components/use-areas";

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

      <YourFamilies />

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

/**
 * THE FAMILIES THIS ACCOUNT BELONGS TO, AND THE WAY TO ANOTHER ONE.
 *
 * WHY THIS IS IN *YOUR* SETTINGS RATHER THAN THE FAMILY'S. Which families you
 * belong to is a fact about YOU: it is the same list in every one of them, and
 * it does not change when you switch. A family's own settings -- its name, who
 * can get into it, who is in it -- are the family's, and stay at
 * `/settings/family`, one tap away below. Putting the list there would have
 * meant a family owning the answer to a question about the person.
 *
 * WHAT WAS ACTUALLY WRONG. `/areas/new` existed from the day Areas shipped and
 * was linked from NOWHERE, and `/settings/family` was linked from nowhere
 * either. Both were real screens reachable only by typing a URL. The account
 * menu now carries the first; this carries both, because Settings is where
 * somebody looks when a menu has not offered them what they wanted.
 *
 * NOTHING HERE IS AN EVENT'S. See `src/lib/settings-scopes.ts`.
 */
function YourFamilies() {
  const { loading, choices, canSwitch, canCreate, switchTo } = useAreas();

  // Nothing at all until the list is known: a group that appears, then grows a
  // second row, moves the controls under somebody's thumb as they reach.
  if (loading || choices.length === 0) return null;

  return (
    <SettingsGroup label="Your families">
      <div className="mb-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
        <p className="text-sm leading-6 text-ink-600">
          Each one is separate. Its people, its events and its money are invisible to the others.
        </p>
        <ul className="mt-4">
          {choices.map((choice) => (
            <li key={choice.id} className="flex min-h-11 items-center gap-3 border-t border-line py-2 first:border-t-0 first:pt-0">
              <IconHome size={18} />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-900">{choice.name}</span>
              {choice.archivedAt && <span className="text-xs font-semibold text-ink-400">Archived</span>}
              {choice.active
                ? (
                  <span className="flex items-center gap-1 text-xs font-semibold text-gold">
                    <Check aria-hidden size={15} strokeWidth={2.2} />
                    Current
                  </span>
                )
                : canSwitch && (
                  <button
                    type="button"
                    onClick={() => void switchTo(choice.id)}
                    className="min-h-9 rounded-xl border border-line px-3.5 text-xs font-semibold text-ink-700 hover:border-line-strong"
                  >
                    Switch
                  </button>
                )}
            </li>
          ))}
        </ul>
      </div>

      <SettingsRow
        href={scopeMeta("area").href}
        title="This family's settings"
        description="The name, the people and who can get in — for the family you are in now."
        icon={<IconSettings size={20} />}
      />

      {canCreate && (
        /* A LINK TO THE EXISTING FORM. Nothing is created until that form is
           submitted, and there is no second copy of the create logic here. */
        <SettingsRow
          href={CREATE_AREA_PATH}
          title={CREATE_AREA_LABEL}
          description="A separate family, with its own people, events and money."
          icon={<IconPlus size={20} />}
        />
      )}
    </SettingsGroup>
  );
}
