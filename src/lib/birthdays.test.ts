import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { REMINDER_STAGES, birthdayOccurrence, describeDaysAway, dueReminderStages, formatBirthday, isValidBirthday, isValidBirthYear, nextBirthdayOccurrence, peopleWithoutBirthdays, suggestedBirthdayEventName, upcomingBirthdays, type PersonBirthday } from "./birthdays.ts";

// ---------------------------------------------------------------------------
// What this file is for
//
// A birthday is stored once and never edited again, so every date the app
// shows is DERIVED: which year the next one falls in, how many days away it
// is, and which reminders are due today. Derivation is where the bugs live.
//
// The same derivation exists twice -- here in TypeScript for the screens, and
// in SQL for the reminder sweep -- so these tests also pin the shared rules
// that `birthday_occurrence_date()` and `due_birthday_reminders()` implement.
// If one side changes, this file has to change with it.
// ---------------------------------------------------------------------------

/**
 * The occurrence, with the "this input was rejected" case turned into a failed
 * test rather than a silently skipped one.
 */
const occurrence = (birthday: { month: number; day: number }, today: string) => {
  const next = nextBirthdayOccurrence(birthday, today);
  assert.ok(next, `${today} must produce an occurrence for ${birthday.month}/${birthday.day}`);
  return next;
};

const person = (
  personId: string,
  name: string,
  birthday: { month: number; day: number; year?: number | null } | null,
): PersonBirthday => ({
  personId,
  name,
  birthday: birthday ? { month: birthday.month, day: birthday.day, year: birthday.year ?? null } : null,
});

// ---------------------------------------------------------------------------
// 1. The occurrence itself
// ---------------------------------------------------------------------------

test("a birthday occurs on the same day of the same month in any year asked for", () => {
  assert.equal(birthdayOccurrence(11, 6, 2026), "2026-11-06");
  assert.equal(birthdayOccurrence(11, 6, 2027), "2027-11-06");
  assert.equal(birthdayOccurrence(11, 6, 2099), "2099-11-06");
  // Single digits are padded, because these strings are compared and stored.
  assert.equal(birthdayOccurrence(1, 1, 2026), "2026-01-01");
  assert.equal(birthdayOccurrence(12, 31, 2026), "2026-12-31");
});

test("29 February is observed on 28 February in a year that does not have one", () => {
  // The policy, stated once: the birthday is not skipped and never rolls into
  // March. It is OBSERVED on the last day February actually has.
  assert.equal(birthdayOccurrence(2, 29, 2028), "2028-02-29", "a leap year keeps the real date");
  assert.equal(birthdayOccurrence(2, 29, 2027), "2027-02-28", "a common year observes it a day early");
  assert.equal(birthdayOccurrence(2, 29, 2100), "2100-02-28", "1900-style century rule: 2100 is not a leap year");
  assert.equal(birthdayOccurrence(2, 29, 2000), "2000-02-29", "2000 IS a leap year");
});

test("the 31st is observed on the last day of a shorter month", () => {
  // No stored birthday can be 31 April -- the database rejects it -- but the
  // clamp is what makes the leap rule above a rule rather than a special case.
  assert.equal(birthdayOccurrence(4, 31, 2026), "2026-04-30");
});

// ---------------------------------------------------------------------------
// 2. Which occurrence is next -- the "no January reset" property
// ---------------------------------------------------------------------------

test("the next occurrence rolls into next year only once this year's has passed", () => {
  const nov6 = { month: 11, day: 6 };

  // Before it: this year.
  assert.equal(occurrence(nov6, "2026-08-23").date, "2026-11-06");
  // The day itself: today, not next year. A birthday is not "past" at 00:00.
  const onTheDay = occurrence(nov6, "2026-11-06");
  assert.equal(onTheDay.date, "2026-11-06");
  assert.equal(onTheDay.daysAway, 0);
  assert.equal(onTheDay.isToday, true);
  // The day after: next year.
  assert.equal(occurrence(nov6, "2026-11-07").date, "2027-11-06");
});

test("nothing is reset, cleared or recreated when the calendar year turns", () => {
  // THE REGRESSION THIS FILE EXISTS FOR.
  //
  // A "January reset" would mean the year rolling over destroys something --
  // clearing reminders, blanking a date, or recreating rows. It cannot happen
  // here, because there is nothing to reset: the stored value is (month, day)
  // and every year is computed from today. The same input gives the right
  // answer on both sides of midnight on 1 January without anything being run.
  const nov6 = { month: 11, day: 6 };
  assert.equal(occurrence(nov6, "2026-12-31").date, "2027-11-06");
  assert.equal(occurrence(nov6, "2027-01-01").date, "2027-11-06");
  assert.equal(occurrence(nov6, "2027-01-02").date, "2027-11-06");

  // And a January birthday behaves the same way across the same boundary.
  const jan3 = { month: 1, day: 3 };
  assert.equal(occurrence(jan3, "2026-12-31").date, "2027-01-03");
  assert.equal(occurrence(jan3, "2027-01-03").date, "2027-01-03");
  assert.equal(occurrence(jan3, "2027-01-04").date, "2028-01-03");

  // Ten years of the same stored value, with no maintenance step in between.
  for (let year = 2026; year <= 2036; year += 1) {
    assert.equal(
      occurrence(nov6, `${year}-01-01`).date,
      `${year}-11-06`,
      `the ${year} occurrence is derived, not stored`,
    );
  }
});

