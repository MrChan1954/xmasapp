/**
 * Birthdays, as plain data and pure functions.
 *
 * TWO THINGS, KEPT APART
 *   A BIRTHDAY is a recurring calendar date belonging to a person: the 6th of
 *   November, permanently. It has no year of its own and never resets.
 *
 *   An OCCURRENCE is that birthday in one particular year: the 6th of November
 *   2027. Occurrences are DERIVED here, never stored, which is the whole reason
 *   nothing has to happen on the 1st of January for next year to work.
 *
 * A BIRTHDAY IS A CALENDAR DATE, NOT AN INSTANT
 *   Every function below works in whole days on `YYYY-MM-DD` strings. Nothing
 *   here constructs a `Date` from a timestamp, adds hours, or crosses a
 *   timezone — that is exactly how a birthday ends up a day out at half past
 *   midnight in British Summer Time. The caller supplies today's date, already
 *   resolved in the family's own timezone.
 *
 * These rules are mirrored by migration 026 in SQL, so the calendar the family
 * reads and the reminders the server sends cannot disagree.
 */

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { validateDateInput } from "./input-validation.ts";

export type Birthday = {
  /** 1-12. */
  month: number;
  /** 1-31, valid for the month. */
  day: number;
  /** Optional. The recurring date is what the calendar and reminders need. */
  year: number | null;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Days in a month, ignoring the year. February is 29 — see the leap policy. */
const MAX_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(month: number, year: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * A real calendar date. 29 February is a real birthday and is accepted; what a
 * non-leap year does with it is decided once, in `birthdayOccurrence`.
 */
export function isValidBirthday(month: unknown, day: unknown): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  const monthNumber = month as number;
  const dayNumber = day as number;
  if (monthNumber < 1 || monthNumber > 12) return false;
  return dayNumber >= 1 && dayNumber <= MAX_DAY[monthNumber - 1];
}

export function isValidBirthYear(year: unknown): boolean {
  if (year === null || year === undefined) return true;
  return Number.isInteger(year) && (year as number) >= 1900 && (year as number) <= 2200;
}

/** "6 November", the way the family writes it. */
export function formatBirthday(month: number, day: number): string {
  if (!isValidBirthday(month, day)) return "";
  return `${day} ${MONTH_NAMES[month - 1]}`;
}

/**
 * THE LEAP-DAY POLICY, DECIDED ONCE.
 *
 *   A 29 February birthday is observed on 28 FEBRUARY in a non-leap year.
 *
 * The alternative — 1 March — was rejected because it moves the birthday into
 * the following month, which reads wrong on a calendar sorted by month and
 * would put the reminder after some people had already celebrated. 28 February
 * keeps the occurrence inside February and never lands after the real date.
 *
 * Identical to `public.birthday_occurrence_date` in migration 026.
 */
export function birthdayOccurrence(month: number, day: number, year: number): string {
  const clamped = Math.min(day, daysInMonth(month, year));
  return `${year}-${pad(month)}-${pad(clamped)}`;
}

export type NextOccurrence = {
  /** ISO date of the next time this birthday comes round. */
  date: string;
  /** The calendar year of that occurrence. */
  year: number;
  /** Whole days from today. 0 means today. */
  daysAway: number;
  isToday: boolean;
};

/**
 * When this birthday next comes round, counting today as "today".
 *
 * The December-into-January case falls out of this rather than being special
 * cased: if this year's occurrence has already passed, next year's is the
 * answer, so on the 20th of December a birthday on the 5th of January is 16
 * days away and sorts ahead of one in November.
 */
export function nextBirthdayOccurrence(
  birthday: Pick<Birthday, "month" | "day">,
  today: string,
): NextOccurrence | null {
  const validToday = validateDateInput(today);
  if (!validToday.ok || !isValidBirthday(birthday.month, birthday.day)) return null;

  const currentYear = Number(validToday.value.slice(0, 4));
  const thisYear = birthdayOccurrence(birthday.month, birthday.day, currentYear);
  const date = thisYear >= validToday.value
    ? thisYear
    : birthdayOccurrence(birthday.month, birthday.day, currentYear + 1);

  const daysAway = daysBetween(validToday.value, date);
  return { date, year: Number(date.slice(0, 4)), daysAway, isToday: daysAway === 0 };
}

/** Whole days from one calendar date to another. Both are dates, never instants. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.UTC(...parts(to)) - Date.UTC(...parts(from))) / 86_400_000);
}

/**
 * "75 days away", "Tomorrow", "Today".
 *
 * A birthday happening today says so rather than reporting zero days, because
 * "0 days away" is not how anybody speaks.
 */
export function describeDaysAway(daysAway: number): string {
  if (daysAway === 0) return "Today";
  if (daysAway === 1) return "Tomorrow";
  return `${daysAway} days away`;
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export type ReminderStage = "one_week" | "one_day";

/**
 * Two stages, and nothing else.
 *
 * WHY THERE IS NO ONE-MONTH REMINDER
 *   There was, and it was removed in Checkpoint 4.1. The dashboard now shows
 *   the next few birthdays with the number of days to go, straight from the
 *   permanent date — so the long-range warning is there every time anybody
 *   opens the app, and costs nobody an interruption. A push notification a
 *   month out told the family something the front page was already telling
 *   them.
 *
 *   A reminder that interrupts should be one you would act on today. A week out
 *   is "order it now"; a day out is "have it ready". A month out is neither.
 *
 * `subtract` is how far before the occurrence the reminder is due, in whole
 * calendar days, which is exactly what PostgreSQL's `- interval '7 days'` and
 * `- interval '1 day'` do — so the server and the app agree on the day.
 */
export const REMINDER_STAGES: Array<{
  stage: ReminderStage;
  label: string;
  subtract: { months: number; days: number };
}> = [
  { stage: "one_week", label: "next week", subtract: { months: 0, days: 7 } },
  { stage: "one_day", label: "tomorrow", subtract: { months: 0, days: 1 } },
];

/**
 * How many birthdays the dashboard shows at a glance.
 *
 * Four, because that is one row on a wide screen and two on a phone: enough to
 * answer "is anything coming up?" without the front page turning into a list.
 * Everything else is one tap away on the Birthdays page, which is the full
 * system rather than the glance.
 */
export const DASHBOARD_BIRTHDAY_LIMIT = 4;

/** The person's birthday workspace: their planning, not an event id. */
export function birthdayWorkspacePath(personId: string): string {
  return `/birthdays/${personId}`;
}

/** The date a stage's reminder is due, for one occurrence. */
export function reminderDateFor(occurrenceDate: string, stage: ReminderStage): string | null {
  const entry = REMINDER_STAGES.find((candidate) => candidate.stage === stage);
  const valid = validateDateInput(occurrenceDate);
  if (!entry || !valid.ok) return null;

  // `parts` yields a ZERO-BASED month, so it can be handed straight to
  // `Date.UTC`.
  const [year, monthIndex, day] = parts(valid.value);

  // Whole calendar days. `Date.UTC` handles the month and year rollover, and
  // midday is never involved, so no timezone can shift the result. Both
  // remaining stages are day counts; there is no calendar-month arithmetic
  // left to get wrong.
  const shifted = new Date(Date.UTC(year, monthIndex, day - entry.subtract.days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Which reminder stages fall due today, for one person's birthday.
 *
 * Both this year's occurrence and next year's are considered, so a January
 * birthday is found from the previous December with no special case. Nothing is
 * ever due ON the birthday itself: the last reminder is the day before.
 */
export function dueReminderStages(
  birthday: Pick<Birthday, "month" | "day">,
  today: string,
): Array<{ stage: ReminderStage; occurrenceYear: number; occurrenceDate: string }> {
  const validToday = validateDateInput(today);
  if (!validToday.ok || !isValidBirthday(birthday.month, birthday.day)) return [];

  const currentYear = Number(validToday.value.slice(0, 4));
  const due: Array<{ stage: ReminderStage; occurrenceYear: number; occurrenceDate: string }> = [];

  for (const year of [currentYear, currentYear + 1]) {
    const occurrenceDate = birthdayOccurrence(birthday.month, birthday.day, year);
    for (const { stage } of REMINDER_STAGES) {
      if (reminderDateFor(occurrenceDate, stage) === validToday.value) {
        due.push({ stage, occurrenceYear: year, occurrenceDate });
      }
    }
  }
  return due;
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

export type PersonBirthday = {
  personId: string;
  name: string;
  birthday: Birthday | null;
};

export type UpcomingBirthday = PersonBirthday & {
  birthday: Birthday;
  next: NextOccurrence;
};

/**
 * Everyone with a birthday, ordered by when it NEXT comes round.
 *
 * Not by month number: in December, January's birthdays come first. Ties break
 * on name so the list is stable rather than dependent on row order.
 */
export function upcomingBirthdays(people: readonly PersonBirthday[], today: string): UpcomingBirthday[] {
  return people
    .flatMap((person) => {
      if (!person.birthday) return [];
      const next = nextBirthdayOccurrence(person.birthday, today);
      return next ? [{ ...person, birthday: person.birthday, next }] : [];
    })
    .sort((left, right) =>
      left.next.daysAway - right.next.daysAway
      || left.name.localeCompare(right.name, "en-GB"));
}

/** Everyone who has no birthday saved, so the family can see the gaps. */
export function peopleWithoutBirthdays(people: readonly PersonBirthday[]): PersonBirthday[] {
  return people
    .filter((person) => !person.birthday)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, "en-GB"));
}

/** The name a Birthday Event gets by default. */
export function suggestedBirthdayEventName(personName: string, year: number): string {
  const trimmed = personName.trim();
  const possessive = trimmed.endsWith("s") ? `${trimmed}'` : `${trimmed}'s`;
  return `${possessive} Birthday ${year}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function parts(isoDate: string): [number, number, number] {
  const [year, month, day] = isoDate.split("-").map(Number);
  return [year, month - 1, day];
}
