import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const APP = ["src", "app"];
const BIRTHDAY_ROUTE = [...APP, "birthdays", "[personId]"];

/**
 * Checkpoint 4.3 — birthday money, family contributors, event creation.
 *
 * WHAT THIS FILE IS FOR
 *   Four changes in this checkpoint are each one edit away from silently
 *   undoing themselves, and none of them would throw:
 *
 *     1. The birthday card showing money again      -> a card that reads "£0"
 *     2. The intermediate landing screen coming back -> a second Event Home
 *     3. Setup stopping being one transaction        -> half-made birthdays
 *     4. Contributor pickers listing everybody again -> nineteen names
 *
 *   Every one of those looks fine on screen. So they are pinned here, against
 *   the source, and the assertions are written to fail when the BEHAVIOUR
 *   changes rather than when the wording does.
 *
 * WHAT IT IS NOT
 *   Not a substitute for the runtime migration preflight, which runs the real
 *   `start_birthday_planning` and `set_family_contributor` against real
 *   PostgreSQL. These are the checks that can run without a database.
 */

// ---------------------------------------------------------------------------
// The dashboard birthday card
// ---------------------------------------------------------------------------

test("the birthday card shows this event's own money, from the shared loader", () => {
  const dashboard = read(...APP, "events-dashboard.tsx");

  // The figures arrive as a prop. A card that fetched its own totals would be a
  // second financial reader, free to disagree with Event Home.
  assert.match(dashboard, /planning:\s*BirthdayPlanning \| undefined/);
  assert.match(dashboard, /planning=\{planningByPerson\[person\.personId\]\}/);

  // Spend, budget, gifts and ideas are all rendered.
  assert.match(dashboard, /formatPennies\(planning\.spentPennies\)/);
  assert.match(dashboard, /formatPennies\(planning\.budgetPennies\)/);
  assert.match(dashboard, /planning\.giftCount/);
  assert.match(dashboard, /planning\.ideaCount/);
});

