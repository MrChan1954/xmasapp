import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ---------------------------------------------------------------------------
// Checkpoint 4.2: the Eden crash, Mother's Day and Father's Day, and the
// year/date contradiction that produced "Easter 2026" dated in 2027.
//
// THE EDEN BUG, IN ONE SENTENCE
//   A Server Component called `cx`, which it had imported from a "use client"
//   module — so the import was a client reference, and invoking it during a
//   server render threw. It only threw inside `WorkspaceLink`, which only
//   renders when the person has a current-year occurrence, which is why the two
//   people whose planning had been started were the only two who could not open
//   their own birthday page.
//
//   It survived a clean build, a clean type-check, a clean lint and 527 tests,
//   because none of those reach the branch. The last test in this file is the one
//   that would have caught it: it walks every server component in the
//   repository and fails if any of them calls a value from a client module.
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const { easterSunday, motheringSunday, fathersDay, suggestedOccasionDate } =
  await import("../src/lib/uk-occasions.ts");
const {
  EVENT_TYPES, SPECIAL_EVENT_TYPES, eventTypeMeta, groupDashboardEvents,
  validateEventInput, yearStatedInName, eventNavMode,
} = await import("../src/lib/events.ts");

const workspaceScreen = read("src", "app", "birthdays", "[personId]", "workspace-screen.tsx");
const workspaceServer = read("src", "utils", "supabase", "birthdays-server.ts");
const createForm = read("src", "app", "events", "new", "create-event-form.tsx");
const migration28 = read("supabase", "migrations", "202608100028_add_mothers_and_fathers_day.sql");

// ---------------------------------------------------------------------------
// 1-7. The birthday workspace
// ---------------------------------------------------------------------------

