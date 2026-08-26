"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { isValidBirthday, isValidBirthYear } from "@/lib/birthdays.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { type PersonAccount, type PersonDirectoryEntry } from "@/lib/people.ts";
import { INPUT_LIMITS } from "@/lib/input-validation";
import { describeSupabaseError, describeThrown } from "@/lib/supabase-error";
import { createClient } from "@/utils/supabase/client";
import { Button, ButtonLink, Field, Input, Notice } from "../../components/ui";

/**
 * THE FOUR THINGS A PERSON CAN BE, AS FOUR SEPARATE CONTROLS.
 *
 *   PERSON       their name, their birthday. They exist because they exist.
 *   CONTRIBUTOR  eligible to share the cost of gifts. A flag on the PERSON, so
 *                somebody with no account at all can be one.
 *   ACCOUNT      a login. Most people never need one.
 *   ADMIN        who runs this family. A property of the MEMBERSHIP, and
 *                changed only by handover -- never by a switch on this page.
 *
 * WHY THEY ARE NOT ONE PANEL OF SWITCHES. Every one of these has been the same
 * bug at some point in this application's life: "add them so we can buy for
 * them" turning into an account, "let them chip in" turning into
 * administration. Each control below says, in its own words, what it does NOT
 * do -- because the reader's model of these four is built here or nowhere.
 *
 * NOTHING HERE IS THE PERMISSION. Every action calls a SECURITY DEFINER routine
 * that resolves the Area FROM THE PERSON and refuses anybody who does not
 * administer THAT family (migration 044). Hiding a control is courtesy; the
 * answer is Postgres's.
 */
export function PersonAdminPanel({
  person,
  account,
  isAdmin,
  canEditBirthdays,
  areaName,
  isSelf,
}: {
  person: PersonDirectoryEntry;
  account: PersonAccount;
  isAdmin: boolean;
  canEditBirthdays: boolean;
  areaName: string;
  isSelf: boolean;
}) {
  if (!isAdmin && !canEditBirthdays) return null;

  return (
    <div className="mt-6 space-y-4">
      {isAdmin && <RenamePerson person={person} areaName={areaName} />}
      {canEditBirthdays && <EditBirthday person={person} isSelf={isSelf} isAdmin={isAdmin} />}
      {isAdmin && <ContributorControl person={person} account={account} />}
      {isAdmin && <ArchiveControl person={person} />}
    </div>
  );
}

/** The shared shell, so four different jobs do not become four different cards. */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <h3 className="font-display text-lg font-semibold text-ink-900">{title}</h3>
      {children}
    </section>
  );
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // `PromiseLike`, not `Promise`: a PostgREST builder is a thenable that only
  // becomes a request when it is awaited, and typing it as a Promise rejects
  // every call site.
  const run = async (fallback: string, success: string, call: () => PromiseLike<{ error: unknown } | null>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await call();
      const failure = (result as { error?: { message?: string; code?: string } } | null)?.error;
      if (failure) {
        setError(describeSupabaseError(failure as never, fallback));
        setBusy(false);
        return;
      }
      setDone(success);
      setBusy(false);
      // The server component owns every figure on this page, so the page is
      // re-read rather than patched in place.
      router.refresh();
    } catch (thrown) {
      setError(describeThrown(thrown, fallback));
      setBusy(false);
    }
  };

  return { busy, error, done, run };
}