test("the card reuses the app's progress and status engines rather than its own", () => {
  // Scoped to the card. The dashboard renders four progress bars, so asserting
  // against the whole file would pass while the birthday one was replaced.
  const card = birthdayCard();
  assert.match(card, /purchaseProgressStatus\(planning\.spentPennies, planning\.budgetPennies\)/);
  assert.match(card, /<FinancialProgressBar\s/);

  // No hand-rolled percentage or threshold. That is how two screens end up
  // disagreeing about whether a birthday is complete.
  assert.doesNotMatch(card, /spentPennies\s*\/\s*\w*[Bb]udgetPennies/);
  assert.doesNotMatch(card, /Math\.(round|floor|ceil)\([^;]*100/);
  assert.doesNotMatch(card, /spentPennies\s*>=?\s*planning\.budgetPennies/);
  assert.doesNotMatch(card, /"(?:budget_reached|in_progress|not_started|over_budget)"/);
});

test("no planning means the card says so, and never shows a budget of zero", () => {
  const dashboard = read(...APP, "events-dashboard.tsx");
  assert.match(dashboard, /Planning not started yet/);

  // The progress bar and the money line are both inside the `planning ?` arm,
  // so an unplanned birthday cannot render "£0 of £0" and read like a decision
  // somebody made.
  const card = dashboard.slice(dashboard.indexOf("function BirthdayCard"));
  const arm = card.slice(card.indexOf("{planning"), card.indexOf("Planning not started yet"));
  assert.ok(arm.includes("FinancialProgressBar"), "the bar belongs to the planned arm");
  assert.ok(arm.includes("formatPennies"), "so does the money");

  // And the bar itself only appears when a budget was actually set.
  assert.match(card, /const hasBudget = \(planning\?\.budgetPennies \?\? 0\) > 0;/);
  assert.match(card, /\{hasBudget && \(\s*\n\s*<div/);
});

test("the card links to the person, not to a year's event", () => {
  const dashboard = read(...APP, "events-dashboard.tsx");
  assert.match(dashboard, /href=\{birthdayWorkspacePath\(person\.personId\)\}/);

  // A link built from the event id would break the moment the next birthday
  // came round, because that event does not exist yet.
  assert.doesNotMatch(dashboard, /href=\{[^}]*planning\.eventId/);
});

// ---------------------------------------------------------------------------
// The intermediate screen is gone
// ---------------------------------------------------------------------------

test("the birthday financial landing screen no longer exists", () => {
  assert.equal(
    existsSync(join(root, ...BIRTHDAY_ROUTE, "workspace-screen.tsx")),
    false,
    "workspace-screen.tsx was a second Event Home reached one tap earlier",
  );
});

test("/birthdays/[personId] resolves; it does not render money", () => {
  const page = read(...BIRTHDAY_ROUTE, "page.tsx");

  // Planning exists -> straight to the real Event Home.
  assert.match(page, /if \(workspace\.current\) \{/);
  assert.match(page, /const destination = eventPath\(workspace\.current\.eventId\);/);
  assert.match(page, /redirect\(destination\)/);

  // Planning does not exist -> the setup screen, and nothing else.
  assert.match(page, /<StartPlanningScreen/);
  assert.doesNotMatch(page, /WorkspaceScreen/);

  // No financial vocabulary on the resolver at all. Comments are stripped
  // first: the doc comment explains what was REMOVED and naming it there is
  // the point.
  const logic = page.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  for (const word of ["formatPennies", "budgetPennies", "spentPennies", "Owed", "FinancialProgressBar"]) {
    assert.ok(!logic.includes(word), `the resolver must not render ${word}`);
  }
});

test("redirect and notFound stay outside try/catch, because they throw", () => {
  const page = read(...BIRTHDAY_ROUTE, "page.tsx");
  const body = page.slice(page.indexOf("export default async function"));
  assert.ok(!body.includes("try {"), "catching a redirect turns navigation into a crash");
});

test("the resolver redirects on the COMING birthday, not on any past year", () => {
  const loader = read("src", "utils", "supabase", "birthdays-server.ts");
  // `current` is resolved through the next-occurrence helper, so a completed
  // 2025 birthday cannot stand in for an unplanned 2026 one.
  assert.match(loader, /nextBirthdayOccurrence/);
  assert.match(loader, /nextOccurrenceDate/);
});

// ---------------------------------------------------------------------------
// Start planning: one screen, one transaction
// ---------------------------------------------------------------------------

test("starting a birthday is a single RPC, so it cannot half-succeed", () => {
  const screen = read(...BIRTHDAY_ROUTE, "start-planning-screen.tsx");

  const rpcs = screen.match(/\.rpc\(\s*"([a-z_]+)"/gu) ?? [];
  assert.equal(rpcs.length, 1, `setup must be one call, found ${rpcs.length}: ${rpcs.join(", ")}`);
  assert.match(screen, /\.rpc\("start_birthday_planning", \{/);

  // The old shape — create the event, then add a recipient, then a budget,
  // then contributors — is exactly the sequence that leaves a birthday
  // half-made when the third call fails.
  for (const name of ["create_event", "add_event_recipient", "set_event_contributor", "save_recipient"]) {
    assert.ok(!screen.includes(name), `${name} would make setup multi-step again`);
  }
});

test("every part of the plan is passed in that one call", () => {
  const screen = read(...BIRTHDAY_ROUTE, "start-planning-screen.tsx");
  for (const argument of [
    "p_celebrant_person_id",
    "p_name",
    "p_event_date",
    "p_budget_pennies",
    "p_contributions",
  ]) {
    assert.ok(screen.includes(argument), `start_birthday_planning needs ${argument}`);
  }
});

test("the equal split is the app's splitter, not a second one", () => {
  const screen = read(...BIRTHDAY_ROUTE, "start-planning-screen.tsx");
  assert.match(screen, /import \{ splitPenniesEqually \} from "@\/lib\/recipient-allocations";/);
  assert.match(screen, /splitPenniesEqually\(budgetPennies, chosen\)/);

  // A local division would drop the remainder. `splitPenniesEqually` is the
  // function that distributes it, and it is already proven by its own tests.
  assert.doesNotMatch(screen, /budgetPennies\s*\/\s*chosen\.length/);
  assert.doesNotMatch(screen, /Math\.floor\(budgetPennies/);
});

test("the plan must equal the budget before the button works", () => {
  const screen = read(...BIRTHDAY_ROUTE, "start-planning-screen.tsx");
  assert.match(screen, /plannedTotal === budgetPennies/);
  assert.match(screen, /disabled=\{saving \|\| !totalsMatch \|\| chosen\.length === 0\}/);
  // And the guard is repeated before the call, so a re-enabled button in dev
  // tools still cannot send a mismatched plan.
  assert.match(screen, /if \(!totalsMatch\) \{/);
});

test("nothing is created until submit", () => {
  const screen = read(...BIRTHDAY_ROUTE, "start-planning-screen.tsx");
  const before = screen.slice(0, screen.indexOf("const start = async"));
  assert.ok(!before.includes(".rpc("), "opening the page must create nothing");
  assert.ok(!/useEffect\([^)]*\)\s*=>\s*\{[^}]*rpc/u.test(screen), "no create-on-mount");
});

test("a successful start goes straight to Event Home", () => {
  const screen = read(...BIRTHDAY_ROUTE, "start-planning-screen.tsx");
  assert.match(screen, /router\.replace\(`\/events\/\$\{created\.id\}`\)/);
  // `replace`, not `push`: the setup screen no longer exists once it has run,
  // so Back must not return to it.
  assert.doesNotMatch(screen, /router\.push\(`\/events\//);
});

test("the celebrant is never offered as a contributor to their own birthday", () => {
  const loader = read("src", "utils", "supabase", "birthdays-server.ts");
  const screen = read(...BIRTHDAY_ROUTE, "start-planning-screen.tsx");

  // Decided by person identity in the loader...
  assert.match(loader, /eligibleContributors/);
  assert.match(loader, /neq\("id", personId\)|!==\s*personId|\bfilter\([^)]*personId/);

  // ...and the screen renders exactly what the loader gave it.
  assert.match(screen, /contributors\.map\(\(person\)/);
  assert.ok(!screen.includes("people.map("), "the screen must not build its own list");
});

// ---------------------------------------------------------------------------
// The family contributor pool
// ---------------------------------------------------------------------------

test("contributor eligibility is a column on people, added in 030 or later", () => {
  const applied = ["026", "027", "028", "029"];
  for (const number of applied) {
    const files = migrationsMatching(number);
    for (const file of files) {
      assert.ok(
        !read("supabase", "migrations", file).includes("is_family_contributor"),
        `${file} is already applied to production and must not be edited`,
      );
    }
  }
  const owner = migrationsMatching("030").find((file) =>
    read("supabase", "migrations", file).includes("is_family_contributor"));
  assert.ok(owner, "migration 030 must introduce is_family_contributor");
});

test("the pool is backfilled from who actually contributes, not from a name list", () => {
  const sql = read("supabase", "migrations", ownerOf("is_family_contributor"));
  assert.match(sql, /update public\.people\s+set is_family_contributor = true\s+where id in \(\s*select distinct person_id from public\.contributors/i);
  // A hard-coded family would be wrong for this family tomorrow and wrong for
  // any other family today.
  assert.doesNotMatch(sql, /where name (=|in)/i);
});

test("set_family_contributor writes one boolean and checks Global Admin itself", () => {
  const sql = read("supabase", "migrations", ownerOf("set_family_contributor"));
  const body = functionBody(sql, "set_family_contributor");

  assert.match(body, /security definer/i);
  assert.match(body, /set search_path = ''/i);
  assert.match(body, /42501/, "a non-admin must be refused by the database, not by the UI");

  // It must not touch money. Removing somebody from the pool stops them being
  // OFFERED; it does not rewrite a plan they are already part of.
  for (const table of [
    "recipient_contributions",
    "purchase_allocations",
    "purchases",
    "settlements",
    "payment_receipts",
    "contributors",
  ]) {
    assert.ok(
      !new RegExp(`(update|delete\\s+from|insert\\s+into)\\s+public\\.${table}\\b`, "iu").test(body),
      `set_family_contributor must not write ${table}`,
    );
  }
});

test("the Global Admin edits the pool from Family access", () => {
  const client = read(...APP, "more", "family-access", "family-access-client.tsx");
  assert.match(client, /function ContributorPool\(/);
  assert.match(client, /rpc\("set_family_contributor", \{/);
  assert.match(client, /p_person_id: member\.personId/);
  assert.match(client, /p_eligible: !member\.isFamilyContributor/);
  assert.match(client, /aria-pressed=\{on\}/, "a toggle must announce its state");

  // The API has to carry the flag, or every chip renders off.
  const route = read(...APP, "api", "admin", "family-access", "route.ts");
  assert.match(route, /select\("id, name, is_family_contributor"\)/);
  assert.match(route, /isFamilyContributor: Boolean\(person\.is_family_contributor\)/);
});

test("contributor pickers offer the pool; recipient pickers offer everybody", () => {
  const form = read(...APP, "events", "new", "create-event-form.tsx");

  assert.match(form, /const contributorPool = people\.filter\(\(person\) => person\.isFamilyContributor\);/);

  // Each picker is extracted and checked to pass EXACTLY ONE `people` prop.
  // Matching loosely across the element would pass while a second `people`
  // prop after it quietly overrode the first.
  const contributorPicker = pickerWithTitle(form, "Who is chipping in?");
  assert.deepEqual(contributorPicker.match(/people=\{[^}]*\}/gu), ["people={contributorPool}"]);

  // The recipient picker still takes everybody, because anyone can receive a
  // gift regardless of whether they ever pay for one.
  const recipientPicker = pickerWithTitle(form, "Who is this event for?");
  assert.deepEqual(recipientPicker.match(/people=\{[^}]*\}/gu), ["people={people}"]);

  // Defaults seed from the pool too, or the first render pre-selects nineteen
  // people and the filter is cosmetic.
  assert.ok(
    !form.includes("setContributorIds(people.map("),
    "contributor defaults must seed from the pool",
  );
  assert.ok(
    form.includes("setContributorIds(contributorPool.map((person) => person.personId))"),
    "the pool must actually be used as the default",
  );

  const page = read(...APP, "events", "new", "page.tsx");
  assert.match(page, /isFamilyContributor: person\.isFamilyContributor/);
});

test("event settings keeps an existing contributor visible after they leave the pool", () => {
  const screen = read(...APP, "events", "[eventId]", "settings", "settings-screen.tsx");

  // Pool OR already contributing. Without the second half, removing somebody
  // from the pool would hide the only control that can take their money back
  // out of an event they are still assigned to.
  assert.match(
    screen,
    /const contributorChoices = people\.filter\(\(person\) =>\s*\n?\s*person\.isFamilyContributor \|\| contributorPersonIds\.includes\(person\.personId\)\);/,
  );
  assert.match(screen, /\{contributorChoices\.map\(\(person\)/);

  const page = read(...APP, "events", "[eventId]", "settings", "page.tsx");
  assert.match(page, /select\("id,name,is_family_contributor"\)/);
});

test("removing somebody from the pool changes nothing already planned", () => {
  const client = read(...APP, "more", "family-access", "family-access-client.tsx");
  // Said in the interface, because a control whose blast radius is unclear is
  // one nobody dares use.
  assert.match(client, /Removing somebody here changes nothing already planned or paid\./);
});

// ---------------------------------------------------------------------------
// An event about one person takes exactly one recipient
// ---------------------------------------------------------------------------

test("a celebrant event never offers Add recipient", () => {
  const people = read(...APP, "people", "people-screen.tsx");
  assert.match(people, /const addButton = isAdmin && celebrantPersonId === null \? \(/);
  assert.match(people, /const addForm = isAdmin && celebrantPersonId === null && adding \? \(/);

  const route = read(...APP, "events", "[eventId]", "people", "page.tsx");
  assert.match(route, /celebrantPersonId=\{event\.celebrantPersonId\}/);

  const settings = read(...APP, "events", "[eventId]", "settings", "settings-screen.tsx");
  assert.match(settings, /const isAboutOnePerson = event\.celebrantPersonId !== null;/);
  assert.match(settings, /disabled=\{busy \|\| on \|\| isAboutOnePerson\}/);
});

test("that rule is decided by the celebrant, never by the event type", () => {
  // The People screen has no event type at all, so it could not branch on one
  // even if somebody wanted to.
  const people = read(...APP, "people", "people-screen.tsx");
  const peopleLogic = people.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  for (const literal of ['"birthday"', "'birthday'", '"christmas"', "'christmas'"]) {
    assert.ok(!peopleLogic.includes(literal), `people-screen must not branch on ${literal}`);
  }

  // Settings does read `event.type` — for the delete destination and for a
  // hint about the person's saved birthday, both of which are genuinely about
  // birthdays. What must NOT depend on it is the single-recipient rule, so the
  // derivation itself is pinned to the celebrant.
  const settings = read(...APP, "events", "[eventId]", "settings", "settings-screen.tsx");
  const derivation = settings.slice(
    settings.indexOf("const isAboutOnePerson"),
    settings.indexOf("const addRecipient"),
  );
  assert.ok(derivation.length > 0, "the derivation must exist");
  assert.ok(
    !/event\.type/u.test(derivation),
    "isAboutOnePerson and recipientChoices must not consult the event type",
  );
  assert.match(derivation, /event\.celebrantPersonId !== null/);
});

// ---------------------------------------------------------------------------
// Event creation
// ---------------------------------------------------------------------------

test("Christmas can be created from Create Event again", () => {
  const events = read("src", "lib", "events.ts");
  assert.match(events, /SPECIAL_EVENT_TYPES[\s\S]{0,200}?"christmas"/);

  // Birthdays are the exception, and for a reason: they are started from the
  // person, in one transaction, with a budget and a plan.
  const block = events.slice(events.indexOf("SPECIAL_EVENT_TYPES"), events.indexOf("SPECIAL_EVENT_TYPES") + 400);
  assert.ok(!block.includes('"birthday"'), "birthdays start from the person");
});

test("one Christmas per year is enforced by the database, not by hiding the option", () => {
  const sql = read("supabase", "migrations", ownerOf("is_family_contributor"));
  // The note that stops somebody 'fixing' this in the UI later. Migration 025
  // owns the constraint; 030 documents that it has no status predicate, so
  // archiving a Christmas does not free its year.
  assert.match(sql, /unique \(year\)[\s\S]{0,120}?event_type = 'christmas'/i);
});

test("the year and date default to the next occurrence that is still available", () => {
  const form = read(...APP, "events", "new", "create-event-form.tsx");
  assert.match(form, /nextOccurrenceYear\(nextType, today, takenYears\[nextType\] \?\? \[\]\)/);

  const occasions = read("src", "lib", "uk-occasions.ts");
  assert.match(occasions, /export function nextOccurrenceYear\(/);
  // Today still counts as upcoming — an event created on the morning of the
  // day is for that day.
  assert.match(occasions, /taken: readonly number\[\] = \[\]/);
});

test("no family member, family size, year or event id is hard-coded anywhere", () => {
  const files = [
    [...APP, "events-dashboard.tsx"],
    [...BIRTHDAY_ROUTE, "page.tsx"],
    [...BIRTHDAY_ROUTE, "start-planning-screen.tsx"],
    [...APP, "more", "family-access", "family-access-client.tsx"],
    [...APP, "events", "new", "create-event-form.tsx"],
    ["src", "utils", "supabase", "birthdays-server.ts"],
    ["src", "lib", "uk-occasions.ts"],
  ];
  // A UUID literal in application code is a production row pasted into the
  // repository. There is no legitimate one.
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
  for (const file of files) {
    const source = read(...file);
    const logic = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    assert.ok(!uuid.test(logic), `${file.join("/")} contains a literal id`);
    // A calendar year assigned, compared or returned is a year the app will be
    // wrong about next January. Years inside comments are documentation and are
    // already stripped above.
    // MIN_YEAR/MAX_YEAR are excluded: they are limits on what a human may
    // type, not a year the app assumes.
    const years = logic.replace(/^.*(?:MIN_YEAR|MAX_YEAR).*$/gmu, "");
    assert.ok(
      !/(?:[=<>]=?|return|year:)\s*(?:19|20)\d\d\b/u.test(years),
      `${file.join("/")} pins a year`,
    );
    // "Mum" and "Dad" are recipients this family happens to have, not a
    // definition of Mother's Day or Father's Day.
    assert.ok(!/["'](Mum|Dad|Mother|Father)["']/u.test(logic), `${file.join("/")} names a recipient`);
  }
});

// ---------------------------------------------------------------------------
// Wording: the product is not Christmas
// ---------------------------------------------------------------------------

test("shared screens do not call an event Christmas", () => {
  const shared = [
    [...APP, "people", "people-screen.tsx"],
    [...APP, "people", "person-modal.tsx"],
    [...APP, "people", "recipient-allocation-editor.tsx"],
    [...APP, "add-purchase", "purchase-form.tsx"],
    [...APP, "family-context.tsx"],
  ];
  // Only user-facing strings. Column and table names like
  // `christmas_recipients` are the schema and are deliberately unchanged.
  const visible = /(?:title|label|hint|description|body|placeholder)=["'][^"']*[Cc]hristmas[^"']*["']|>[^<>{}]*[Cc]hristmas[^<>{}]*</u;
  for (const file of shared) {
    const source = read(...file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    assert.ok(!visible.test(source), `${file.join("/")} still says Christmas to the reader`);
  }
});

test("notification titles keep the action; the event name is context", () => {
  const content = read("src", "lib", "notification-content.ts");
  // The regression this pins: titles were once rewritten to the event name, so
  // a push said "Ruby's Birthday" and the reader had no idea what happened.
  for (const action of ["Payment", "payment", "Purchase", "purchase"]) {
    assert.ok(content.includes(action), `notification copy must still describe the ${action} action`);
  }
});

// ---------------------------------------------------------------------------
// Financial non-regression
// ---------------------------------------------------------------------------

test("checkpoint 4.3 wrote no new financial arithmetic", () => {
  const touched = [
    [...APP, "events-dashboard.tsx"],
    [...BIRTHDAY_ROUTE, "page.tsx"],
    [...BIRTHDAY_ROUTE, "start-planning-screen.tsx"],
    [...APP, "more", "family-access", "family-access-client.tsx"],
    [...APP, "events", "[eventId]", "settings", "settings-screen.tsx"],
  ];
  for (const file of touched) {
    const source = read(...file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    // Floating point anywhere near money is the bug this app was built to
    // avoid. The one permitted use is /100 when formatting for display.
    assert.ok(!/parseFloat\(/u.test(source), `${file.join("/")} uses parseFloat`);
    assert.ok(!/[Pp]ennies\s*\*\s*1\.|\bpennies\s*\/\s*(?!100\b)/u.test(source),
      `${file.join("/")} divides pennies by something other than 100`);
  }
});

test("the Owed engine, allocation snapshots and payment rules are untouched", () => {
  // Not a copy of their logic — a guard that this checkpoint did not add a
  // second implementation of any of it.
  const owed = read("src", "lib", "owed.ts");
  assert.match(owed, /confirmed/i, "Owed still reduces on confirmed payments only");

  const dashboard = read(...APP, "events-dashboard.tsx");
  for (const word of ["owedPennies", "confirmPayment", "purchase_allocations", "settlements"]) {
    assert.ok(!dashboard.includes(word), `the dashboard must not reimplement ${word}`);
  }
});

test("the backup proves it carried contributor eligibility", () => {
  const workflow = read(".github", "workflows", "database-backup.yml");
  assert.match(workflow, /for COLUMN in birthday_month birthday_day birthday_year is_family_contributor; do/);
  // One boolean per person, and a restore without it would look complete while
  // silently offering the whole family as contributors again.
  assert.match(workflow, /ORDERING: is_family_contributor arrives with migration 030/);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One `<PeoplePicker …/>` element, found by its title and cut at its close. */
function pickerWithTitle(source, title) {
  const at = source.indexOf(`title="${title}"`);
  assert.notEqual(at, -1, `no picker titled ${title}`);
  const open = source.lastIndexOf("<PeoplePicker", at);
  assert.notEqual(open, -1, `${title} is not a PeoplePicker`);
  const close = source.indexOf("/>", at);
  assert.notEqual(close, -1, `${title} is not closed`);
  return source.slice(open, close + 2);
}

/** Just the BirthdayCard component, so a sibling card cannot satisfy a check. */
function birthdayCard() {
  const dashboard = read(...APP, "events-dashboard.tsx");
  const start = dashboard.indexOf("function BirthdayCard(");
  assert.notEqual(start, -1, "BirthdayCard must exist");
  const rest = dashboard.slice(start);
  const end = rest.indexOf("\nfunction ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Migration filenames whose sequence number is `number` (e.g. "030"). */
function migrationsMatching(number) {
  // Filenames are <8-digit date><4-digit sequence>_name.sql, so the sequence is
  // the last four digits of the prefix. Matching anywhere in the name would let
  // "026" match 202608100030, whose DATE contains it.
  return readdirSync(join(root, "supabase", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => (/^\d{8}(\d{4})_/u.exec(file)?.[1] ?? "").endsWith(number));
}

/** The single migration that introduces `symbol`. */
function ownerOf(symbol) {
  const files = readdirSync(join(root, "supabase", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => read("supabase", "migrations", file).includes(symbol));
  assert.equal(files.length, 1, `${symbol} must be introduced by exactly one migration, found ${files.length}`);
  return files[0];
}

/** The text of one `create ... function name(...)` body, dollar quotes and all. */
function functionBody(sql, name) {
  const start = sql.search(new RegExp(`function public\\.${name}\\s*\\(`, "u"));
  assert.notEqual(start, -1, `${name} is not defined here`);
  const rest = sql.slice(start);
  const end = rest.search(/\n\$\$;/u);
  assert.notEqual(end, -1, `${name} has no closing dollar quote`);
  return rest.slice(0, end);
}