test("1. a permanent birthday with no occurrence at all is a valid page", () => {
  // The route is the PERSON. It must never need an event to exist — most
  // birthdays have no planning started, and that is the normal state, not an
  // error.
  const page = read("src", "app", "birthdays", "[personId]", "page.tsx");
  assert.match(page, /loadBirthdayWorkspace\(personId\)/u);
  assert.doesNotMatch(page, /eventId|requireEvent/u, "the route must not need an event id");

  // The loader returns a complete workspace before it looks at any event.
  assert.ok(
    workspaceServer.includes("if (events.length === 0) {")
    && workspaceServer.includes("return { person, current: null, currentYear, previous: [], unused: [], isAdmin, today };"),
    "no occurrences is an ordinary return, not a failure",
  );

  // And the screen says so, with the admin's way forward.
  assert.match(workspaceScreen, /Nothing planned for \{currentYear\} yet/u);
  assert.match(workspaceScreen, /Start planning/u);
  assert.match(workspaceScreen, /\{isAdmin && next && \(/u, "offered to the Global Admin only");
});

test("2-4. opening, leaving, reopening, reloading and pasting the URL are the same request", () => {
  // There is no client state to get stale: the page is a Server Component that
  // reads from the person id in the URL every time. Whatever made the second
  // visit differ from the first cannot live here.
  const page = read("src", "app", "birthdays", "[personId]", "page.tsx");
  assert.match(page, /export const dynamic = "force-dynamic";/u, "never served from a cache");
  // The DIRECTIVE, not the words: this file's comments explain the client
  // boundary, so a bare search for the phrase finds its own documentation.
  assert.ok(
    !workspaceScreen.trimStart().startsWith('"use client"')
    && !workspaceScreen.trimStart().startsWith("'use client'"),
    "the screen renders on the server",
  );
  assert.doesNotMatch(workspaceScreen, /useState|useEffect|useRouter|useSearchParams/u,
    "and holds no state that could differ between visits");
});

test("5. reading the page creates nothing", () => {
  // Opening somebody's birthday must not bring an occurrence into existence.
  assert.doesNotMatch(
    workspaceServer,
    /\.(insert|update|upsert|delete)\(|rpc\(/u,
    "the loader only reads",
  );
  assert.doesNotMatch(workspaceScreen, /rpc\(|\.insert\(|\.update\(/u, "and so does the screen");
});

test("6. a historical occurrence is never mistaken for this year's planning", () => {
  assert.match(
    workspaceServer,
    /const current = occurrences\.find\(\(occurrence\) => occurrence\.year === currentYear && occurrence\.status === "active"\)/u,
    "current means this year's, and active",
  );
  assert.match(workspaceServer, /const next = person\.birthday \? nextBirthdayOccurrence\(person\.birthday, today\) : null;/u);
  assert.match(workspaceServer, /const currentYear = next \? next\.year : currentYearOf\(today\);/u,
    "the year comes from the person's next birthday, not from row order");
});

test("7. an occurrence dated in a birth year cannot become current planning", () => {
  // Production holds a birthday occurrence dated in a birth YEAR — somebody
  // typed a date of birth into Create Event, where the date field means the day
  // the event is for. It must never present itself as this year's plan.
  const occurrences = [
    { year: 1995, status: "active", gifts: [], openIdeas: [] },
    { year: 2026, status: "active", gifts: [], openIdeas: [] },
  ];
  const currentYear = 2026;
  const current = occurrences.find((o) => o.year === currentYear && o.status === "active");
  assert.equal(current?.year, 2026);

  // With only the 1995 row, there is no current planning at all.
  const only1995 = [occurrences[0]];
  assert.equal(only1995.find((o) => o.year === currentYear && o.status === "active"), undefined);

  // It is not history either — nothing happened in it — so it is listed as
  // unused, for the admin, and only for the admin.
  assert.match(workspaceServer, /const unused = occurrences/u);
  assert.match(workspaceServer, /occurrence !== current && !hasActivity\(occurrence\)/u);
  assert.match(workspaceScreen, /\{isAdmin && unused\.length > 0 && \(/u);
});

// ---------------------------------------------------------------------------
// 8-16. Mother's Day and Father's Day
// ---------------------------------------------------------------------------

test("8-9. both are first-class event types, in the app and in the database", () => {
  assert.ok(EVENT_TYPES.includes("mothers_day"), "mothers_day is an event type");
  assert.ok(EVENT_TYPES.includes("fathers_day"), "fathers_day is an event type");
  assert.equal(eventTypeMeta("mothers_day").label, "Mother's Day");
  assert.equal(eventTypeMeta("fathers_day").label, "Father's Day");

  // Not "other with a name": the type is what carries the date rule, the icon
  // and the grouping, and a name carries none of those.
  assert.notEqual(eventTypeMeta("mothers_day").icon, eventTypeMeta("other").icon);
  assert.notEqual(eventTypeMeta("fathers_day").icon, eventTypeMeta("other").icon);

  // The database accepts them, in both places that enumerate types.
  assert.match(migration28, /'christmas', 'birthday', 'mothers_day', 'fathers_day',\s*\n\s*'easter', 'wedding', 'anniversary', 'other'/u);
  assert.match(migration28, /create or replace function public\.create_event\(/u,
    "create_event keeps its own list, so 028 widens that too");
  const fn = migration28.slice(migration28.indexOf("create or replace function public.create_event("));
  assert.match(fn, /'mothers_day', 'fathers_day'/u);
  assert.match(fn, /is_app_admin\(\)/u, "and it is still Global Admin only");
  assert.match(fn, /set search_path = ''/u, "and still search_path-pinned");
});

test("10. UK Mother's Day is Mothering Sunday, across many years", () => {
  // Three weeks before Easter Sunday — checkable in any diary. NOT the American
  // second Sunday in May, which in 2026 would be 10 May rather than 15 March.
  const known = {
    2024: "2024-03-10", 2025: "2025-03-30", 2026: "2026-03-15",
    2027: "2027-03-07", 2028: "2028-03-26", 2029: "2029-03-11", 2030: "2030-03-31",
  };
  for (const [year, expected] of Object.entries(known)) {
    assert.equal(motheringSunday(Number(year)), expected, `Mothering Sunday ${year}`);
  }
  // It is never in May, and always a Sunday.
  for (let year = 2020; year <= 2060; year += 1) {
    const date = motheringSunday(year);
    assert.equal(new Date(`${date}T00:00:00Z`).getUTCDay(), 0, `${date} must be a Sunday`);
    const month = Number(date.slice(5, 7));
    assert.ok(month === 2 || month === 3 || month === 4, `${date} must be Feb-Apr, never May`);
  }
  // And it is exactly 21 days before Easter, every year.
  for (let year = 2020; year <= 2060; year += 1) {
    const easter = new Date(`${easterSunday(year)}T00:00:00Z`).getTime();
    const mothering = new Date(`${motheringSunday(year)}T00:00:00Z`).getTime();
    assert.equal((easter - mothering) / 86_400_000, 21, `${year} must be three weeks before Easter`);
  }
});

test("11. UK Father's Day is the third Sunday in June, across many years", () => {
  const known = {
    2024: "2024-06-16", 2025: "2025-06-15", 2026: "2026-06-21",
    2027: "2027-06-20", 2028: "2028-06-18", 2029: "2029-06-17", 2030: "2030-06-16",
  };
  for (const [year, expected] of Object.entries(known)) {
    assert.equal(fathersDay(Number(year)), expected, `Father's Day ${year}`);
  }
  for (let year = 2020; year <= 2060; year += 1) {
    const date = fathersDay(year);
    const parsed = new Date(`${date}T00:00:00Z`);
    assert.equal(parsed.getUTCDay(), 0, `${date} must be a Sunday`);
    assert.equal(parsed.getUTCMonth(), 5, `${date} must be in June`);
    assert.ok(parsed.getUTCDate() >= 15 && parsed.getUTCDate() <= 21, `${date} must be the third Sunday`);
  }
});

test("11b. Easter itself is right, which is what Mother's Day depends on", () => {
  const known = {
    2024: "2024-03-31", 2025: "2025-04-20", 2026: "2026-04-05",
    2027: "2027-03-28", 2028: "2028-04-16", 2030: "2030-04-21", 2038: "2038-04-25",
  };
  for (const [year, expected] of Object.entries(known)) {
    assert.equal(easterSunday(Number(year)), expected, `Easter ${year}`);
  }
});

test("12. who the gifts are for is data the admin chooses, never assumed", () => {
  // Nothing anywhere maps Mother's Day to "Mum" or Father's Day to "Dad".
  for (const parts of [
    ["src", "lib", "events.ts"],
    ["src", "lib", "uk-occasions.ts"],
    ["src", "app", "events", "new", "create-event-form.tsx"],
    ["supabase", "migrations", "202608100028_add_mothers_and_fathers_day.sql"],
  ]) {
    const source = read(...parts).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    assert.doesNotMatch(source, /"Mum"|'Mum'|"Dad"|'Dad'/u, `${parts.at(-1)} must not name a recipient`);
  }
  // Neither type may even carry a celebrant: there is nowhere to put the
  // assumption.
  assert.equal(eventTypeMeta("mothers_day").allowsCelebrant, false);
  assert.equal(eventTypeMeta("fathers_day").allowsCelebrant, false);
  assert.match(migration28, /event_type not in \('mothers_day', 'fathers_day'\) or celebrant_person_id is null/u);
});

test("13-14. one recipient gets Gifts, two get People — automatically", () => {
  assert.equal(eventNavMode(1), "single");
  assert.equal(eventNavMode(2), "multi");
  assert.equal(eventNavMode(0), "empty");
  // Decided by the count, so a Mother's Day for one person and one for two
  // parents reach different answers with no per-type rule anywhere.
  const events = read("src", "lib", "events.ts");
  const body = events.slice(events.indexOf("export function eventNavMode("), events.indexOf("\n}", events.indexOf("export function eventNavMode(")));
  assert.doesNotMatch(body, /mothers_day|fathers_day/u, "the nav mode must not know these types exist");
});

test("15-16. both group under Special events, and neither is a birthday", () => {
  const make = (type, id) => ({
    id, name: id, type, eventDate: "2026-06-21", status: "active",
    year: null, celebrantPersonId: null, description: null,
  });
  const grouped = groupDashboardEvents(
    [
      make("mothers_day", "mothers"),
      make("fathers_day", "fathers"),
      { ...make("birthday", "birthday"), celebrantPersonId: "p" },
      { ...make("christmas", "christmas"), eventDate: "2026-12-25", year: 2026 },
    ],
    "2026-01-01",
  );
  assert.deepEqual(grouped.special.upcoming.map((e) => e.id).sort(), ["fathers", "mothers"]);
  assert.deepEqual(grouped.christmas.map((e) => e.id), ["christmas"]);
  assert.deepEqual(grouped.birthdayOccurrences.map((e) => e.id), ["birthday"]);
  assert.ok(!grouped.special.upcoming.some((e) => e.type === "birthday"));
});

test("Create Event offers the special occasions and not the two that belong elsewhere", () => {
  assert.deepEqual(
    [...SPECIAL_EVENT_TYPES],
    ["mothers_day", "fathers_day", "easter", "wedding", "anniversary", "other"],
  );
  assert.ok(!SPECIAL_EVENT_TYPES.includes("christmas"), "the family has one Christmas");
  assert.ok(!SPECIAL_EVENT_TYPES.includes("birthday"), "a birthday belongs to a person");

  assert.match(createForm, /SPECIAL_EVENT_TYPES\.map\(\(option: EventType\) => \{/u);
  assert.match(createForm, /href="\/birthdays"/u, "and it says where a birthday is started");

  // The date is suggested, and explained, and still editable.
  assert.match(createForm, /suggestedOccasionDate\(nextType, year\)/u);
  assert.match(createForm, /occasionDateExplanation\(type\)/u);
  assert.match(createForm, /<Input type="date" value=\{date\} onChange=/u, "the admin can change it");

  assert.equal(suggestedOccasionDate("mothers_day", 2026), "2026-03-15");
  assert.equal(suggestedOccasionDate("fathers_day", 2026), "2026-06-21");
  assert.equal(suggestedOccasionDate("easter", 2026), "2026-04-05");
  assert.equal(suggestedOccasionDate("wedding", 2026), null, "a wedding has no formula");
});

// ---------------------------------------------------------------------------
// 17-18. The year/date contradiction
// ---------------------------------------------------------------------------

test("17. an event whose name and date disagree about the year is rejected", () => {
  // Exactly the live record: "Easter 2026", dated 2027-02-20.
  const bad = validateEventInput({ name: "Easter 2026", type: "easter", eventDate: "2027-02-20" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /says 2026 but the date is in 2027/u);

  // Christmas carries an explicit year, which must match its date too.
  const badChristmas = validateEventInput({
    name: "Christmas 2026", type: "christmas", eventDate: "2027-12-25", year: 2026,
  });
  assert.equal(badChristmas.ok, false);
  assert.match(badChristmas.error, /Christmas 2026, but the date is in 2027/u);

  // A number that is not a year is not treated as one.
  assert.equal(yearStatedInName("Mum & Dad's 40th"), null);
  assert.equal(yearStatedInName("Easter 2026"), 2026);
  assert.equal(yearStatedInName("Christmas 2025 and 2026"), null, "two years is a span, not a claim");
});

test("18. a consistent event is accepted", () => {
  for (const input of [
    { name: "Easter 2026", type: "easter", eventDate: "2026-04-05" },
    { name: "Christmas 2026", type: "christmas", eventDate: "2026-12-25" },
    { name: "Mother's Day 2026", type: "mothers_day", eventDate: "2026-03-15" },
    { name: "Father's Day 2026", type: "fathers_day", eventDate: "2026-06-21" },
    { name: "Mum & Dad's 40th", type: "anniversary", eventDate: "2026-09-12" },
    { name: "A wedding", type: "wedding", eventDate: "2027-08-01" },
  ]) {
    const result = validateEventInput(input);
    assert.equal(result.ok, true, `${input.name}: ${result.ok ? "" : result.error}`);
  }
});

// ---------------------------------------------------------------------------
// The bug's whole class
// ---------------------------------------------------------------------------

test("no server component calls a value imported from a client module", () => {
  // THE EDEN BUG, GENERALISED.
  //
  // A Server Component may RENDER a component exported from a "use client"
  // module, but it may not CALL a plain function from one: the import arrives
  // as a client reference and invoking it during a server render throws. The
  // failure is invisible until the branch containing the call is reached, which
  // is why the whole test suite, the type-checker and the build all passed
  // while two people could not open their own birthday page.
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.tsx?$/u.test(entry.name) && !/\.test\./u.test(entry.name)) files.push(relative);
    }
  };
  walk("src");

  const stripComments = (source) => source
    .replace(new RegExp(String.raw`/\*[\s\S]*?\*/`, "gu"), "")
    .replace(new RegExp(String.raw`//[^\n]*`, "gu"), "");
  const isClient = (file) => /^\s*["']use client["']/u.test(read(...file.split("/")));

  const resolve = (from, specifier) => {
    let base;
    if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
    else if (specifier.startsWith(".")) base = join(dirname(from), specifier).replace(/\\/gu, "/");
    else return null;
    base = base.replace(/\.tsx?$/u, "");
    for (const extension of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
      try {
        readFileSync(join(root, base + extension));
        return base + extension;
      } catch { /* keep looking */ }
    }
    return null;
  };

  const violations = [];
  for (const file of files) {
    if (isClient(file)) continue;
    const source = stripComments(read(...file.split("/")));
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gu)) {
      const target = resolve(file, match[2]);
      if (!target || !isClient(target)) continue;
      const names = match[1].split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry && !entry.startsWith("type "))
        .map((entry) => entry.split(/\s+as\s+/u)[0].trim())
        // Lowercase = a value. Capitalised = a component, which is allowed.
        .filter((name) => /^[a-z]/u.test(name));
      const body = source.replace(match[0], "");
      for (const name of names) {
        if (new RegExp(String.raw`(?<![\w.])${name}\s*\(`, "u").test(body)) {
          violations.push(`${file} calls ${name}() from ${target}`);
        }
      }
    }
  }

  assert.deepEqual(violations, [], "a server component cannot call a function from a client module");
  assert.ok(files.length > 50, "the walk must actually have found the source tree");
});

test("the birthday workspace takes cx from the module server components may call", () => {
  assert.match(workspaceScreen, /import \{ cx \} from "\.\.\/\.\.\/components\/cx";/u);
  assert.doesNotMatch(workspaceScreen, /import \{[^}]*\bcx\b[^}]*\} from "\.\.\/\.\.\/components\/ui";/u);
  // And the module it now uses says why it exists.
  assert.match(read("src", "app", "components", "cx.ts"), /server components can call it/u);
});