function RenamePerson({ person, areaName }: { person: PersonDirectoryEntry; areaName: string }) {
  const [name, setName] = useState(person.name);
  const { busy, error, done, run } = useAction();
  const trimmed = name.trim();
  const unchanged = trimmed === person.name;

  return (
    <Card title="Name">
      <p className="mt-1.5 text-xs leading-5 text-ink-600">
        Correcting a spelling changes it everywhere in {areaName} — every event, every purchase and
        the whole history, because they all point at this person rather than at their name. It
        changes nothing about them in any other family.
      </p>
      <Field label="Name" className="mt-4" required>
        <Input
          value={name}
          maxLength={INPUT_LIMITS.name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      {error && <Notice tone="warning" className="mt-3">{error}</Notice>}
      {done && <Notice tone="success" className="mt-3">{done}</Notice>}
      <div className="mt-4">
        <Button
          className="min-h-11"
          disabled={busy || unchanged || trimmed.length === 0}
          onClick={() => void run("That name could not be saved.", "Name saved.", () =>
            createClient().rpc("set_person_name", { p_person_id: person.personId, p_name: trimmed }))}
        >
          {busy ? "Saving…" : "Save name"}
        </Button>
      </div>
    </Card>
  );
}

function EditBirthday({
  person,
  isSelf,
  isAdmin,
}: {
  person: PersonDirectoryEntry;
  isSelf: boolean;
  isAdmin: boolean;
}) {
  const [day, setDay] = useState(person.birthday ? String(person.birthday.day) : "");
  const [month, setMonth] = useState(person.birthday ? String(person.birthday.month) : "");
  const [year, setYear] = useState(person.birthday?.year ? String(person.birthday.year) : "");
  const { busy, error, done, run } = useAction();

  const wants = month !== "" || day !== "";
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const yearNumber = year === "" ? null : Number(year);
  const valid = !wants || (isValidBirthday(monthNumber, dayNumber) && isValidBirthYear(yearNumber));

  return (
    <Card title="Birthday">
      <p className="mt-1.5 text-xs leading-5 text-ink-600">
        The day and month are what reminders and ages use; the year only shows the age they are
        turning. Changing a birthday moves no event that has already been created.
        {isSelf && !isAdmin && " This is your own birthday — what the family plans for it stays hidden from you."}
      </p>
      <div className="mt-4 flex gap-2">
        <Input value={day} inputMode="numeric" placeholder="Day" aria-label="Day"
          onChange={(event) => setDay(event.target.value.replace(/[^0-9]/gu, "").slice(0, 2))} />
        <Input value={month} inputMode="numeric" placeholder="Month" aria-label="Month"
          onChange={(event) => setMonth(event.target.value.replace(/[^0-9]/gu, "").slice(0, 2))} />
        <Input value={year} inputMode="numeric" placeholder="Year" aria-label="Year of birth"
          onChange={(event) => setYear(event.target.value.replace(/[^0-9]/gu, "").slice(0, 4))} />
      </div>
      {wants && !valid && (
        <p className="mt-2 text-sm text-berry">That is not a real date. Enter a day and a month that exist together.</p>
      )}
      {error && <Notice tone="warning" className="mt-3">{error}</Notice>}
      {done && <Notice tone="success" className="mt-3">{done}</Notice>}
      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          className="min-h-11"
          disabled={busy || !valid}
          onClick={() => void run("That birthday could not be saved.", "Birthday saved.", () =>
            createClient().rpc("set_person_birthday", {
              p_person_id: person.personId,
              p_month: wants ? monthNumber : null,
              p_day: wants ? dayNumber : null,
              p_year: wants && yearNumber !== null ? yearNumber : null,
            }))}
        >
          {busy ? "Saving…" : "Save birthday"}
        </Button>
        {person.birthday && (
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={busy}
            onClick={() => {
              setDay(""); setMonth(""); setYear("");
              void run("That birthday could not be cleared.", "Birthday cleared.", () =>
                createClient().rpc("set_person_birthday", {
                  p_person_id: person.personId, p_month: null, p_day: null, p_year: null,
                }));
            }}
          >
            Clear birthday
          </Button>
        )}
      </div>
    </Card>
  );
}

function ContributorControl({
  person,
  account,
}: {
  person: PersonDirectoryEntry;
  account: PersonAccount;
}) {
  const { busy, error, done, run } = useAction();
  const on = person.isFamilyContributor;

  return (
    <Card title="Contributor">
      <p className="mt-1.5 text-xs leading-5 text-ink-600">
        A contributor is somebody who may be asked to share the cost of a gift. It is a fact about
        the PERSON, not about a login: it neither gives nor removes account access, and it does not
        make anybody an admin.
      </p>
      <p className="mt-2 text-xs leading-5 text-ink-600">
        Turning it off changes only what happens NEXT. Every purchase, allocation and payment
        already recorded stays exactly as it is.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <p className="text-sm font-semibold text-ink-900">
          {on ? `${person.name} may chip in` : `${person.name} is not a contributor`}
        </p>
        <Button
          variant="secondary"
          className="min-h-11"
          disabled={busy}
          onClick={() => void run(
            "That could not be changed.",
            on ? "They are no longer a contributor." : "They can chip in now.",
            () => createClient().rpc("set_family_contributor", {
              p_person_id: person.personId, p_eligible: !on,
            }),
          )}
        >
          {busy ? "Saving…" : on ? "Remove from contributors" : "Make a contributor"}
        </Button>
      </div>

      {/* The sentence that stops the two being read as one switch. */}
      <p className="mt-3 text-xs leading-5 text-ink-500">
        Account access is separate and unchanged: {ACCOUNT_SENTENCE[account.status]}
      </p>

      {error && <Notice tone="warning" className="mt-3">{error}</Notice>}
      {done && <Notice tone="success" className="mt-3">{done}</Notice>}
    </Card>
  );
}

const ACCOUNT_SENTENCE: Record<PersonAccount["status"], string> = {
  none: "they cannot sign in.",
  invited: "they have been invited but have not signed in yet.",
  active: "they can sign in.",
  disabled: "their sign-in is disabled.",
};

function ArchiveControl({ person }: { person: PersonDirectoryEntry }) {
  const { busy, error, done, run } = useAction();
  const archived = person.archivedAt !== null;
  const [confirming, setConfirming] = useState(false);

  return (
    <Card title={archived ? "Restore this person" : "Archive this person"}>
      <p className="mt-1.5 text-xs leading-5 text-ink-600">
        {archived
          ? "They will be offered again when choosing who a new event is for."
          : "Archiving keeps everything. Their birthday, every gift bought for them and every penny recorded stay exactly where they are — they simply stop being offered when setting up something new. There is no way to delete a person who has history, and there should not be."}
      </p>
      {error && <Notice tone="warning" className="mt-3">{error}</Notice>}
      {done && <Notice tone="success" className="mt-3">{done}</Notice>}
      <div className="mt-4 flex flex-wrap gap-3">
        {archived || confirming
          ? (
            <>
              <Button
                variant={archived ? "secondary" : "dangerGhost"}
                className="min-h-11"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  void run(
                    "That could not be changed.",
                    archived ? `${person.name} is active again.` : `${person.name} has been archived.`,
                    () => createClient().rpc("set_person_archived", {
                      p_person_id: person.personId, p_archived: !archived,
                    }),
                  );
                }}
              >
                {busy ? "Saving…" : archived ? "Restore" : `Yes, archive ${person.name}`}
              </Button>
              {!archived && (
                <Button variant="ghost" className="min-h-11" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep them active
                </Button>
              )}
            </>
          )
          : (
            <Button variant="ghost" className="min-h-11" disabled={busy} onClick={() => setConfirming(true)}>
              Archive this person…
            </Button>
          )}
      </div>
    </Card>
  );
}

