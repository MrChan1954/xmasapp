"use client";

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventSettingsFor, scopeReminder } from "@/lib/settings-scopes.ts";
import { useFamily } from "../../../family-context";
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
  /*
   * WHO IS ASKING, ANSWERED BY THE PROVIDER THAT ALREADY KNOWS.
   *
   * THIS USED TO GUESS FROM A STATUS CODE. The screen sent a GET to
   * `/api/admin/family-access` and read administration off the response:
   * `ok` meant admin, 401/403 meant not, anything else meant "we could not
   * check". Q19 then rewrote that route -- migration 052 moved every read into
   * `list_area_access()` -- and its GET handler went with the rest, leaving
   * only a POST. Next answers a GET to a POST-only route with 405, which is
   * none of the three cases, so EVERY reader landed in the third: an
   * administrator and an ordinary member alike were told their role could not
   * be checked, and the admin entries were hidden from the people they exist
   * for. Live symptom of a probe that inferred a role from a transport detail.
   *
   * A ROLE IS NOT A STATUS CODE, and it never was. `FamilyProvider` resolves
   * the membership for the family ON SCREEN and hands it down; the navigation
   * chrome has read it all along. Asking the same question of the same source
   * is what makes this screen agree with the rest of the app instead of
   * running a second, weaker check of its own.
   *
   * WHAT THAT SOURCE GUARANTEES, and why nothing here needs to re-check it:
   *
   *   THE SELECTED AREA DECIDES.  `getCurrentMemberClient` returns the
   *   membership for the remembered Area and, for an account in several
   *   families with no choice remembered, REFUSES TO GUESS and returns null.
   *   So administering one family can never grant admin entries in another.
   *
   *   GLOBAL ADMIN IS NOT FAMILY ADMIN.  `role` is `app_members.role` in this
   *   Area. `is_global_admin()` is a different question with a different
   *   answer and does not reach this value.
   *
   *   AND IT IS NOT THE BOUNDARY.  Every destination below re-authorises on
   *   its own, in the database. This decides what is worth OFFERING.
   *
   * FAIL CLOSED, TWICE. Nothing is admin-only until the role has actually
   * arrived, and a role that never arrives is not an administrator -- a
   * membership read that fails returns null exactly like a member with no seat,
   * and both hide the entries. The warning below now means what it says.
   */
  const { role, loading } = useFamily();
  const settled = !loading;
  const isAdmin = role === "admin";
  const checkFailed = settled && role === null;

  // Built from the model rather than written out here, so the rule about what
  // belongs in this scope lives in one file and a test can run it.
  const entries = settled ? eventSettingsFor(eventId, eventName, { isAdmin }) : [];

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
        {!settled
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
