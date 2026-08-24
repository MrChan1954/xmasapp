/**
 * The dates British occasions actually fall on.
 *
 * WHY THIS EXISTS
 *   Mother's Day and Father's Day move every year, and Mother's Day in
 *   particular is the one people get wrong: the American second Sunday in May
 *   is not the British date and never has been. In the UK, Mother's Day is
 *   MOTHERING SUNDAY — the fourth Sunday of Lent, which is three weeks before
 *   Easter Sunday, and therefore moves with Easter between early March and
 *   early April.
 *
 *   Asking somebody to look it up and type it in is how "Easter 2026" ended up
 *   dated in 2027. So the app works it out and offers it; the admin confirms or
 *   changes it, and nothing here is written to the database on its own.
 *
 * EVERY FUNCTION IS PURE AND DETERMINISTIC
 *   A year in, a `YYYY-MM-DD` out. No clock, no timezone, no locale. That is
 *   what makes these testable against dates that can be checked in a diary.
 */

/** Years these calculations are meaningful for. Gregorian, and not absurd. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isSupportedYear(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR;
}

/**
 * Easter Sunday, Gregorian calendar.
 *
 * The anonymous Gregorian algorithm (Meeus/Jones/Butcher). It is pure integer
 * arithmetic with no lookup table, so it is right for every year in range
 * rather than for the handful somebody remembered to tabulate.
 *
 * Spot-checkable against any diary: 2024-03-31, 2025-04-20, 2026-04-05,
 * 2027-03-28, 2028-04-16.
 */
export function easterSunday(year: number): string | null {
  if (!isSupportedYear(year)) return null;

  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Mothering Sunday — Mother's Day in the United Kingdom.
 *
 * The fourth Sunday of Lent, which is exactly 21 days before Easter Sunday.
 * Because Easter is always a Sunday, subtracting three whole weeks lands on a
 * Sunday too, with no day-of-week arithmetic needed.
 *
 * NOT the second Sunday in May. That is the American Mother's Day, and using it
 * here would put the family's shopping three months late in some years.
 */
export function motheringSunday(year: number): string | null {
  const easter = easterSunday(year);
  if (!easter) return null;

  const [easterYear, easterMonth, easterDay] = easter.split("-").map(Number);
  // `Date.UTC` handles the rollover from April back into March, and midday is
  // never involved, so no timezone can shift the result.
  const date = new Date(Date.UTC(easterYear, easterMonth - 1, easterDay - 21));
  return date.toISOString().slice(0, 10);
}

/**
 * Father's Day in the United Kingdom: the third Sunday in June.
 *
 * The same date as the American one, but arrived at independently — this is the
 * British rule, and it is written out rather than shared with Mother's Day
 * precisely so that nobody later "simplifies" the two into one wrong formula.
 */
export function fathersDay(year: number): string | null {
  if (!isSupportedYear(year)) return null;

  // 0 = Sunday. The first Sunday is however many days it takes to reach one
  // from the 1st; the third is fourteen days after that.
  const firstOfJune = new Date(Date.UTC(year, 5, 1));
  const daysToFirstSunday = (7 - firstOfJune.getUTCDay()) % 7;
  const day = 1 + daysToFirstSunday + 14;
  return `${year}-06-${pad(day)}`;
}

/**
 * The date to offer for one occasion in one year, or null where the occasion
 * has no fixed rule.
 *
 * A SUGGESTION, NEVER A DECISION. The Create Event form fills the date field
 * with this and the admin may change it before anything is created — a wedding
 * has no formula, and a family may well mark Mother's Day on a different day
 * because that is when everyone can get together.
 */
export function suggestedOccasionDate(eventType: string, year: number): string | null {
  if (!isSupportedYear(year)) return null;
  if (eventType === "mothers_day") return motheringSunday(year);
  if (eventType === "fathers_day") return fathersDay(year);
  if (eventType === "easter") return easterSunday(year);
  if (eventType === "christmas") return `${year}-12-25`;
  return null;
}

/**
 * The year to offer for a recurring occasion: the NEXT one that has not
 * happened yet.
 *
 * Defaulting to the current calendar year is wrong for most of the year. On the
 * 24th of August 2026, Mother's Day 2026 was five months ago — offering it
 * means the admin has to notice and correct it, and the year/date validation
 * then refuses whatever they half-corrected.
 *
 * @param today the family's own calendar date, `YYYY-MM-DD`
 * @param taken years already used by an active occasion of this type, so the
 *   wizard proposes the next AVAILABLE one rather than a duplicate the
 *   database would refuse
 */
export function nextOccurrenceYear(
  eventType: string,
  today: string,
  taken: readonly number[] = [],
): number | null {
  const valid = /^\d{4}-\d{2}-\d{2}$/u.test(today) ? today : null;
  if (!valid) return null;

  const thisYear = Number(valid.slice(0, 4));
  const unavailable = new Set(taken);

  // Look forward from this year. A recurring occasion always has a date in
  // every year, so this terminates on the first year that is both still to
  // come and not already planned.
  for (let year = thisYear; year <= thisYear + 25; year += 1) {
    const date = suggestedOccasionDate(eventType, year);
    if (!date) return unavailable.has(year) ? null : year;
    // TODAY still counts as upcoming: a family planning on the morning of
    // Christmas Day is planning for that Christmas.
    if (date >= valid && !unavailable.has(year)) return year;
  }
  return null;
}

/** How the suggestion is explained on the form, so it is not a magic date. */
export function occasionDateExplanation(eventType: string): string | null {
  if (eventType === "mothers_day") {
    return "Mothering Sunday — the fourth Sunday of Lent, three weeks before Easter. Change it if the family is marking it on a different day.";
  }
  if (eventType === "fathers_day") {
    return "The third Sunday in June. Change it if the family is marking it on a different day.";
  }
  if (eventType === "easter") return "Easter Sunday. Change it if you are planning around a different day.";
  if (eventType === "christmas") return "Christmas Day.";
  return null;
}