test("days away is counted in whole days and never goes negative", () => {
  const nov6 = { month: 11, day: 6 };
  assert.equal(occurrence(nov6, "2026-11-05").daysAway, 1);
  assert.equal(occurrence(nov6, "2026-10-30").daysAway, 7);
  assert.equal(occurrence(nov6, "2026-10-06").daysAway, 31);
  assert.equal(occurrence(nov6, "2026-11-07").daysAway, 364);
  for (const today of ["2026-01-01", "2026-11-06", "2026-11-07", "2026-12-31"]) {
    assert.ok(occurrence(nov6, today).daysAway >= 0, `${today} must not be negative`);
  }
});

// ---------------------------------------------------------------------------
// 3. Reminder stages
// ---------------------------------------------------------------------------

test("there are exactly three reminder stages: one month, one week, one day", () => {
  // Checkpoint 4 says three and only three. A fourth would mean a fourth push
  // notification per birthday per year, which nobody asked for.
  assert.deepEqual(REMINDER_STAGES.map((s: { stage: string }) => s.stage), ["one_month", "one_week", "one_day"]);
});

test("each stage fires on its own day and no other", () => {
  const nov6 = { month: 11, day: 6 };
  const stagesOn = (today: string) =>
    dueReminderStages(nov6, today).map((due: { stage: string }) => due.stage);

  assert.deepEqual(stagesOn("2026-10-06"), ["one_month"]);
  assert.deepEqual(stagesOn("2026-10-30"), ["one_week"]);
  assert.deepEqual(stagesOn("2026-11-05"), ["one_day"]);

  // Every other day in the run-up is silent.
  for (const quiet of ["2026-10-05", "2026-10-07", "2026-10-29", "2026-10-31", "2026-11-04", "2026-11-06", "2026-11-07"]) {
    assert.deepEqual(stagesOn(quiet), [], `${quiet} must send nothing`);
  }
});

test("a stage that lands on a day the month does not have still fires exactly once", () => {
  // 31 March minus one month is 31 February. The rule is the same clamp as the
  // leap rule: the reminder is observed on the last day the month has.
  const mar31 = { month: 3, day: 31 };
  assert.deepEqual(dueReminderStages(mar31, "2026-02-28").map((d: { stage: string }) => d.stage), ["one_month"]);
  assert.deepEqual(dueReminderStages(mar31, "2026-03-01").map((d: { stage: string }) => d.stage), []);
  // ...and only once: a clamped date must not also match the day before it.
  assert.deepEqual(dueReminderStages(mar31, "2026-02-27").map((d: { stage: string }) => d.stage), []);
});

test("a reminder identifies the occurrence YEAR, which is what makes it once-a-year", () => {
  // The database's uniqueness is (person, occurrence_year, stage). If the year
  // reported here were the calendar year rather than the occurrence year, a
  // reminder for a January birthday sent in December would collide with the
  // one sent the following December, and the second would be swallowed.
  const jan3 = { month: 1, day: 3 };
  const [december] = dueReminderStages(jan3, "2026-12-03");
  assert.equal(december.stage, "one_month");
  assert.equal(december.occurrenceYear, 2027, "the December reminder belongs to the 2027 birthday");
  assert.equal(december.occurrenceDate, "2027-01-03");

  const [nextDecember] = dueReminderStages(jan3, "2027-12-03");
  assert.equal(nextDecember.occurrenceYear, 2028, "next year's is a different row, so it is not deduped away");
});

test("29 February reminders are counted from the observed date", () => {
  const feb29 = { month: 2, day: 29 };
  // 2027 observes it on the 28th, so a month before is 28 January.
  assert.deepEqual(dueReminderStages(feb29, "2027-01-28").map((d: { stage: string }) => d.stage), ["one_month"]);
  assert.deepEqual(dueReminderStages(feb29, "2027-02-27").map((d: { stage: string }) => d.stage), ["one_day"]);
  // 2028 has the real date, so a day before is the 28th.
  assert.deepEqual(dueReminderStages(feb29, "2028-02-28").map((d: { stage: string }) => d.stage), ["one_day"]);
});

