import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Line endings are normalised on the way in. Git stores LF and checks files out
// as CRLF on Windows, so a multi-line pattern written with \n silently stops
// matching a file nobody has edited -- a false failure about the product,
// caused by a checkout setting.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");
const APP = ["src", "app"];

// The rule under test is a real function, so it is exercised as one rather than
// only read as text.
const { hasFixedSingleRecipient } = await import("../src/lib/events.ts");
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

/**
 * THE WIRING, not the rendering.
 *
 * The test above proves the card CAN show the money. It passed 33/33 while the
 * dashboard showed "Planning not started yet" for every fully planned birthday,
 * because nothing asserted that the page SUPPLIED the figures: page.tsx called
 * the loader, used only `.people`, and let `planningByPerson` fall back to its
 * `{}` default. Type-clean, lint-clean, test-clean, and silently wrong.
 *
 * So this walks the actual path -- loader result -> local -> prop -- and fails
 * if any link in it is cut.
 */
test("the dashboard page SUPPLIES the birthday money, it does not just render it", () => {
  const page = read(...APP, "page.tsx");

  // 1. The figures are READ off the loader result. Recomputing them here would
  //    be a second financial reader, free to disagree with Event Home.
  const assignment = page.match(/(\w+)\s*=\s*birthdayResult\.value\.planningByPerson\s*;/u);
  assert.ok(
    assignment,
    "page.tsx must take planningByPerson off the loader result; without it every "
      + 'birthday card silently reads "Planning not started yet"',
  );
  const carrier = assignment[1];

  // 2. It is read in the same fulfilled branch as the birthdays, so a birthday
  //    can never arrive on the page with its planning left behind.
  const start = page.indexOf('if (birthdayResult.status === "fulfilled")');
  assert.ok(start !== -1, "the birthdays are still read from a settled result");
  const fulfilled = page.slice(start, page.indexOf("} else", start));
  assert.ok(
    fulfilled.includes(carrier + " = birthdayResult.value.planningByPerson"),
    "the planning must be taken in the branch that took the birthdays",
  );

  // 3. And it actually reaches the dashboard. The signed-out render is excluded
  //    by name: it passes no birthdays, so it has no planning to pass either.
  const renders = [...page.matchAll(/<EventsDashboard\b[\s\S]*?\/>/gu)].map((match) => match[0]);
  assert.ok(renders.length > 0, "the page still renders the dashboard");
  const withBirthdays = renders.filter((render) => !/birthdays=\{\[\]\}/u.test(render));
  assert.equal(withBirthdays.length, 1, "exactly one render carries the family's birthdays");

  const bound = withBirthdays[0].match(/planningByPerson=\{([A-Za-z_$][\w$]*)\}/u);
  assert.ok(
    bound,
    "<EventsDashboard> must be passed planningByPerson; the prop defaults to {}, "
      + "so omitting it is not neutral -- it blanks every card's money",
  );
  assert.equal(
    bound[1],
    carrier,
    "the prop must be bound to the value the loader filled, not to a fresh empty object",
  );
});

