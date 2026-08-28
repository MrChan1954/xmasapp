import assert from "node:assert/strict";
import test, { describe } from "node:test";

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { describeEventWriteError } from "./event-errors.ts";

/**
 * WHAT A FAILED EVENT WRITE SAYS TO A FAMILY.
 *
 * The old mapper matched index NAMES, migration 035 renamed two of them, and
 * its last line returned the database's own text. So a second "QA Mother's Day"
 * on the same date put this on screen, in red:
 *
 *     duplicate key value violates unique constraint
 *     "events_name_and_date_per_area_idx"
 *
 * These are the real messages, taken from the real indexes in the final schema.
 */

const dupe = (index: string) =>
  ({ message: `duplicate key value violates unique constraint "${index}"`, code: "23505" });

describe("a duplicate event is explained, never quoted", () => {
  test("SAME NAME AND DATE in one family", () => {
    const said = describeEventWriteError(dupe("events_name_and_date_per_area_idx"));
    assert.match(said, /already exists on that date/u);
    assert.doesNotMatch(said, /events_name_and_date_per_area_idx|duplicate key|constraint/iu);
  });

  test("A SECOND CHRISTMAS in the same year", () => {
    const said = describeEventWriteError(dupe("events_one_christmas_per_area_year_idx"));
    assert.match(said, /already has a Christmas for that year/u);
    assert.doesNotMatch(said, /idx|duplicate key|constraint/iu);
  });

  test("A SECOND BIRTHDAY for one person in one year", () => {
    const said = describeEventWriteError(dupe("events_one_birthday_per_person_per_year_idx"));
    assert.match(said, /already has a birthday planned for that year/u);
    assert.doesNotMatch(said, /idx|duplicate key|constraint/iu);
  });

  test("THE BRANCH THE OLD MAPPER DID NOT HAVE: an index nobody taught it about", () => {
    /*
     * This is the regression itself. The old code fell through to
     * `return message`, so any index it had not been told about -- including
     * the two it HAD been told about, after they were renamed -- reached the
     * screen verbatim. There is now no such path.
     */
    const said = describeEventWriteError(dupe("events_some_future_index_nobody_has_written_yet"));
    assert.match(said, /already exists/u);
    assert.doesNotMatch(said, /events_some_future_index|duplicate key|constraint/iu);
  });

  test("A RENAME OF THE VERY INDEX THIS FILE NAMES still says something useful", () => {
    // Fragment matching, not whole names: rename it and the wording survives.
    const renamed = describeEventWriteError(dupe("events_one_christmas_per_household_year_v2_idx"));
    assert.match(renamed, /Christmas/u);
    assert.doesNotMatch(renamed, /_idx|constraint/iu);
  });

  test("and a duplicate recognised by TEXT ALONE, for a client that drops the code", () => {
    const said = describeEventWriteError({
      message: 'duplicate key value violates unique constraint "events_one_christmas_per_area_year_idx"',
      code: null,
    });
    assert.match(said, /already has a Christmas/u);
    assert.doesNotMatch(said, /idx|duplicate key/iu);
  });
});

describe("a refusal the routine wrote itself is passed through", () => {
  /*
   * `create_event` raises sentences meant for a reader, carrying 23514, 42501
   * or P0002. Swallowing those would replace good wording with worse.
   */
  for (const [code, message] of [
    ["23514", "Choose whose birthday this is"],
    ["23514", "Enter a valid event name"],
    ["42501", "Global Admin access required to create an event"],
    ["P0002", "That family member could not be found"],
    ["23514", "A Christmas is not about one person"],
  ] as const) {
    test(`${code}: ${JSON.stringify(message)}`, () => {
      assert.equal(describeEventWriteError({ message, code }), message);
    });
  }
});

describe("machinery is never quoted, whatever code it arrives under", () => {
  test("A CHECK CONSTRAINT THAT FIRED DIRECTLY, under an authored code", () => {
    /*
     * The subtle one. 23514 is normally an authored refusal -- but a CHECK
     * firing without a `raise` behind it uses the same code and produces
     * boilerplate naming the constraint. Passing 23514 through blindly would
     * have leaked that.
     */
    const said = describeEventWriteError({
      message: 'new row for relation "events" violates check constraint "events_name_safe_check"',
      code: "23514",
    });
    assert.doesNotMatch(said, /events_name_safe_check|check constraint|new row for relation/iu);
    assert.match(said, /cannot be saved as they are/u);
  });

  test("a foreign key", () => {
    const said = describeEventWriteError({
      message: 'insert or update on table "events" violates foreign key constraint "events_celebrant_fkey"',
      code: "23503",
    });
    assert.doesNotMatch(said, /fkey|constraint|violates/iu);
    assert.match(said, /no longer exists/u);
  });

  test("a PostgREST or JWT complaint", () => {
    const said = describeEventWriteError({ message: "JWT expired", code: "PGRST301" }, "That event could not be created.");
    assert.equal(said, "That event could not be created.");
  });

  test("something with no code and no message at all", () => {
    assert.equal(describeEventWriteError(null, "That event could not be created."), "That event could not be created.");
    assert.equal(describeEventWriteError(undefined, "nope"), "nope");
    assert.equal(describeEventWriteError({ message: "", code: "" }, "nope"), "nope");
  });

  test("THE SWEEP: no input produces a message naming schema internals", () => {
    const nasty = [
      { message: 'duplicate key value violates unique constraint "events_pkey"', code: "23505" },
      { message: 'relation "events" does not exist', code: "42P01" },
      { message: 'column "area_id" does not exist', code: "42703" },
      { message: 'invalid input syntax for type uuid: "not-a-uuid"', code: "22P02" },
      { message: "permission denied for table events", code: "42501" },
      { message: 'null value in column "name" violates not-null constraint', code: "23502" },
      { message: "PGRST116: JSON object requested, multiple rows returned", code: "PGRST116" },
    ];
    for (const error of nasty) {
      const said = describeEventWriteError(error, "That event could not be created.");
      assert.doesNotMatch(said, /constraint|relation |column "|pkey|_idx|syntax|PGRST|permission denied/iu,
        `leaked internals for ${JSON.stringify(error)} -> ${said}`);
      assert.ok(said.length > 0);
    }
  });
});