// ---------------------------------------------------------------------------
// 4. The list the calendar screen renders
// ---------------------------------------------------------------------------

test("upcoming birthdays are ordered by how soon they are, not by name or month", () => {
  const people = [
    person("a", "Ana", { month: 1, day: 3 }),
    person("b", "Ben", { month: 11, day: 6 }),
    person("c", "Cara", { month: 9, day: 1 }),
    person("d", "Dev", null),
  ];
  const order = upcomingBirthdays(people, "2026-08-23").map((entry: { name: string }) => entry.name);
  assert.deepEqual(order, ["Cara", "Ben", "Ana"], "September, then November, then next January");
  assert.ok(!order.includes("Dev"), "somebody with no birthday is not in the list");

  // The order changes with the date, without any stored value changing.
  const later = upcomingBirthdays(people, "2026-11-07").map((entry: { name: string }) => entry.name);
  assert.deepEqual(later, ["Ana", "Cara", "Ben"]);
});

test("people without a birthday are listed separately so they can be filled in", () => {
  const people = [
    person("a", "Ana", { month: 1, day: 3 }),
    person("d", "Dev", null),
    person("e", "Eve", null),
  ];
  assert.deepEqual(
    peopleWithoutBirthdays(people).map((entry: { name: string }) => entry.name),
    ["Dev", "Eve"],
  );
});

test("today's birthday sorts first and is marked as today", () => {
  const people = [
    person("a", "Ana", { month: 8, day: 24 }),
    person("b", "Ben", { month: 8, day: 23 }),
  ];
  const [first, second] = upcomingBirthdays(people, "2026-08-23");
  assert.equal(first.name, "Ben");
  assert.equal(first.next.isToday, true);
  assert.equal(second.next.isToday, false);
});

// ---------------------------------------------------------------------------
// 5. Input the app will accept
// ---------------------------------------------------------------------------

test("only real calendar dates are accepted, and 29 February is one of them", () => {
  assert.equal(isValidBirthday(11, 6), true);
  assert.equal(isValidBirthday(2, 29), true, "stored without a year, so it is always valid");
  assert.equal(isValidBirthday(2, 30), false);
  assert.equal(isValidBirthday(4, 31), false);
  assert.equal(isValidBirthday(13, 1), false);
  assert.equal(isValidBirthday(0, 1), false);
  assert.equal(isValidBirthday(1, 0), false);
  assert.equal(isValidBirthday(null, null), false);
  assert.equal(isValidBirthday(1.5, 1), false, "no fractional months");
  assert.equal(isValidBirthday(Number.NaN, 1), false);
});

test("the year of birth is optional, and refuses impossible values", () => {
  assert.equal(isValidBirthYear(null), true, "optional");
  assert.equal(isValidBirthYear(1998), true);
  assert.equal(isValidBirthYear(1899), false);
  assert.equal(isValidBirthYear(3000), false);
  assert.equal(isValidBirthYear(1998.5), false);
});

// ---------------------------------------------------------------------------
// 6. Copy
// ---------------------------------------------------------------------------

test("dates and distances are written the way a person would say them", () => {
  assert.equal(formatBirthday(11, 6), "6 November");
  assert.equal(formatBirthday(1, 1), "1 January");
  assert.equal(describeDaysAway(0), "Today");
  assert.equal(describeDaysAway(1), "Tomorrow");
  assert.equal(describeDaysAway(2), "2 days away");
  assert.equal(describeDaysAway(7), "7 days away");
  assert.equal(describeDaysAway(31), "31 days away");
});

test("a suggested event name says whose birthday and which year", () => {
  assert.equal(suggestedBirthdayEventName("Robin", 2026), "Robin's Birthday 2026");
  // A name that already ends in s keeps its own possessive.
  assert.equal(suggestedBirthdayEventName("James", 2026), "James' Birthday 2026");
});

// ---------------------------------------------------------------------------
// 7. The model holds no birthdays of its own
// ---------------------------------------------------------------------------

test("no real family birthday is hard-coded anywhere in this module", () => {
  // Checkpoint 4's standing instruction: the real dates are entered through
  // the app by an authorised user and live only in the database. This module
  // computes; it does not know anybody.
  //
  // The test reads the source rather than the exports, because a hard-coded
  // date would most likely arrive as a "helpful" default or example constant.
  const text = readFileSync(new URL("./birthdays.ts", import.meta.url), "utf8");
  assert.doesNotMatch(text, /Paige/iu, "no family member is named in the model");
  assert.doesNotMatch(
    text,
    /(month|day)\s*[:=]\s*(?!0\b)\d+\s*,\s*(month|day)\s*[:=]\s*\d+/u,
    "no month/day pair is baked in as a default",
  );
});