test("the loader still returns the planning the page carries", () => {
  const loader = read("src", "utils", "supabase", "birthdays-server.ts");

  // The other half of the contract, so a rename cannot quietly satisfy the
  // regex above against a field nothing fills.
  assert.match(loader, /planningByPerson: Record<string, BirthdayPlanning>;/);
  assert.match(loader, /export type BirthdayPlanning = \{/);
  assert.match(loader, /planningByPerson\[row\.celebrant_person_id as string\] = \{/);
  for (const field of ["eventId", "budgetPennies", "spentPennies", "giftCount", "ideaCount"]) {
    assert.ok(loader.includes(field + ":"), "BirthdayPlanning needs " + field);
  }
});

// ---------------------------------------------------------------------------
// One route into Birthdays, not two
// ---------------------------------------------------------------------------

test("the dashboard header has no second Birthdays button", () => {
  const dashboard = read(...APP, "events-dashboard.tsx");
  const header = dashboard.slice(dashboard.indexOf("<PageHeader"), dashboard.indexOf("{error &&"));

  // The large secondary button in the header actions was a second door into the
  // room the Upcoming birthdays section below already opens -- on desktop AND
  // on mobile, since it carried `w-full sm:w-auto`.
  assert.doesNotMatch(header, /href="\/birthdays"/u, "the header must not link to /birthdays");

  // Create event is the header's remaining action, and stays admin-only.
  assert.match(header, /href="\/events\/new"/u);
  assert.match(header, /isAdmin \?/u);

  // No dead import left behind.
  assert.doesNotMatch(dashboard, /\bCake\b/u, "the Cake icon import goes with the button");
});

test("the Upcoming birthdays section and its All birthdays link both stay", () => {
  const dashboard = read(...APP, "events-dashboard.tsx");
  assert.match(dashboard, /<UpcomingBirthdaysSection/u);
  assert.match(dashboard, /Upcoming birthdays<\/h2>/u);

  const section = dashboard.slice(
    dashboard.indexOf("function UpcomingBirthdaysSection"),
    dashboard.indexOf("function BirthdayCard"),
  );
  assert.match(section, /href="\/birthdays"/u, "the section keeps the only route to the list");
  assert.ok(section.includes("All birthdays"), "the All birthdays link stays");
});

test("birthday navigation stays where it genuinely belongs", () => {
  /*
   * Removing the duplicate must not strip Birthdays out of the app.
   *
   * WHERE IT MOVED. Birthdays used to be listed on the event More screen,
   * which is where every family-level destination was listed. Birthdays belong
   * to the FAMILY, not to the event somebody happens to be standing in, so the
   * entry now lives in the family's own settings and the event screen no
   * longer offers it. See `src/lib/settings-scopes.ts`.
   */
  const scopes = read("src", "lib", "settings-scopes.ts");
  const birthdays = scopes.match(/\{[^}]*key: "birthdays"[^}]*\}/u)?.[0];
  assert.ok(birthdays, "Birthdays must still be a settings destination");
  assert.match(birthdays, /scope: "area"/u, "and it belongs to the family, not to a person or an event");
  assert.match(birthdays, /href: "\/birthdays"/u, "keeping the only route to the list");

  // The dedicated page is untouched.
  assert.equal(existsSync(join(root, ...APP, "birthdays", "page.tsx")), true);
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

  // The progress bar and the money line are both inside the `planning` arm, so
  // an unplanned birthday cannot render "£0 of £0" and read like a decision
  // somebody made.
  //
  // Comments are stripped first. They legitimately QUOTE the copy below while
  // explaining why it exists, and a doc comment that mentions "Planning not
  // started yet" would otherwise be found before the branch that renders it.
  const card = dashboard
    .slice(dashboard.indexOf("function BirthdayCard"))
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");

  // Sliced in order. The private arm comes first, the planned arm after it, and
  // the not-started arm last -- searching the whole component for ": planning"
  // would match the `hasPlanning: planning` argument in the state derivation
  // and hand back an empty arm that passes every negative assertion.
  const branch = card.indexOf("{isPrivate");
  const planned = card.indexOf(": planning", branch);
  const notStarted = card.indexOf("Planning not started yet", planned);
  assert.ok(branch > 0 && planned > branch && notStarted > planned, "the card has three arms, in that order");

  const arm = card.slice(planned, notStarted);
  assert.ok(arm.includes("FinancialProgressBar"), "the bar belongs to the planned arm");
  assert.ok(arm.includes("formatPennies"), "so does the money");

  // And the reader's OWN birthday is a third state, ahead of both: not "£0",
  // and not "not started" either, because saying "not started" to the celebrant
  // would be a statement about their own presents that may well be false.
  const privateArm = card.slice(branch, planned);
  assert.ok(privateArm.includes("SELF_PRIVATE_HEADLINE"), "the celebrant gets the required sentence");
  assert.ok(!privateArm.includes("Planning not started yet"), "and never the not-started one");
  assert.ok(!privateArm.includes("formatPennies"), "never shown a figure");
  assert.ok(!privateArm.includes("FinancialProgressBar"), "nor a progress bar");

  // And the bar itself only appears when a budget was actually set.
  assert.ok(
    card.includes('const hasBudget = state === "planned" && (planning?.budgetPennies ?? 0) > 0;'),
    "the bar's own guard is gated on the state too, not just on a budget being set",
  );
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

test("set_family_contributor writes one boolean and checks the RIGHT family's admin itself", () => {
  const sql = read("supabase", "migrations", ownerOf("set_family_contributor"));
  const body = functionBody(sql, "set_family_contributor");

  assert.match(body, /security definer/i);
  assert.match(body, /set search_path = ''/i);
  assert.match(body, /42501/, "a non-admin must be refused by the database, not by the UI");

  /*
   * THE AREA COMES FROM THE PERSON, NOT FROM THE REQUEST.
   *
   * `is_app_admin()` answers about the Area the caller SAID they are acting in
   * (migration 038). Asking it and then writing `where id = p_person_id` puts
   * the question and the row in different families -- and an administrator of
   * one who merely belongs to another walked straight through migration 037's
   * barrier, which checks membership rather than administration. Proven on a
   * real PostgreSQL before migration 044 was written.
   */
  assert.match(body, /area_of_person\(/u, "it must resolve the Area of the person being changed");
  assert.match(body, /is_area_admin\(/u, "and require administration OF THAT Area");
  assert.doesNotMatch(body, /is_app_admin\(\)/u,
    "is_app_admin() answers about the acting Area, which is not necessarily the person's");

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
  // `member.personId` until Q19; `row.person_id` since. The pool is now built
  // from `list_area_access()`'s own rows -- which use the database's column
  // names -- rather than from the service-role listing the route used to
  // assemble. Same person, same boolean, one fewer privileged read.
  assert.match(client, /p_person_id: row\.person_id/);
  assert.match(client, /p_eligible: !row\.isFamilyContributor/);
  /*
   * A toggle must announce its state. Five screens had each grown their own
   * copy of this chip; they share ToggleChip now, so the guarantee is
   * asserted in both places — that this screen uses the shared control, and
   * that the shared control is the thing that carries aria-pressed.
   */
  assert.match(client, /<ToggleChip[\s\S]*?on=\{on\}/, "the contributor toggle uses the shared chip");
  const ui = read(...APP, "components", "ui", "index.tsx");
  assert.match(ui, /export function ToggleChip\(/);
  assert.match(ui, /aria-pressed=\{on\}/, "a toggle must announce its state");

  /*
   * WHERE THE FLAG COMES FROM NOW, and why it is no longer the admin route.
   *
   * `list_area_access()` answers about ACCESS and carries no contributor
   * eligibility -- correctly, because eligibility belongs to the person rather
   * than to their login: somebody with no account at all can be a contributor,
   * and somebody with access may not be.
   *
   * So the screen reads the flag itself, through the CALLER'S OWN session,
   * filtered by the ids the routine just returned. That is Area-scoped by
   * construction: there is no Area filter to get wrong, and `people` is behind
   * `is_area_member` either way. The service role is not involved at all, which
   * is the improvement -- the route used to fetch every person in the family
   * with a client that can see every family there is.
   */
  assert.match(client, /\.from\("people"\)\.select\("id,is_family_contributor"\)\.in\("id", ids\)/u);
  assert.match(client, /const ids = list\.map\(\(row\) => row\.person_id\);/u);
  assert.match(client, /isFamilyContributor: contributors\.get\(row\.person_id\) \?\? false/u);

  const route = read(...APP, "api", "admin", "family-access", "route.ts");
  assert.ok(!route.includes("is_family_contributor"),
    "the privileged route no longer reads the contributor flag at all");
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

test("a BIRTHDAY never offers Add recipient", () => {
  const people = read(...APP, "people", "people-screen.tsx");
  assert.match(people, /const addButton = isAdmin && fixedRecipientPersonId === null \? \(/);
  assert.match(people, /const addForm = isAdmin && fixedRecipientPersonId === null && adding \? \(/);

  // The route supplies that prop from the event TYPE, so an event that merely
  // names somebody -- a wedding, an anniversary -- does not get locked.
  const route = read(...APP, "events", "[eventId]", "people", "page.tsx");
  assert.match(route, /hasFixedSingleRecipient\(event\) \? event\.celebrantPersonId : null/);

  const settings = read(...APP, "events", "[eventId]", "settings", "settings-screen.tsx");
  assert.match(settings, /const isAboutOnePerson = hasFixedSingleRecipient\(event\);/);
  assert.match(settings, /disabled=\{busy \|\| on \|\| isAboutOnePerson\}/);
});

test("that rule is decided by the event TYPE, and lives in exactly one place", () => {
  // The People screen has no event type at all, so it could not branch on one
  // even if somebody wanted to.
  const people = read(...APP, "people", "people-screen.tsx");
  const peopleLogic = people.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  for (const literal of ['"birthday"', "'birthday'", '"christmas"', "'christmas'"]) {
    assert.ok(!peopleLogic.includes(literal), `people-screen must not branch on ${literal}`);
  }

  // Nor does Settings decide it locally. It calls the shared helper, so the
  // string "birthday" appears in exactly one place in the whole application and
  // both screens cannot drift apart.
  const settings = read(...APP, "events", "[eventId]", "settings", "settings-screen.tsx");
  const derivation = settings.slice(
    settings.indexOf("const isAboutOnePerson"),
    settings.indexOf("const addRecipient"),
  );
  assert.ok(derivation.length > 0, "the derivation must exist");
  assert.match(derivation, /hasFixedSingleRecipient\(event\)/);
  assert.ok(
    !/"birthday"|'birthday'/u.test(derivation),
    "the derivation must ask the helper, not compare a type string itself",
  );

  // And the helper is the single owner of the rule.
  const events = read("src", "lib", "events.ts");
  assert.match(events, /export function hasFixedSingleRecipient\(event: Pick<EventSummary, "type">\): boolean \{/);
  assert.match(events, /return isBirthdayOccurrence\(event\);/);

  // The negative case is the whole reason this changed: an event that names a
  // celebrant but is NOT a birthday keeps editable recipients.
  const nonBirthday = { type: "wedding" };
  assert.equal(hasFixedSingleRecipient(nonBirthday), false, "a wedding may add a second recipient");
  assert.equal(hasFixedSingleRecipient({ type: "christmas" }), false);
  assert.equal(hasFixedSingleRecipient({ type: "other" }), false);
  assert.equal(hasFixedSingleRecipient({ type: "birthday" }), true);
});

// ---------------------------------------------------------------------------
// Event creation
// ---------------------------------------------------------------------------

test("Christmas can be created from Create Event, and a birthday still cannot", () => {
  const events = read("src", "lib", "events.ts");

  // Christmas keeps its own template: a family needs 2027 after 2026, and a
  // household signing up has none at all. A duplicate is refused by the
  // database (migration 025's one-per-year index), not by hiding the option.
  assert.match(events, /export const EVENT_TEMPLATES = \["christmas", "custom"\] as const;/u);

  // Birthdays are the exception, and for a reason: they are started from the
  // person, in one transaction, with a budget and a plan.
  const block = events.slice(events.indexOf("EVENT_TEMPLATES"), events.indexOf("EVENT_TEMPLATES") + 400);
  assert.ok(!block.includes('"birthday"'), "birthdays start from the person");

  const form = read(...APP, "events", "new", "create-event-form.tsx");
  assert.match(form, /href="\/birthdays"/u, "and the form says where");
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

  // Christmas skips years already taken, because the database enforces one per
  // year and offering a year that cannot save is worse than offering none.
  assert.match(form, /nextOccurrenceYear\("christmas", today, takenYears\.christmas \?\? \[\]\)/);
  // A preset asks the same question for its own occasion.
  assert.match(form, /nextOccurrenceYear\(preset\.occasion, today, takenYears\[preset\.occasion\] \?\? \[\]\)/);

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

// ---------------------------------------------------------------------------
// The money engines, fingerprinted
// ---------------------------------------------------------------------------

/**
 * The three modules that decide what anybody owes, pinned by content hash.
 *
 * This continuation changed what a notification SAYS about money. It changed
 * nothing about how that money is worked out -- and "nothing" is a claim worth
 * proving rather than asserting, because the new copy quotes two figures from
 * two engines and the tempting shortcut would have been to adjust one of them
 * to make the sentence tidier.
 *
 * The repository already uses this discipline for migrations 001-024
 * (`scripts/event-model.test.mjs`). The same reasoning applies here: these
 * files are load-bearing for real family money, so an edit to one should be a
 * deliberate act that updates a fingerprint, never a quiet diff nobody notices.
 *
 * Hashed over LF-normalised content, so a checkout with different line endings
 * is not reported as a change to the arithmetic.
 */
test("the Owed engine and the payment rules are byte-for-byte unchanged", () => {
  const fingerprints = {
    "owed.ts": "429c11a3be054c51030b793018596c38404ec4c354d95b58a6d206fdbb230c9f",
    // Updated deliberately in Q3: the refusal shown when somebody who is not
    // the payer, the payee or an administrator tries to record a confirmed
    // payment said "Only Global Admin can...". "Global Admin" is the pre-Areas
    // model -- administration is per family now, and one login can administer
    // one family while being an ordinary member of another, so the old wording
    // named a role that does not exist. WORDING ONLY: one string literal. The
    // arithmetic, the bounds, the error codes and the return shapes are
    // untouched, and `owed.ts` beside it did not move at all, which is the
    // whole reason this fingerprint exists to make somebody say so.
    "payment-confirmation.ts": "fe60b858c410b60f1ceac17cd80cc594e0ce297c02c2288e665d789f3b74935c",
    // Updated deliberately in Phase 2: the budget validation message said
    // "Enter a valid Christmas budget" on a screen that now sets budgets for
    // birthdays, Halloweens and anything else. WORDING ONLY -- the arithmetic,
    // the bounds and the return shapes are untouched, which is the whole reason
    // this fingerprint exists to make somebody say so.
    "recipient-allocations.ts": "ddf1cb50f75691ad98bfc3d8f2b3582309b14e343d32ba1c94d4aa7dc66e9a09",
  };

  for (const [file, expected] of Object.entries(fingerprints)) {
    const source = read("src", "lib", file).replace(/\r\n/gu, "\n");
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      expected,
      `src/lib/${file} changed. If that was deliberate, say so and update the `
        + "fingerprint; if it was not, the arithmetic behind real money just moved.",
    );
  }
});

test("the notification layer reads money and never computes it", () => {
  const audience = read("src", "lib", "notification-audience.ts");
  const content = read("src", "lib", "notification-content.ts");
  const dispatch = read("src", "lib", "notification-dispatch.ts");

  // The increase is READ from the allocation row. The moment it is added,
  // subtracted, split or scaled here, it has stopped being authoritative.
  for (const [name, source] of [["audience", audience], ["content", content], ["dispatch", dispatch]]) {
    assert.doesNotMatch(source, /responsibility_?[Pp]ennies\s*[-+*/]/u, `${name} manipulates a share`);
    assert.doesNotMatch(source, /increasePennies\s*[-+*/]/u, `${name} manipulates the increase`);
    assert.doesNotMatch(source, /amountPennies\s*[-+*/](?!\/)/u, `${name} manipulates a balance`);
  }

  // Nor is the increase guessed from the purchase total by dividing it up.
  assert.doesNotMatch(audience, /event\.amountPennies\s*\/|\.length\s*\)?\s*\)?\s*;?\s*\/\s*/u);
  assert.ok(
    !audience.includes("splitPenniesEqually"),
    "an equal split would be a guess; the allocation row is the fact",
  );

  // And the delta reaches the copy from the event, not from a fresh read.
  assert.match(audience, /increasePennies: share/u);
  assert.match(dispatch, /responsibilityPennies: allocation\.responsibility_pennies/u);
});

test("payment notifications were not touched by the owed-increase change", () => {
  const content = read("src", "lib", "notification-content.ts");

  // The four payment builders keep their exact sentences. The new requirement
  // was about a purchase increasing what somebody owes; a confirmation, a
  // rejection and an admin override are different events with settled wording.
  assert.match(content, /`\$\{input\.reviewerName\} rejected your \$\{claimed\} payment\.`/u);
  assert.match(content, /`\$\{input\.reviewerName\} confirmed your \$\{claimed\} payment\.`/u);
  assert.match(content, /`\$\{input\.payerName\} says they paid you \$\{formatPennies\(input\.amountPennies\)\}\.`/u);
  assert.match(content, /`\$\{input\.actorName\} recorded your \$\{formatPennies\(input\.amountPennies\)\} payment\.`/u);

  // No payment builder learned about an increase: a payment REDUCES a balance,
  // and "this payment adds" would be exactly backwards.
  const paymentBuilders = content.slice(content.indexOf("export function paymentRecordedNotification"));
  assert.doesNotMatch(paymentBuilders, /increasePennies/u);
  assert.doesNotMatch(paymentBuilders, /This purchase adds/u);
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

/**
 * The single migration that INTRODUCES `symbol`.
 *
 * DEFINITIONS ONLY. This used to match any mention, which quietly turned
 * "exactly one migration" into a promise that no later migration would ever
 * refer to the symbol again -- so a preflight check reading
 * `to_regproc('public.set_family_contributor')`, or a new function whose name
 * merely begins with an existing one, broke a test about ownership. Referring
 * to something is not owning it.
 *
 * Plain string matching rather than a regex: the three shapes a definition
 * takes here are fixed, and they read better than an escaped pattern.
 */
/**
 * THE MIGRATION THAT HAS THE LAST WORD, not the one that spoke first.
 *
 * This used to insist a symbol was introduced exactly ONCE, which was true only
 * while nothing had ever been redefined. A function can legitimately be
 * replaced later: migration 039 rewrote `set_person_birthday` to ask about
 * Areas, and 044 did the same for `set_family_contributor` and
 * `set_person_archived` after both were PROVEN to let the administrator of one
 * family edit people in another. Under the old rule every such fix failed here
 * with "found 2" -- a message about counting, not about whether the fix was
 * right, and one that would push somebody towards editing an applied migration
 * to make it go away.
 *
 * The NEWEST definition is checked, because it is the one the database runs.
 */
function ownerOf(symbol) {
  const name = symbol.toLowerCase();
  const introduces = (sql) => {
    const text = sql.toLowerCase();
    return text.includes(`add column if not exists ${name} `)
      || text.includes(`add column ${name} `)
      || text.includes(`create or replace function public.${name}(`)
      || text.includes(`create function public.${name}(`);
  };

  const files = readdirSync(join(root, "supabase", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => introduces(read("supabase", "migrations", file)))
    .sort();
  assert.notEqual(files.length, 0, `${symbol} is introduced by no migration`);
  return files[files.length - 1];
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
