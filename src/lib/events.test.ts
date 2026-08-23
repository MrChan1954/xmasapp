import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { EVENT_SECTIONS, EVENT_TYPES, defaultEventSetup, eventDisplayName, eventIdFromPath, eventPath, eventTypeMeta, formatEventDate, isEventStatus, isEventType, partitionEvents, validateEventInput, type EventSummary } from "./events.ts";

/**
 * The Event model, on its own.
 *
 * These are the rules the rest of the multi-event work is built on: an event
 * type changes an icon and a set of setup defaults and NOTHING about money;
 * event context lives in the URL so a refresh keeps it; and every rule the
 * database enforces is refused here first with a sentence somebody can act on.
 */

const CHRISTMAS = "11111111-1111-4111-8111-111111111111";
const BIRTHDAY = "22222222-2222-4222-8222-222222222222";
const EASTER = "33333333-3333-4333-8333-333333333333";
const PAIGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function event(overrides: Partial<EventSummary> & Pick<EventSummary, "id" | "name" | "type" | "eventDate">): EventSummary {
  return {
    status: "active",
    year: null,
    celebrantPersonId: null,
    description: null,
    ...overrides,
  };
}

test("every event type has an icon and a label, and an unknown one still renders", () => {
  for (const type of EVENT_TYPES) {
    const meta = eventTypeMeta(type);
    assert.equal(meta.type, type);
    assert.ok(meta.label.length > 0, `${type} needs a label`);
    assert.ok(meta.icon.length > 0, `${type} needs an icon`);
  }

  // A type added to the database by a later migration must never blank out a
  // card in a build that predates it.
  const unknown = eventTypeMeta("jubilee");
  assert.equal(unknown.icon.length > 0, true);
  assert.equal(unknown.label.length > 0, true);

  assert.equal(isEventType("birthday"), true);
  assert.equal(isEventType("jubilee"), false);
  assert.equal(isEventStatus("archived"), true);
  assert.equal(isEventStatus("deleted"), false);
});

test("a birthday is somebody's, and Christmas is nobody's", () => {
  assert.equal(eventTypeMeta("birthday").requiresCelebrant, true);
  assert.equal(eventTypeMeta("christmas").allowsCelebrant, false);
  assert.equal(eventTypeMeta("easter").allowsCelebrant, false);
});

test("the birthday person receives, and does not pay for their own present", () => {
  const setup = defaultEventSetup("birthday", PAIGE);
  assert.deepEqual(setup.recipientPersonIds, [PAIGE]);
  assert.deepEqual(setup.excludedContributorPersonIds, [PAIGE]);
});

test("Christmas starts with nobody singled out", () => {
  const setup = defaultEventSetup("christmas", PAIGE);
  assert.deepEqual(setup.recipientPersonIds, []);
  assert.deepEqual(setup.excludedContributorPersonIds, []);
});

