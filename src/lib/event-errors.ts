/**
 * WHAT AN EVENT WRITE IS ALLOWED TO SAY WHEN IT FAILS.
 *
 * THE BUG THIS FIXES. Creating a second event with the same name and date put
 * this on the screen, in red, to an ordinary person planning Christmas:
 *
 *     duplicate key value violates unique constraint
 *     "events_name_and_date_per_area_idx"
 *
 * The wizard did have friendly wording for that case. It matched on the index
 * NAME -- `events_name_and_date_unique_idx` -- and migration 035 renamed the
 * index when uniqueness became per-Area. The branch stopped matching, nothing
 * else caught it, and the final line of the mapper returned the database's own
 * message verbatim. The Christmas branch was stale in the same way and for the
 * same reason. Two dead branches, no test, and a raw index name shipped to
 * production.
 *
 * SO THIS FILE IS BUILT THE OTHER WAY UP.
 *
 *   1. THE SQLSTATE DECIDES THE CATEGORY, not a string. `23505` is a duplicate
 *      whatever the index is called.
 *   2. THE INDEX NAME ONLY REFINES THE WORDING, and only through a fragment
 *      ("birthday", "christmas") rather than a full name, so a future rename
 *      degrades to a general sentence instead of falling through to raw text.
 *   3. THERE IS NO PATH THAT RETURNS RAW DATABASE TEXT. The last line is a
 *      fixed sentence. A constraint nobody has thought about yet is still
 *      readable, and still says nothing about the schema.
 *
 * WHAT IT DELIBERATELY DOES NOT SWALLOW. The event routines raise their own
 * refusals -- "Choose whose birthday this is", "Global Admin access required to
 * create an event" -- as authored sentences carrying `23514`, `42501` or
 * `P0002`. Those are better than anything this file could invent, so they are
 * passed through. What is never passed through is DRIVER BOILERPLATE, which can
 * arrive under those same codes when a CHECK constraint fires directly rather
 * than through a `raise`.
 */

/** The shape both `supabase-js` errors and thrown objects arrive in. */
export type EventWriteError = {
  message?: string | null;
  code?: string | null;
} | null | undefined;

/**
 * Sentences PostgreSQL and PostgREST write about themselves.
 *
 * Anything matching this is machinery talking, not a person: it names tables,
 * columns, constraints or types, and none of that belongs on a family's screen.
 */
const DATABASE_BOILERPLATE =
  /duplicate key value|violates [a-z-]* ?constraint|new row for relation|null value in column|invalid input syntax|invalid text representation|permission denied for|out of range|syntax error at|relation ".*" does not exist|column ".*" does not exist|JWT|PGRST/iu;

/**
 * Codes whose message the ROUTINES author for a reader.
 *
 * `P0001` is a bare `raise exception`; the rest are the codes the event
 * routines choose deliberately when refusing.
 */
const AUTHORED_CODES = new Set(["P0001", "P0002", "23514", "42501"]);

/** One duplicate, said the way the family would say it. */
function describeDuplicate(message: string): string {
  // A BIRTHDAY, one per person per year -- `events_one_birthday_per_person_per_year_idx`.
  if (/birthday/iu.test(message)) {
    return "That person already has a birthday planned for that year. Open the one that already exists instead of starting a second.";
  }
  // A CHRISTMAS, one per family per year -- `events_one_christmas_per_area_year_idx`.
  if (/christmas/iu.test(message)) {
    return "This family already has a Christmas for that year. Open the one that already exists instead of starting a second.";
  }
  // NAME AND DATE, unique per family -- `events_name_and_date_per_area_idx`.
  if (/name_and_date|name.*date/iu.test(message)) {
    return "An event with that name already exists on that date. Give this one a different name, or a different date.";
  }
  /*
   * A UNIQUE INDEX THIS FILE HAS NOT BEEN TAUGHT ABOUT.
   *
   * This is the line the old mapper did not have, and the whole reason a raw
   * index name reached a user. It is deliberately vague and deliberately
   * final: a sentence nobody has to decode, and nothing about the schema.
   */
  return "That already exists, so it was not created again.";
}

/**
 * Turn a failed event write into something worth reading.
 *
 * `fallback` is used when there is nothing safe to say -- pass one that suits
 * the screen ("This event could not be created", "That change could not be
 * saved") rather than relying on a generic default.
 */
export function describeEventWriteError(
  error: EventWriteError,
  fallback = "That change could not be saved. Nothing was altered.",
): string {
  const message = typeof error?.message === "string" ? error.message : "";
  const code = typeof error?.code === "string" ? error.code : "";

  // 1. A DUPLICATE, decided by SQLSTATE first and text only as a fallback for
  //    clients that do not surface the code.
  if (code === "23505" || /duplicate key value/iu.test(message)) {
    return describeDuplicate(message);
  }

  // 2. A REFUSAL THE ROUTINE WROTE ITSELF, which is already in plain English.
  //    Boilerplate under the same code -- a CHECK firing directly -- is not.
  if (AUTHORED_CODES.has(code) && message && !DATABASE_BOILERPLATE.test(message)) {
    return message;
  }

  // 3. A CHECK CONSTRAINT THAT FIRED WITHOUT A `raise` BEHIND IT.
  if (code === "23514") {
    return "Some of those details cannot be saved as they are. Check the name, the date and the description.";
  }

  // 4. A FOREIGN KEY: something referenced has gone.
  if (code === "23503") {
    return "Something this event refers to no longer exists. Reload the page and try again.";
  }

  // 5. ANYTHING ELSE. No raw text ever leaves this function.
  return fallback;
}