/**
 * WHETHER THIS PERSON CAN SIGN IN, AND WHAT THEY ARE IF THEY DO.
 *
 * Read-only here on purpose. Creating, disabling and re-addressing a login is
 * Family Access's job, and a second set of buttons doing the same writes from a
 * different screen is how two systems that disagree get built. This says what
 * is true and points at the one place it is changed.
 */
export function PersonAccountSummary({
  person,
  account,
  areaName,
}: {
  person: PersonDirectoryEntry;
  account: PersonAccount;
  areaName: string;
}) {
  return (
    <Card title="Account access">
      <dl className="mt-3 space-y-2 text-sm">
        <Row label="Family" value={areaName} />
        <Row label="Can sign in" value={ACCOUNT_LABEL[account.status]} />
        <Row
          label="Role in this family"
          value={account.status === "none"
            ? "No account, so no role"
            : account.isAdmin
              ? "Admin of this family"
              : "Member"}
        />
      </dl>

      <p className="mt-3 text-xs leading-5 text-ink-600">
        {account.status === "none"
          ? "Most people never need one. An account is only for somebody who signs in — it is not needed to buy for them, and it is not needed for them to chip in."
          : "Removing account access keeps this person, their birthday and everything bought for them. The two are separate."}
      </p>
      {account.isAdmin && (
        <p className="mt-2 text-xs leading-5 text-ink-600">
          One person runs a family at a time, so this role is changed by handing it over rather than
          by a switch. {areaName} keeps exactly one admin at every moment.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <ButtonLink href="/more/family-access" variant="secondary" className="min-h-11">
          {account.status === "none" ? `Give ${person.name} account access` : "Manage account access"}
        </ButtonLink>
        {account.isAdmin && (
          <ButtonLink href="/settings/family" variant="ghost" className="min-h-11">
            Hand over admin
          </ButtonLink>
        )}
      </div>
    </Card>
  );
}

/** One word each, so the four states are never conflated on screen. */
const ACCOUNT_LABEL: Record<PersonAccount["status"], string> = {
  none: "No account",
  invited: "Invited, not signed in yet",
  active: "Yes",
  disabled: "Disabled",
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
      <dt className="text-ink-600">{label}</dt>
      <dd className="font-semibold text-ink-900">{value}</dd>
    </div>
  );
}
