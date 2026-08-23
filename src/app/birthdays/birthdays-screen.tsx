"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Cake, Pencil } from "lucide-react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { birthdayWorkspacePath, describeDaysAway, formatBirthday, isValidBirthday, isValidBirthYear, peopleWithoutBirthdays, upcomingBirthdays, type PersonBirthday } from "@/lib/birthdays.ts";
import { describeSupabaseError, describeThrown } from "@/lib/supabase-error";
import { createClient } from "@/utils/supabase/client";
import { AppShell, PageHeader } from "../components/app-shell";
import { GarlandRule } from "../components/festive/garland";
import {
  Badge, Button, ButtonLink, EmptyState, Field, Input, Modal, ModalFooter,
  ModalHeader, Notice, Select, cx,
} from "../components/ui";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type BirthdayEventLink = { id: string; name: string };

/**
 * The family Birthday Calendar.
 *
 * This sits OUTSIDE any event, because a birthday belongs to a person and not
 * to an occasion. What it shows is derived: the permanent date is stored once,
 * and every "next occurrence" and "days away" below is computed from today.
 * Nothing here resets in January — the year simply moves on.
 */
export function BirthdaysScreen({
  people,
  birthdayEventsByPersonYear,
  isAdmin,
  today,
  loadError = null,
}: {
  people: PersonBirthday[];
  birthdayEventsByPersonYear: Record<string, BirthdayEventLink>;
  isAdmin: boolean;
  today: string;
  /** The server could not read the birthdays. Said plainly, not thrown. */
  loadError?: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<PersonBirthday | null>(null);
  const [error, setError] = useState<string | null>(loadError);
  const [saved, setSaved] = useState<string | null>(null);

  /**
   * What the database said, for anybody this page has just written.
   *
   * `router.refresh()` is still called after a save, and normally lands first.
   * This is not a substitute for it — it is proof. `set_person_birthday`
   * returns the saved row, so the date shown here after a save is the date
   * PostgreSQL actually holds, not the date the form hoped it would.
   *
   * Live regression this fixes: a birthday was entered, the screen returned to
   * the list, and nothing had changed — with no way to tell whether the write
   * had failed or the page was simply stale. Now the two are distinguishable,
   * because a confirmed write always changes what is on the screen.
   */
  const [confirmed, setConfirmed] = useState<Record<string, PersonBirthday["birthday"]>>({});

  const shown = useMemo(
    () => people.map((person) => (
      Object.hasOwn(confirmed, person.personId)
        ? { ...person, birthday: confirmed[person.personId] }
        : person
    )),
    [confirmed, people],
  );

  const upcoming = useMemo(() => upcomingBirthdays(shown, today), [shown, today]);
  const missing = useMemo(() => peopleWithoutBirthdays(shown), [shown]);

  return (
    <AppShell width="narrow">
      <PageHeader
        eyebrow="Family"
        title="Birthdays"
        description="Everyone's birthday, in the order they come round. Saved once and kept for good."
        actions={<ButtonLink href="/" variant="secondary" size="lg" className="w-full sm:w-auto">Events</ButtonLink>}
      />

      {error && <Notice tone="danger" className="mt-6">{error}</Notice>}
      {saved && <Notice tone="success" className="mt-6">{saved}</Notice>}

      {people.length === 0 && (
        <EmptyState className="mt-8" illustration="star" title="No family members yet"
          body="Add people to the family before recording their birthdays." />
      )}

      {people.length > 0 && upcoming.length === 0 && (
        <EmptyState
          className="mt-8"
          illustration="star"
          title="No birthdays have been added yet"
          body={isAdmin
            ? "Add a birthday below and it will appear here, with reminders a week and a day before."
            : "An admin has not added any birthdays yet."}
        />
      )}

      {upcoming.length > 0 && (
        <section className="mt-10">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
            <h2 className="font-display text-2xl font-semibold text-ink-900">Upcoming</h2>
            <p className="text-xs font-semibold tracking-eyebrow text-ink-600 uppercase">
              {upcoming.length} {upcoming.length === 1 ? "birthday" : "birthdays"}
            </p>
          </div>
          <GarlandRule className="mt-4" />

          {/* One card per row on a phone; two up from tablet. */}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {upcoming.map((person) => {
              const event = birthdayEventsByPersonYear[`${person.personId}:${person.next.year}`];
              return (
                <article
                  key={person.personId}
                  className="flex min-h-[10rem] flex-col rounded-2xl border border-line bg-surface p-5 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <span aria-hidden className="text-2xl leading-none">🎂</span>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-display text-lg leading-snug font-semibold break-words text-ink-900">
                        {person.name}
                      </h3>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs font-semibold text-ink-600">
                        <CalendarDays size={14} aria-hidden className="shrink-0" />
                        {formatBirthday(person.birthday.month, person.birthday.day)}
                        <span aria-hidden>·</span>
                        <span className={person.next.isToday ? "text-accent" : undefined}>
                          {describeDaysAway(person.next.daysAway)}
                        </span>
                      </p>
                    </div>
                    {person.next.isToday && <Badge tone="success">Today</Badge>}
                  </div>

                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
                    {/* Always the person's own workspace. Whether this year's
                        planning has been started is something that page knows
                        and says; it is not a different destination. */}
                    <ButtonLink href={birthdayWorkspacePath(person.personId)} variant="tonal" className="min-h-11">
                      {event ? "Open planning" : "Open"}
                    </ButtonLink>
                    {isAdmin && (
                      <Button variant="ghost" className="min-h-11" onClick={() => { setError(null); setEditing(person); }}>
                        <Pencil size={16} aria-hidden />
                        Edit
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {missing.length > 0 && (
        <section className="mt-12">
          <h2 className="font-display text-2xl font-semibold text-ink-900">No birthday saved</h2>
          <GarlandRule className="mt-4" />
          <ul className="mt-5 divide-y divide-line rounded-2xl border border-line bg-surface">
            {missing.map((person) => (
              <li key={person.personId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <span className="min-w-0 break-words font-semibold text-ink-900">{person.name}</span>
                {isAdmin
                  ? (
                    <Button variant="ghost" className="min-h-11" onClick={() => { setError(null); setEditing(person); }}>
                      <Cake size={16} aria-hidden />
                      Add birthday
                    </Button>
                  )
                  : <span className="text-xs font-medium text-ink-600">Not recorded</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && (
        <BirthdayModal
          person={editing}
          onClose={() => setEditing(null)}
          onSaved={(person, birthday) => {
            // The row the database returned, kept immediately, so the list
            // below shows the new date on this render rather than the next.
            setConfirmed((current) => ({ ...current, [person.personId]: birthday }));
            setEditing(null);
            setError(null);
            setSaved(birthday
              ? `${person.name}'s birthday is saved.`
              : `${person.name}'s birthday was removed.`);
            // And the server render catches up, so a reload agrees with this.
            router.refresh();
          }}
          onError={(message) => { setEditing(null); setSaved(null); setError(message); }}
        />
      )}
    </AppShell>
  );
}

function BirthdayModal({
  person,
  onClose,
  onSaved,
  onError,
}: {
  person: PersonBirthday;
  onClose: () => void;
  /** Called only with a row the database returned. */
  onSaved: (person: PersonBirthday, birthday: PersonBirthday["birthday"]) => void;
  onError: (message: string) => void;
}) {
  const [month, setMonth] = useState(person.birthday ? String(person.birthday.month) : "");
  const [day, setDay] = useState(person.birthday ? String(person.birthday.day) : "");
  const [year, setYear] = useState(person.birthday?.year ? String(person.birthday.year) : "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (clear: boolean) => {
    setProblem(null);
    const monthNumber = clear ? null : Number(month);
    const dayNumber = clear ? null : Number(day);
    const yearNumber = clear || year.trim() === "" ? null : Number(year);

    if (!clear) {
      if (!isValidBirthday(monthNumber, dayNumber)) {
        setProblem("That day does not exist in that month.");
        return;
      }
      if (!isValidBirthYear(yearNumber)) {
        setProblem("Enter a realistic year of birth, or leave it blank.");
        return;
      }
    }

    setSaving(true);
    try {
      // The database checks admin rights itself; this call is refused for
      // anybody else regardless of what the browser shows.
      //
      // `set_person_birthday` RETURNS THE SAVED ROW. That return value is the
      // only honest evidence the write happened, so it is what decides whether
      // this reports success — not the absence of an error.
      const result = await createClient().rpc("set_person_birthday", {
        p_person_id: person.personId,
        p_month: monthNumber,
        p_day: dayNumber,
        p_year: yearNumber,
      });

      if (result.error) {
        onError(describeSupabaseError(result.error, "That birthday could not be saved."));
        return;
      }

      const row = result.data as {
        id?: string;
        birthday_month?: number | null;
        birthday_day?: number | null;
        birthday_year?: number | null;
      } | null;

      if (!row || typeof row !== "object") {
        // No error and no row: the call went somewhere that did not write.
        // Reporting success here is what "the UI said it saved and it had not"
        // looks like from the outside.
        onError("The save could not be confirmed by the database, so nothing was changed. Please try again.");
        return;
      }

      const savedBirthday = row.birthday_month === null || row.birthday_month === undefined
        || row.birthday_day === null || row.birthday_day === undefined
        ? null
        : {
          month: Number(row.birthday_month),
          day: Number(row.birthday_day),
          year: row.birthday_year === null || row.birthday_year === undefined ? null : Number(row.birthday_year),
        };

      // What was asked for, and what came back, have to agree. If they do not,
      // something wrote a different value and the reader needs to know.
      const wanted = clear ? null : { month: monthNumber, day: dayNumber };
      if ((wanted === null) !== (savedBirthday === null)
        || (wanted && savedBirthday && (wanted.month !== savedBirthday.month || wanted.day !== savedBirthday.day))) {
        onError("The database saved something different from what was entered. Nothing has been assumed — please check the Birthdays list.");
        return;
      }

      onSaved(person, savedBirthday);
    } catch (thrown) {
      onError(describeThrown(thrown, "That birthday could not be saved. Check your connection and try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="birthday-modal-title">
      <ModalHeader
        id="birthday-modal-title"
        eyebrow={person.name}
        title={person.birthday ? "Edit birthday" : "Add birthday"}
        onClose={onClose}
      />
      <div className="space-y-4 px-5 py-5 sm:px-7">
        {problem && <Notice tone="danger">{problem}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Month" required>
            <Select value={month} onChange={(event) => setMonth(event.target.value)}>
              <option value="">Choose…</option>
              {MONTHS.map((name, index) => (
                <option key={name} value={String(index + 1)}>{name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Day" required>
            <Input
              inputMode="numeric"
              value={day}
              onChange={(event) => setDay(event.target.value.replace(/[^0-9]/gu, "").slice(0, 2))}
              placeholder="6"
            />
          </Field>
        </div>
        <Field label="Year of birth" hint="Optional. Leave blank to record only the date.">
          <Input
            inputMode="numeric"
            value={year}
            onChange={(event) => setYear(event.target.value.replace(/[^0-9]/gu, "").slice(0, 4))}
            placeholder="1998"
          />
        </Field>
        <p className="text-xs leading-5 text-ink-600">
          Saved once and kept for good. Reminders go to the rest of the family a week
          and a day before — never to {person.name.split(" ")[0]}. The date itself is
          on the dashboard from the moment it is saved.
        </p>
      </div>
      <ModalFooter>
        {person.birthday
          ? (
            <Button variant="ghost" disabled={saving} onClick={() => void save(true)} className={cx("min-h-11")}>
              Remove birthday
            </Button>
          )
          : <Button variant="ghost" disabled={saving} onClick={onClose} className="min-h-11">Cancel</Button>}
        <Button disabled={saving} onClick={() => void save(false)} className="min-h-11">
          {saving ? "Saving…" : "Save birthday"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

export { Link };
