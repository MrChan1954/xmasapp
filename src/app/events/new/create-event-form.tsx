"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronLeft } from "lucide-react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { EVENT_TYPES, birthdayDateLooksLikeDateOfBirth, eventTypeMeta, formatEventDate, validateEventInput, type EventType } from "@/lib/events.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { birthdayOccurrence, suggestedBirthdayEventName } from "@/lib/birthdays.ts";
import { INPUT_LIMITS } from "@/lib/input-validation";
import { createClient } from "@/utils/supabase/client";
import { AppShell, PageHeader } from "../../components/app-shell";
import { GarlandRule } from "../../components/festive/garland";
import {
  Button, Field, Input, Notice, Textarea, cx,
} from "../../components/ui";

export type CreatablePerson = {
  personId: string;
  name: string;
  birthday: { month: number; day: number } | null;
};

type Step = "type" | "details" | "people" | "review";

const STEPS: Array<{ step: Step; label: string }> = [
  { step: "type", label: "Type" },
  { step: "details", label: "Details" },
  { step: "people", label: "People" },
  { step: "review", label: "Review" },
];

/**
 * Create Event.
 *
 * Staged rather than one long form, because the choices genuinely depend on
 * each other: the type decides whether there is a celebrant, the celebrant
 * decides the suggested date and name, and both decide who is proposed as
 * recipient and contributor.
 *
 * Nothing here writes to `events`. Every browser session is refused that by the
 * database; this calls `create_event`, which checks Global Admin itself and
 * creates the event, its recipients and its contributors in one transaction.
 */
