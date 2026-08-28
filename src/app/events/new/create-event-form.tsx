"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronLeft } from "lucide-react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { EVENT_PRESETS, birthdayDateLooksLikeDateOfBirth, eventTypeForTemplate, formatEventDate, validateEventInput, type EventPreset, type EventTemplate } from "@/lib/events.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { nextOccurrenceYear, occasionDateExplanation, suggestedOccasionDate } from "@/lib/uk-occasions.ts";

import { INPUT_LIMITS } from "@/lib/input-validation";
import { createClient } from "@/utils/supabase/client";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { describeEventWriteError } from "@/lib/event-errors.ts";
import { AppShell, PageHeader } from "../../components/app-shell";
import { GarlandRule } from "../../components/festive/garland";
import {
  Button, Field, Input, Notice, Textarea, cx,
} from "../../components/ui";

export type CreatablePerson = {
  personId: string;
  name: string;
  birthday: { month: number; day: number } | null;
  /**
   * May be offered as a contributor.
   *
   * Recipients come from EVERYBODY: anyone in the family can receive a gift.
   * Contributors come from the pool the Global Admin maintains, because being
   * in the family and sharing the cost are different facts.
   */
  isFamilyContributor: boolean;
};

type Step = "template" | "details" | "people" | "review";

const STEPS: Array<{ step: Step; label: string }> = [
  { step: "template", label: "Template" },
  { step: "details", label: "Details" },
  { step: "people", label: "People" },
  { step: "review", label: "Review" },
];

/**
 * The two things Create Event offers.
 *
 * There used to be seven, one per event type, and the list WAS the product: an
 * occasion the family wanted that was not on it could not be created without a
 * code change. Now there are two -- Christmas, because it genuinely behaves
 * differently, and Custom Event, which is a title and a date.
 */
