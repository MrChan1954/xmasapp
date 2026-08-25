"use client";

import { useEffect, useState } from "react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventSettingsFor, scopeReminder } from "@/lib/settings-scopes.ts";
import { AppShell, PageHeader } from "../../../components/app-shell";
import { IconReceipt, IconSettings } from "../../../components/icons";
import { SettingsGroup, SettingsRow } from "../../../components/settings-list";
import { Notice, Skeleton } from "../../../components/ui";

/**
 * ONE OCCASION'S OWN SETTINGS, AND NOTHING ELSE.
 *
 * WHAT THIS SCREEN USED TO BE. It rendered `MoreScreen` -- the whole
 * application's settings list. Standing inside Mother's Day you were offered
 * Falling snow, Account & security, Notifications, the People directory,
 * Birthdays, Activity and Family access. None of those is a property of
 * Mother's Day. With one family that was untidy; with Areas it was misleading,
 * because every one of them belongs to the SELECTED FAMILY and an event is not
 * the thing that scopes a family.
 *
 * WHAT IS LEFT is what an event can actually answer for: its name, its date,
 * who takes part (all behind Event settings), and the payments recorded against
 * it. The list is short because the scope is small, and a short honest list
 * beats a long one that answers the wrong question.
 *
 * WHERE EVERYTHING ELSE WENT. Settings, in the main navigation -- the sidebar
 * on a desktop, the tab bar and the account menu on a phone. `/settings` is
 * yours, `/settings/family` is this family's. See `src/lib/settings-scopes.ts`.
 */
export function EventMoreScreen({
  eventId,
  eventName,
}: {
  eventId: string;
  eventName: string;
}) {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const response = await fetch("/api/admin/family-access", { method: "GET", cache: "no-store" });
        if (!active) return;
        if (response.ok) setIsAdmin(true);
        else if (response.status === 401 || response.status === 403) setIsAdmin(false);
        else { setIsAdmin(false); setCheckFailed(true); }
      } catch {
        if (active) { setIsAdmin(false); setCheckFailed(true); }
      }
    })();

    return () => { active = false; };
  }, []);

  // Built from the model rather than written out here, so the rule about what
  // belongs in this scope lives in one file and a test can run it.
  const entries = isAdmin === null ? [] : eventSettingsFor(eventId, eventName, { isAdmin });

  return (
    <AppShell width="narrow">
      <PageHeader
        eyebrow={eventName}
        title="More"
        description={`Settings for ${eventName}. ${scopeReminder("event", "this family")}`}
      />

      {checkFailed && (
        <Notice tone="warning" className="mt-6">
          We could not check whether you administer this family, so admin-only entries are hidden.
        </Notice>
      )}

      <SettingsGroup label={eventName}>
        {isAdmin === null
          ? <Skeleton className="h-16" />
          : entries.map((entry) => (
            <SettingsRow
              key={entry.key}
              href={entry.href}
              title={entry.title}
              description={entry.description}
              icon={entry.key === "event-payment-log" ? <IconReceipt size={20} /> : <IconSettings size={20} />}
            />
          ))}
      </SettingsGroup>

      {/* Says where the rest went, without becoming a second settings hub: it
          names the destination in prose rather than re-listing what is there. */}
      <p className="mt-8 text-sm leading-6 text-ink-600">
        Your account, notifications, appearance, the family directory and who can get
        into this family are not settings of {eventName}. They live in Settings, in the
        main navigation.
      </p>
    </AppShell>
  );
}