export function CreateEventForm({ people, today }: { people: CreatablePerson[]; today: string }) {
  const router = useRouter();
  const params = useSearchParams();

  // Pre-filled when arriving from the Birthdays calendar, so nothing is retyped.
  const presetType = params.get("type");
  const presetCelebrant = params.get("celebrant");
  const [step, setStep] = useState<Step>(presetType ? "details" : "type");
  const [type, setType] = useState<EventType>(
    (EVENT_TYPES as readonly string[]).includes(presetType ?? "") ? (presetType as EventType) : "christmas",
  );
  const [celebrantId, setCelebrantId] = useState<string>(presetCelebrant ?? "");
  const [name, setName] = useState(params.get("name") ?? "");
  const [date, setDate] = useState(params.get("date") ?? "");
  const [description, setDescription] = useState("");
  const [recipientIds, setRecipientIds] = useState<string[]>(presetCelebrant ? [presetCelebrant] : []);
  const [contributorIds, setContributorIds] = useState<string[]>(
    people.filter((person) => person.personId !== presetCelebrant).map((person) => person.personId),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = eventTypeMeta(type);
  const celebrant = people.find((person) => person.personId === celebrantId) ?? null;

  /**
   * Sensible defaults, offered rather than imposed: everything below is a
   * starting point the admin can overwrite before saving.
   */
  const applyTypeDefaults = (nextType: EventType) => {
    setType(nextType);
    setError(null);
    const nextMeta = eventTypeMeta(nextType);
    const year = new Date().getUTCFullYear() + (nextType === "christmas" ? 0 : 0);

    if (nextType === "christmas") {
      setName(`Christmas ${year}`);
      setDate(`${year}-12-25`);
      setCelebrantId("");
      // Christmas does not assume everybody receives: the admin chooses.
      setRecipientIds([]);
      setContributorIds(people.map((person) => person.personId));
      return;
    }
    if (nextType === "easter") {
      setName(`Easter ${year}`);
      // Easter moves every year and no date is guessed: a wrong holiday date is
      // worse than an empty field.
      setDate("");
      setCelebrantId("");
      setRecipientIds([]);
      setContributorIds(people.map((person) => person.personId));
      return;
    }
    if (!nextMeta.allowsCelebrant) setCelebrantId("");
    setName("");
    setDate("");
    setRecipientIds([]);
    setContributorIds(people.map((person) => person.personId));
  };

  /**
   * Choosing the birthday person fills in the rest: their saved birthday gives
   * the date, the date gives the name, they become the recipient, and they are
   * left out of the contributors — nobody chips in for their own present.
   */
  const chooseCelebrant = (personId: string) => {
    setCelebrantId(personId);
    setError(null);
    const person = people.find((row) => row.personId === personId);
    if (!person || type !== "birthday") return;

    if (person.birthday) {
      const year = nextOccurrenceYear(person.birthday);
      setDate(birthdayOccurrence(person.birthday.month, person.birthday.day, year));
      setName(suggestedBirthdayEventName(person.name, year));
    } else if (!name) {
      setName(`${person.name}'s Birthday`);
    }
    setRecipientIds([personId]);
    setContributorIds(people.filter((row) => row.personId !== personId).map((row) => row.personId));
  };

  const validation = useMemo(() => validateEventInput({
    name,
    type,
    eventDate: date,
    celebrantPersonId: celebrantId || null,
  }), [celebrantId, date, name, type]);

  /**
   * The mistake this catches actually happened, in production.
   *
   * Somebody meaning to record a permanent birthday came here instead and typed
   * a date of birth into the date field. The result was an event for a year
   * three decades ago, and a person whose birthday the calendar still did not
   * know. A warning, not a block: a celebration that has already happened is a
   * legitimate thing to record.
   */
  const dateOfBirthWarning = useMemo(
    () => (type === "birthday" ? birthdayDateLooksLikeDateOfBirth(date, today) : null),
    [date, today, type],
  );

  const create = async () => {
    setError(null);
    if (!validation.ok) { setError(validation.error); return; }

    setSaving(true);
    const result = await createClient().rpc("create_event", {
      p_name: validation.value.name,
      p_event_type: validation.value.type,
      p_event_date: validation.value.eventDate,
      p_description: description.trim() || null,
      p_celebrant_person_id: validation.value.celebrantPersonId,
      p_recipient_person_ids: recipientIds,
      p_contributor_person_ids: contributorIds,
    });
    setSaving(false);

    if (result.error) {
      setError(friendlyCreateError(result.error.message));
      return;
    }
    const created = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!created?.id) {
      // No error and no row. Navigating to the dashboard here would look like
      // success; saying so does not.
      setError("The event could not be confirmed by the database, so nothing was created. Please try again.");
      return;
    }
    // No refresh afterwards: this route is about to be left, and refreshing the
    // page being navigated away from is what turned a successful delete into an
    // error page elsewhere in this app. The destination loads its own data.
    router.push(`/events/${created.id}`);
  };

  return (
    <AppShell width="narrow">
      <PageHeader
        eyebrow="Global Admin"
        title="Create event"
        description="Set up an occasion for the family to plan and pay for together."
      />

      <ol className="mt-6 flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((entry, index) => {
          const current = entry.step === step;
          const done = STEPS.findIndex((row) => row.step === step) > index;
          return (
            <li key={entry.step}>
              <span className={cx(
                "inline-flex min-h-11 items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold",
                current ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink-600",
              )}>
                {done ? <Check size={15} aria-hidden /> : <span aria-hidden>{index + 1}</span>}
                {entry.label}
              </span>
            </li>
          );
        })}
      </ol>

      {error && <Notice tone="danger" className="mt-6">{error}</Notice>}
      <GarlandRule className="mt-6" />

      {step === "type" && (
        <section className="mt-6">
          <h2 className="font-display text-xl font-semibold text-ink-900">What kind of event?</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {EVENT_TYPES.map((option: EventType) => {
              const optionMeta = eventTypeMeta(option);
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => { applyTypeDefaults(option); setStep("details"); }}
                  className={cx(
                    "flex min-h-16 items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-left",
                    "hover:border-accent/40 hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  )}
                >
                  <span aria-hidden className="text-2xl leading-none">{optionMeta.icon}</span>
                  <span className="font-display text-base font-semibold text-ink-900">{optionMeta.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {step === "details" && (
        <section className="mt-6 space-y-4">
          <h2 className="font-display text-xl font-semibold text-ink-900">
            {meta.icon} {meta.label} details
          </h2>

          {meta.allowsCelebrant && (
            <Field
              label={type === "birthday" ? "Whose birthday?" : "Who is it for?"}
              required={meta.requiresCelebrant}
              hint={type === "birthday" ? "Their saved birthday fills in the date and name." : undefined}
            >
              <select
                value={celebrantId}
                onChange={(event) => chooseCelebrant(event.target.value)}
                className="h-12 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-base text-ink-900 shadow-card outline-none focus:border-accent/60 focus:ring-4 focus:ring-accent/20"
              >
                <option value="">Choose…</option>
                {people.map((person) => (
                  <option key={person.personId} value={person.personId}>
                    {person.name}{person.birthday ? "" : " (no birthday saved)"}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Event name" required>
            <Input
              value={name}
              maxLength={INPUT_LIMITS.name}
              onChange={(event) => setName(event.target.value)}
              placeholder={meta.label}
            />
          </Field>

          <Field label="Date" required hint={type === "easter" ? "Easter moves each year, so choose the date rather than guessing it." : undefined}>
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>

          {dateOfBirthWarning && (
            <Notice tone="warning">
              {dateOfBirthWarning}
              {" "}
              <Link href="/birthdays" className="font-semibold underline">Go to Birthdays</Link>
            </Notice>
          )}

          <Field label="Description" hint="Optional.">
            <Textarea
              rows={3}
              value={description}
              maxLength={1000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          <div className="flex flex-wrap gap-3 pt-2">
            <Button variant="ghost" className="min-h-11" onClick={() => setStep("type")}>
              <ChevronLeft size={16} aria-hidden />
              Back
            </Button>
            <Button className="min-h-11" disabled={!validation.ok} onClick={() => setStep("people")}>
              Choose people
            </Button>
          </div>
        </section>
      )}

      {step === "people" && (
        <section className="mt-6 space-y-8">
          <PeoplePicker
            title="Who is this event for?"
            hint="Recipients start with no budget. You can set budgets and plans once the event exists."
            people={people}
            selected={recipientIds}
            onChange={setRecipientIds}
          />
          <PeoplePicker
            title="Who is chipping in?"
            hint={celebrant
              ? `${celebrant.name.split(" ")[0]} is left out by default — nobody pays for their own present. You can change that.`
              : "Contributors share the cost of every purchase in this event."}
            people={people}
            selected={contributorIds}
            onChange={setContributorIds}
          />
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost" className="min-h-11" onClick={() => setStep("details")}>
              <ChevronLeft size={16} aria-hidden />
              Back
            </Button>
            <Button className="min-h-11" onClick={() => setStep("review")}>Review</Button>
          </div>
        </section>
      )}

      {step === "review" && validation.ok && (
        <section className="mt-6 space-y-5">
          <div className="rounded-2xl border border-line bg-surface p-5">
            <p className="text-xs font-semibold tracking-eyebrow text-gold uppercase">
              {meta.icon} {meta.label}
            </p>
            <h2 className="mt-1.5 font-display text-2xl font-semibold break-words text-ink-900">
              {validation.value.name}
            </h2>
            <p className="mt-1 text-sm text-ink-600">{formatEventDate(validation.value.eventDate)}</p>
            <dl className="mt-4 space-y-1.5 text-sm">
              {celebrant && (
                <div className="flex gap-2"><dt className="text-ink-600">For</dt><dd className="font-semibold text-ink-900">{celebrant.name}</dd></div>
              )}
              <div className="flex gap-2">
                <dt className="text-ink-600">Recipients</dt>
                <dd className="font-semibold text-ink-900">{describePeople(people, recipientIds)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-ink-600">Contributors</dt>
                <dd className="font-semibold text-ink-900">{describePeople(people, contributorIds)}</dd>
              </div>
            </dl>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost" className="min-h-11" onClick={() => setStep("people")}>
              <ChevronLeft size={16} aria-hidden />
              Back
            </Button>
            <Button className="min-h-11" disabled={saving} onClick={() => void create()}>
              {saving ? "Creating…" : "Create event"}
            </Button>
          </div>
        </section>
      )}
    </AppShell>
  );
}

function PeoplePicker({
  title,
  hint,
  people,
  selected,
  onChange,
}: {
  title: string;
  hint: string;
  people: CreatablePerson[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (personId: string) => {
    onChange(selected.includes(personId)
      ? selected.filter((id) => id !== personId)
      : [...selected, personId]);
  };

  return (
    <div>
      <h2 className="font-display text-xl font-semibold text-ink-900">{title}</h2>
      <p className="mt-1.5 text-sm leading-6 text-ink-600">{hint}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {people.map((person) => {
          const on = selected.includes(person.personId);
          return (
            <button
              key={person.personId}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(person.personId)}
              className={cx(
                "min-h-11 rounded-xl border px-3.5 text-sm font-semibold",
                on ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink-600 hover:bg-hover-veil",
              )}
            >
              {person.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function describePeople(people: CreatablePerson[], ids: string[]): string {
  if (ids.length === 0) return "Nobody yet";
  return people.filter((person) => ids.includes(person.personId)).map((person) => person.name).join(", ");
}

/** This year's birthday if it is still to come, otherwise next year's. */
function nextOccurrenceYear(birthday: { month: number; day: number }): number {
  const now = new Date();
  const year = now.getUTCFullYear();
  const thisYear = birthdayOccurrence(birthday.month, birthday.day, year);
  const today = now.toISOString().slice(0, 10);
  return thisYear >= today ? year : year + 1;
}

/** The database's own message, unless it is one the reader cannot act on. */
function friendlyCreateError(message: string): string {
  if (/events_one_birthday_per_person_per_year_idx/u.test(message)) {
    return "That person already has a birthday event for this year. Open it from the Birthdays page.";
  }
  if (/events_one_christmas_per_year_idx/u.test(message)) {
    return "There is already a Christmas for that year.";
  }
  if (/events_name_and_date_unique_idx/u.test(message)) {
    return "An event with that name already exists on that date.";
  }
  return message || "That event could not be created.";
}