const TEMPLATE_CHOICES: Array<{ template: EventTemplate; icon: string; label: string; blurb: string }> = [
  {
    template: "christmas",
    icon: "🎄",
    label: "Christmas",
    blurb: "The family's next Christmas, with the date and year filled in.",
  },
  {
    template: "custom",
    icon: "🎁",
    label: "Custom event",
    blurb: "Anything else — Halloween, Easter, a wedding, a graduation. You choose the name.",
  },
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
export function CreateEventForm({
  people,
  today,
  takenYears = {},
}: {
  people: CreatablePerson[];
  today: string;
  /** Years each recurring occasion already has an active event for. */
  takenYears?: Record<string, number[]>;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const [step, setStep] = useState<Step>("template");
  const [template, setTemplate] = useState<EventTemplate>("custom");
  /**
   * Which preset filled the date in, if one did.
   *
   * Only so the field can explain a date the user did not choose -- "Easter
   * Sunday, which moves every year". It is a note about where a SUGGESTION came
   * from, not a property of the event: nothing is stored, and the event is an
   * ordinary custom event either way.
   */
  const [datedByPreset, setDatedByPreset] = useState<string | null>(null);
  const [name, setName] = useState(params.get("name") ?? "");
  const [date, setDate] = useState(params.get("date") ?? "");
  const [description, setDescription] = useState("");
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [contributorIds, setContributorIds] = useState<string[]>(
    people.map((person) => person.personId),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The stored type follows from the template, and is never chosen directly.
   *
   * A custom event is `other` -- a value the database has accepted since
   * migration 025 -- so "Halloween" needs no new type, no CHECK constraint and
   * no migration. The event's own NAME is its identity everywhere it is shown.
   */
  const type = eventTypeForTemplate(template);

  /**
   * Sensible defaults, offered rather than imposed: everything below is a
   * starting point the admin can overwrite before saving.
   */
  // Everyone can receive; only the pool can contribute.
  const contributorPool = people.filter((person) => person.isFamilyContributor);

  const chooseTemplate = (next: EventTemplate) => {
    setTemplate(next);
    setError(null);
    setDatedByPreset(next === "christmas" ? "christmas" : null);
    setRecipientIds([]);
    setContributorIds(contributorPool.map((person) => person.personId));

    if (next === "christmas") {
      // The NEXT Christmas that has not happened and is not already planned.
      // Defaulting to the current calendar year is wrong from Boxing Day
      // onwards, and the database refuses a second Christmas for a year that
      // already has one -- so the form offers the one that will actually save.
      const year = nextOccurrenceYear("christmas", today, takenYears.christmas ?? [])
        ?? Number(today.slice(0, 4));
      setName(`Christmas ${year}`);
      setDate(`${year}-12-25`);
      return;
    }

    // A custom event starts EMPTY. Suggesting a name would be guessing at an
    // occasion the family has not told us about yet, and the whole point is
    // that they get to say.
    setName("");
    setDate("");
  };

  /**
   * A preset fills in two fields, and does nothing else.
   *
   * The event it produces is an ordinary custom event -- same stored type, same
   * behaviour, same everything -- as though the title had been typed by hand.
   * That is the difference between a convenience and a structural type, and it
   * is why "Easter" and "Halloween" are the same kind of thing to this form
   * even though only one of them has a computable date.
   */
  const applyPreset = (preset: EventPreset) => {
    setError(null);
    const year = nextOccurrenceYear(preset.occasion, today, takenYears[preset.occasion] ?? [])
      ?? Number(today.slice(0, 4));
    const suggested = suggestedOccasionDate(preset.occasion, year);
    setName(`${preset.title} ${year}`);
    if (suggested) setDate(suggested);
    setDatedByPreset(preset.occasion);
  };

  const validation = useMemo(() => validateEventInput({
    name,
    type,
    eventDate: date,
    // A generic event is not about one named person. Only a birthday is, and a
    // birthday is never created here.
    celebrantPersonId: null,
  }), [date, name, type]);

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
      setError(describeEventWriteError(result.error, "That event could not be created."));
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
        eyebrow="Family admin"
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

      {step === "template" && (
        <section className="mt-6">
          <h2 className="font-display text-xl font-semibold text-ink-900">What are you planning?</h2>
          <p className="mt-1.5 text-sm leading-6 text-ink-600">
            Birthdays are not here on purpose: a birthday belongs to a person, so start one
            from{" "}
            <Link href="/birthdays" className="font-semibold underline">Birthdays</Link>, where the
            date is already known. Everything else is a custom event — name it whatever the
            family calls it.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {TEMPLATE_CHOICES.map((choice) => (
              <button
                key={choice.template}
                type="button"
                onClick={() => { chooseTemplate(choice.template); setStep("details"); }}
                className={cx(
                  "flex min-h-16 flex-col gap-1 rounded-2xl border border-line bg-surface px-4 py-3.5 text-left",
                  "hover:border-accent/40 hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                )}
              >
                <span className="flex items-center gap-3">
                  <span aria-hidden className="text-2xl leading-none">{choice.icon}</span>
                  <span className="font-display text-base font-semibold text-ink-900">{choice.label}</span>
                </span>
                <span className="text-xs leading-5 text-ink-600">{choice.blurb}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === "details" && (
        <section className="mt-6 space-y-4">
          <h2 className="font-display text-xl font-semibold text-ink-900">
            {template === "christmas" ? "🎄 Christmas details" : "🎁 Event details"}
          </h2>

          {/* Presets are a shortcut to two fields, offered only where they
              help. They are not a list of the occasions the app supports:
              anything typed into the box below works exactly as well, which is
              why Halloween is not among them. */}
          {template === "custom" && (
            <div>
              <p className="text-xs font-semibold tracking-eyebrow text-ink-600 uppercase">
                Quick start
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {EVENT_PRESETS.map((preset) => (
                  <button
                    key={preset.occasion}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className={cx(
                      "inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink-900",
                      "hover:border-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    )}
                  >
                    <span aria-hidden>{preset.icon}</span>
                    {preset.title}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs leading-5 text-ink-600">
                Or just type a name — Halloween, a graduation, a leaving do, anything.
              </p>
            </div>
          )}

          <Field label="Event name" required>
            <Input
              value={name}
              maxLength={INPUT_LIMITS.name}
              onChange={(event) => setName(event.target.value)}
              placeholder={template === "christmas" ? "Christmas" : "Halloween"}
            />
          </Field>

          {/* The explanation follows the PRESET, not the event type: a custom
              event has no formula, and one dated from the Easter preset should
              still say where that date came from. Editing the date by hand
              clears it, because it is then the user's date and not a
              suggestion. */}
          <Field
            label="Date"
            required
            hint={(datedByPreset ? occasionDateExplanation(datedByPreset) : null) ?? undefined}
          >
            <Input
              type="date"
              value={date}
              onChange={(event) => { setDate(event.target.value); setDatedByPreset(null); }}
            />
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
            <Button variant="ghost" className="min-h-11" onClick={() => setStep("template")}>
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
          {/* Only the family's contributor pool. The recipient picker above
              comes from everybody, because anyone can receive a gift. */}
          <PeoplePicker
            title="Who is chipping in?"
            hint={contributorPool.length === 0
              ? "Nobody is set up as a family contributor yet. Add somebody in Family access first."
              : "Contributors share the cost of every purchase in this event."}
            people={contributorPool}
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
              {template === "christmas" ? "🎄 Christmas" : "🎁 Custom event"}
            </p>
            <h2 className="mt-1.5 font-display text-2xl font-semibold break-words text-ink-900">
              {validation.value.name}
            </h2>
            <p className="mt-1 text-sm text-ink-600">{formatEventDate(validation.value.eventDate)}</p>
            <dl className="mt-4 space-y-1.5 text-sm">

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

/*
 * WHAT A FAILED CREATE IS ALLOWED TO SAY.
 *
 * There used to be a `friendlyCreateError` here, and it matched on index NAMES:
 * `events_name_and_date_unique_idx` and `events_one_christmas_per_year_idx`.
 * Migration 035 renamed both when uniqueness became per-Area, so two of its
 * three branches were dead, and its last line returned the database's own text
 * -- which is how `duplicate key value violates unique constraint "..."` ended
 * up on screen in production.
 *
 * It is gone. `describeEventWriteError` decides by SQLSTATE, refines the
 * wording with a name FRAGMENT rather than a whole name, and has no path that
 * returns raw database text. It is unit-tested, which this never was.
 */