test("setup defaults are a starting position, not a rule", () => {
  // The function returns data. Nothing here forces the admin's hand: a caller
  // is free to hand the exact opposite lists to the setup screen, and this
  // asserts that the shape allows it rather than asserting a hidden branch.
  const setup = defaultEventSetup("birthday", PAIGE);
  const overridden = {
    recipientPersonIds: [...setup.recipientPersonIds, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    excludedContributorPersonIds: [] as string[],
  };
  assert.equal(overridden.recipientPersonIds.length, 2);
  assert.deepEqual(overridden.excludedContributorPersonIds, []);
});

test("a malformed celebrant produces no defaults rather than a broken one", () => {
  assert.deepEqual(defaultEventSetup("birthday", "not-a-uuid"), {
    recipientPersonIds: [],
    excludedContributorPersonIds: [],
  });
  assert.deepEqual(defaultEventSetup("birthday", null), {
    recipientPersonIds: [],
    excludedContributorPersonIds: [],
  });
});

test("event context lives in the URL, so a refresh or a shared link keeps it", () => {
  assert.equal(eventPath(CHRISTMAS), `/events/${CHRISTMAS}`);
  for (const section of EVENT_SECTIONS) {
    const path = eventPath(CHRISTMAS, section);
    assert.ok(path, `${section} must have a path`);
    assert.ok(path.startsWith(`/events/${CHRISTMAS}`));
    assert.equal(eventIdFromPath(path), CHRISTMAS);
  }
  assert.equal(eventPath(CHRISTMAS, "owed"), `/events/${CHRISTMAS}/owed`);
});

test("an id can never smuggle a path segment or produce /events/undefined", () => {
  assert.equal(eventPath(""), null);
  assert.equal(eventPath("../../admin"), null);
  assert.equal(eventPath("undefined"), null);
  assert.equal(eventPath(`${CHRISTMAS}/../other`), null);
  // @ts-expect-error the section list is closed on purpose
  assert.equal(eventPath(CHRISTMAS, "billing"), null);
});

test("reading the event out of a path ignores queries and fragments, and refuses anything else", () => {
  assert.equal(eventIdFromPath(`/events/${CHRISTMAS}/owed?tab=all`), CHRISTMAS);
  assert.equal(eventIdFromPath(`/events/${CHRISTMAS}#top`), CHRISTMAS);
  assert.equal(eventIdFromPath("/events"), null);
  assert.equal(eventIdFromPath("/people"), null);
  assert.equal(eventIdFromPath("/events/not-a-uuid"), null);
  assert.equal(eventIdFromPath("https://example.com/events/" + CHRISTMAS), null);
});

test("dates read the way the family writes them, and never shift by a timezone", () => {
  assert.equal(formatEventDate("2026-12-25"), "25 December 2026");
  assert.equal(formatEventDate("2027-03-14"), "14 March 2027");
  // Midnight UTC on the first of a month is the classic off-by-one.
  assert.equal(formatEventDate("2027-01-01"), "1 January 2027");
  assert.equal(formatEventDate("not-a-date"), "");
});

test("an event is named with its icon", () => {
  assert.equal(eventDisplayName({ name: "Christmas 2026", type: "christmas" }), "🎄 Christmas 2026");
  assert.equal(eventDisplayName({ name: "Paige's Birthday", type: "birthday" }), "🎂 Paige's Birthday");
});

test("the dashboard shows what is coming soonest, what has been, and nothing archived in either", () => {
  const events = [
    event({ id: CHRISTMAS, name: "Christmas 2026", type: "christmas", eventDate: "2026-12-25", year: 2026 }),
    event({ id: BIRTHDAY, name: "Paige's Birthday", type: "birthday", eventDate: "2027-03-14", celebrantPersonId: PAIGE }),
    event({ id: EASTER, name: "Easter 2027", type: "easter", eventDate: "2027-03-28" }),
  ];

  const partitioned = partitionEvents(events, "2027-01-10");
  assert.deepEqual(partitioned.upcoming.map((row) => row.name), ["Paige's Birthday", "Easter 2027"]);
  assert.deepEqual(partitioned.past.map((row) => row.name), ["Christmas 2026"]);
  assert.deepEqual(partitioned.archived, []);
});

test("an archived event is kept out of the primary lists entirely", () => {
  const events = [
    event({ id: CHRISTMAS, name: "Christmas 2025", type: "christmas", eventDate: "2025-12-25", status: "archived" }),
    event({ id: BIRTHDAY, name: "Paige's Birthday", type: "birthday", eventDate: "2027-03-14", celebrantPersonId: PAIGE }),
  ];

  const partitioned = partitionEvents(events, "2027-01-10");
  assert.deepEqual(partitioned.upcoming.map((row) => row.name), ["Paige's Birthday"]);
  assert.deepEqual(partitioned.past, []);
  assert.deepEqual(partitioned.archived.map((row) => row.name), ["Christmas 2025"]);
});

test("an event happening today is still upcoming", () => {
  const events = [event({ id: EASTER, name: "Easter 2027", type: "easter", eventDate: "2027-03-28" })];
  assert.equal(partitionEvents(events, "2027-03-28").upcoming.length, 1);
  assert.equal(partitionEvents(events, "2027-03-29").past.length, 1);
});

test("two events on one day are ordered by name rather than at random", () => {
  const events = [
    event({ id: EASTER, name: "Easter 2027", type: "easter", eventDate: "2027-03-28" }),
    event({ id: BIRTHDAY, name: "Anna's Birthday", type: "birthday", eventDate: "2027-03-28", celebrantPersonId: PAIGE }),
  ];
  assert.deepEqual(
    partitionEvents(events, "2027-01-01").upcoming.map((row) => row.name),
    ["Anna's Birthday", "Easter 2027"],
  );
});

test("a valid Christmas and a valid birthday are both accepted", () => {
  const christmas = validateEventInput({
    name: "Christmas 2027",
    type: "christmas",
    eventDate: "2027-12-25",
  });
  assert.equal(christmas.ok, true);
  assert.equal(christmas.ok && christmas.value.year, 2027);
  assert.equal(christmas.ok && christmas.value.celebrantPersonId, null);
  assert.equal(christmas.ok && christmas.value.status, "active");

  const birthday = validateEventInput({
    name: "Paige's Birthday",
    type: "birthday",
    eventDate: "2027-03-14",
    celebrantPersonId: PAIGE,
    description: "Lunch, then presents at ours.",
  });
  assert.equal(birthday.ok, true);
  assert.equal(birthday.ok && birthday.value.year, null);
  assert.equal(birthday.ok && birthday.value.celebrantPersonId, PAIGE);
});

test("every rule the database enforces is refused here first, with a usable message", () => {
  const cases: Array<[string, Parameters<typeof validateEventInput>[0]]> = [
    ["a birthday must name whose it is", { name: "Birthday", type: "birthday", eventDate: "2027-03-14" }],
    ["Christmas is not about one person", { name: "Christmas 2027", type: "christmas", eventDate: "2027-12-25", celebrantPersonId: PAIGE }],
    ["an unknown type", { name: "Jubilee", type: "jubilee", eventDate: "2027-06-01" }],
    ["an unknown status", { name: "Easter", type: "easter", eventDate: "2027-03-28", status: "deleted" }],
    ["a missing name", { name: "   ", type: "easter", eventDate: "2027-03-28" }],
    ["an impossible date", { name: "Easter", type: "easter", eventDate: "2027-02-30" }],
    ["a malformed date", { name: "Easter", type: "easter", eventDate: "28/03/2027" }],
    ["a year on something that is not Christmas", { name: "Easter", type: "easter", eventDate: "2027-03-28", year: 2027 }],
    ["an out-of-range Christmas year", { name: "Christmas", type: "christmas", eventDate: "2027-12-25", year: 12027 }],
    ["a malformed celebrant", { name: "Birthday", type: "birthday", eventDate: "2027-03-14", celebrantPersonId: "paige" }],
    ["a control character in the name", { name: `Easter${String.fromCharCode(7)}`, type: "easter", eventDate: "2027-03-28" }],
  ];

  for (const [label, input] of cases) {
    const result = validateEventInput(input);
    assert.equal(result.ok, false, `${label} must be refused`);
    assert.equal(
      typeof (result as { error?: string }).error === "string" && (result as { error: string }).error.length > 0,
      true,
      `${label} must explain itself`,
    );
  }
});

test("an over-long description is refused rather than silently cut", () => {
  const result = validateEventInput({
    name: "Easter 2027",
    type: "easter",
    eventDate: "2027-03-28",
    description: "x".repeat(1_001),
  });
  assert.equal(result.ok, false);
});

test("a Christmas year defaults to the year of its date", () => {
  const result = validateEventInput({ name: "Christmas 2028", type: "christmas", eventDate: "2028-12-25" });
  assert.equal(result.ok && result.value.year, 2028);
});

test("nothing in the event model computes, stores or moves money", () => {
  // The Event layer decides WHICH rows the financial engines are given. If a
  // penny figure ever appears in this module, that separation has been lost.
  const validated = validateEventInput({
    name: "Paige's Birthday",
    type: "birthday",
    eventDate: "2027-03-14",
    celebrantPersonId: PAIGE,
  });
  assert.equal(validated.ok, true);
  assert.deepEqual(
    Object.keys(validated.ok ? validated.value : {}).filter((key) => /pennies|amount|budget|spent|owed/iu.test(key)),
    [],
  );
  for (const type of EVENT_TYPES) {
    assert.deepEqual(
      Object.keys(eventTypeMeta(type)).filter((key) => /pennies|amount|budget|split|owed/iu.test(key)),
      [],
      `${type} must not carry financial behaviour`,
    );
  }
});
