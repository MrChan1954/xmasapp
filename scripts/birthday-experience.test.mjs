import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ---------------------------------------------------------------------------
// Checkpoint 4.1: birthdays are a PRODUCT, not a pile of event rows.
//
// THE PROPERTY THIS SUITE PROTECTS
//   A family with twenty birthdays must get twenty entries on the BIRTHDAYS
//   PAGE -- derived from the permanent dates, whether or not anybody has
//   planned anything -- and NOT twenty cards among the events. The moment the
//   root page starts listing occurrences, the two sections that matter get
//   buried, and nobody would notice from a screenshot of a three-person family.
//
//   The dashboard shows a WINDOW on that list: one rolling calendar month, so
//   the front page carries what can be acted on now. That is a presentation
//   rule and nothing else -- the twenty are all still there, one tap away, and
//   the window can never remove one. Both halves are pinned below.
//
//   The rest of the file holds the two rules that come with that: exactly two
//   reminder stages, and an event can only be physically deleted while there is
//   nothing in it to lose.
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Line endings are normalised on the way in. Git stores LF and checks files out
// as CRLF on Windows, so a multi-line pattern written with \n silently stops
// matching a file nobody has edited -- a false failure about the product,
// caused by a checkout setting.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");

const { groupDashboardEvents, isBirthdayOccurrence } = await import("../src/lib/events.ts");
// The card's state rule is a real function, so it is exercised as one.
const { birthdayCardState } = await import("../src/lib/birthdays.ts");
const {
  REMINDER_STAGES, birthdayWorkspacePath,
  dueReminderStages, upcomingBirthdays,
} = await import("../src/lib/birthdays.ts");

const REMINDER_MIGRATION = "202608100027_two_stage_birthday_reminders_and_safe_event_deletion.sql";
const sql = read("supabase", "migrations", REMINDER_MIGRATION);

// The birthday journey as it stands: a resolver, a focused setup screen, and
// the history page. The financial landing screen that used to sit between the
// dashboard and Event Home is gone.
const resolverPage = read("src", "app", "birthdays", "[personId]", "page.tsx");
const setupScreen = read("src", "app", "birthdays", "[personId]", "start-planning-screen.tsx");
const historyScreen = read("src", "app", "birthdays", "[personId]", "history", "history-screen.tsx");

/** A family of `count` people, each with a birthday, none of them planned. */
function familyWithBirthdays(count) {
  return Array.from({ length: count }, (_, index) => ({
    personId: `person-${index}`,
    name: `Person ${String(index).padStart(2, "0")}`,
    // Spread across the year so the ordering has something real to do.
    birthday: { month: (index % 12) + 1, day: ((index * 7) % 27) + 1, year: null },
  }));
}

/** The event row one year of a person's birthday planning lives in. */
function birthdayOccurrence(personId, index) {
  return {
    id: `event-${index}`,
    name: `Person ${index}'s Birthday 2026`,
    type: "birthday",
    eventDate: `2026-${String((index % 12) + 1).padStart(2, "0")}-05`,
    status: "active",
    year: null,
    celebrantPersonId: personId,
    description: null,
  };
}

const CHRISTMAS = {
  id: "christmas-2026", name: "Christmas 2026", type: "christmas",
  eventDate: "2026-12-25", status: "active", year: 2026,
  celebrantPersonId: null, description: null,
};
const ANNIVERSARY = {
  id: "anniversary", name: "Mum & Dad's 40th", type: "anniversary",
  eventDate: "2026-09-12", status: "active", year: null,
  celebrantPersonId: null, description: null,
};

// ---------------------------------------------------------------------------
// 1. Twenty birthdays, zero extra cards
// ---------------------------------------------------------------------------

test("20 saved birthdays produce 20 upcoming entries and 0 root event cards", () => {
  const people = familyWithBirthdays(20);
  // Every one of them has also been PLANNED, which is the worst case: twenty
  // real rows in `events` that the old dashboard would have rendered.
  const events = [CHRISTMAS, ANNIVERSARY, ...people.map((p, i) => birthdayOccurrence(p.personId, i))];

  const grouped = groupDashboardEvents(events, "2026-08-23");
  const cards = [
    ...grouped.christmas,
    ...grouped.special.upcoming,
    ...grouped.special.past,
    ...grouped.special.archived,
  ];

  assert.equal(cards.length, 2, "only Christmas and the anniversary are cards");
  assert.deepEqual(cards.map((event) => event.id).sort(), ["anniversary", "christmas-2026"]);
  assert.equal(grouped.birthdayOccurrences.length, 20, "the occurrences are set aside, not lost");
  assert.ok(
    !cards.some((event) => isBirthdayOccurrence(event)),
    "no birthday occurrence may appear as a dashboard card, in any group",
  );

  // And all twenty are still reachable, as birthdays.
  assert.equal(upcomingBirthdays(people, "2026-08-23").length, 20);
});

test("an archived or past birthday occurrence is still not a card", () => {
  // The easy bug: filter birthdays out of "upcoming" and forget the other two
  // lists, so old occurrences pile up under Past for ever.
  const events = [
    CHRISTMAS,
    { ...birthdayOccurrence("p1", 1), eventDate: "2024-03-01", status: "active" },
    { ...birthdayOccurrence("p2", 2), status: "archived" },
  ];
  const grouped = groupDashboardEvents(events, "2026-08-23");
  assert.deepEqual(grouped.special.past, []);
  assert.deepEqual(grouped.special.archived, []);
  assert.equal(grouped.birthdayOccurrences.length, 2);
});

test("the dashboard's three groups are Christmas, birthdays and special events", () => {
  const grouped = groupDashboardEvents([CHRISTMAS, ANNIVERSARY], "2026-08-23");
  assert.deepEqual(grouped.christmas.map((e) => e.id), ["christmas-2026"]);
  assert.deepEqual(grouped.special.upcoming.map((e) => e.id), ["anniversary"]);

  // Past Christmases stay under Christmas rather than falling into a generic
  // "Past" list: the family looks for Christmas by name.
  const withOld = groupDashboardEvents(
    [CHRISTMAS, { ...CHRISTMAS, id: "christmas-2025", name: "Christmas 2025", eventDate: "2025-12-25", year: 2025 }],
    "2026-08-23",
  );
  assert.deepEqual(withOld.christmas.map((e) => e.id), ["christmas-2026", "christmas-2025"]);
  assert.deepEqual(withOld.special.past, []);
});

// ---------------------------------------------------------------------------
// 2. The dashboard reads birthdays, not events
// ---------------------------------------------------------------------------

test("upcoming birthdays are computed with no event in sight", () => {
  // THE POINT OF THE WHOLE REDESIGN. Nothing below has an event, an event id or
  // a planning row anywhere near it, and the dashboard still knows what is
  // coming up and how far away it is.
  const people = [
    { personId: "a", name: "Ana", birthday: { month: 9, day: 10, year: null } },
    { personId: "b", name: "Ben", birthday: { month: 11, day: 6, year: null } },
  ];
  const upcoming = upcomingBirthdays(people, "2026-08-23");
  assert.deepEqual(upcoming.map((p) => p.name), ["Ana", "Ben"]);
  assert.equal(upcoming[0].next.date, "2026-09-10");
  assert.equal(upcoming[0].next.daysAway, 18);
  assert.equal(upcoming[1].next.daysAway, 75);
  for (const entry of upcoming) {
    assert.ok(!("eventId" in entry), "an upcoming birthday carries no event id");
  }
});

test("December rolls into January without anything being recreated", () => {
  const people = [
    { personId: "a", name: "Ana", birthday: { month: 1, day: 3, year: null } },
    { personId: "b", name: "Ben", birthday: { month: 11, day: 6, year: null } },
  ];
  // On the 30th of December, January's birthday is days away and November's is
  // nearly a year off.
  const order = upcomingBirthdays(people, "2026-12-30").map((p) => p.name);
  assert.deepEqual(order, ["Ana", "Ben"]);
  assert.equal(upcomingBirthdays(people, "2026-12-30")[0].next.date, "2027-01-03");
  // Four days later, on the birthday itself, it is still first and marked today.
  const onTheDay = upcomingBirthdays(people, "2027-01-03")[0];
  assert.equal(onTheDay.name, "Ana");
  assert.equal(onTheDay.next.isToday, true);
});

test("the dashboard shows everything in the window, and says where the rest are", () => {
  const dashboard = read("src", "app", "events-dashboard.tsx");

  // THE CAP IS GONE, and must stay gone. A count-based cap and a time-based
  // window solve the same problem; keeping both meant the fifth birthday in a
  // busy month -- the one with least time left to plan for -- was the one
  // hidden. The window is the only rule now.
  assert.ok(!dashboard.includes("DASHBOARD_BIRTHDAY_LIMIT"), "the four-card cap must not come back");
  assert.doesNotMatch(dashboard, /shown\.slice\(|withinWindow\.slice\(/u, "and nor may a new one");
  assert.match(dashboard, /href="\/birthdays"/, "the full list is one tap away");
  assert.match(
    dashboard,
    /All \$\{birthdays\.length\} birthdays/,
    "the link counts EVERY birthday, not the windowed few -- it is the way to the full list",
  );

  // The section renders the person's own numbers: date, distance, and Today.
  assert.match(dashboard, /formatBirthday\(person\.birthday\.month, person\.birthday\.day\)/);
  assert.match(dashboard, /describeDaysAway\(person\.next\.daysAway\)/);
  assert.match(dashboard, /person\.next\.isToday\s*\n?\s*\? <Badge tone="success">Today<\/Badge>/u);

  // And the financial snapshot, built from the app's existing helpers rather
  // than a second progress engine.
  assert.match(dashboard, /purchaseProgressStatus\(planning\.spentPennies, planning\.budgetPennies\)/u);
  assert.match(dashboard, /<FinancialProgressBar/u);
  assert.match(dashboard, /Planning not started yet/u, "a clean state when there is no plan");
  assert.match(dashboard, /birthdayWorkspacePath\(person\.personId\)/, "a card opens the PERSON");
});

test("the dashboard shows one rolling calendar month, not the whole year", () => {
  const dashboard = read("src", "app", "events-dashboard.tsx");

  // The cut is the shared helper, applied to the family's own date. A local
  // day-count here would be a second calendar, free to disagree with the model
  // about what "one month" means in February.
  assert.match(dashboard, /const shown = birthdaysWithinWindow\(birthdays, today\);/u);

  // No hand-rolled window. Scoped to the SECTION, because the card below it
  // legitimately compares daysAway to highlight a birthday inside a week --
  // that is styling, not a cut, and asserting over the whole file would
  // conflate the two.
  const section = dashboard.slice(
    dashboard.indexOf("function UpcomingBirthdaysSection"),
    dashboard.indexOf("function BirthdayCard"),
  );
  assert.ok(section.length > 0, "the section is still its own component");
  assert.doesNotMatch(section, /\b30\s*\*\s*86_?400|\b30\s*\)?\s*\*\s*24/u, "no thirty-day approximation");
  assert.doesNotMatch(section, /daysAway\s*<=?\s*\d+/u, "no day-count threshold");
  assert.doesNotMatch(section, /setMonth\(|getMonth\(\)|new Date\(/u, "no local date arithmetic");

  // The section is handed EVERY birthday, so the link can name the real total
  // and the empty state can tell "none this month" apart from "none at all".
  assert.match(dashboard, /birthdays=\{birthdays\}/u);
  assert.match(dashboard, /Nothing in the next month/u);
  assert.match(dashboard, /No birthdays saved yet/u);
});

test("the dashboard window is a view, and the Birthdays page is the record", () => {
  const dashboard = read("src", "app", "events-dashboard.tsx");
  const screen = read("src", "app", "birthdays", "birthdays-screen.tsx");

  // /birthdays lists everybody: no window, no cap. It is the full system.
  assert.match(screen, /upcomingBirthdays\(shown, today\)/u);
  assert.ok(!screen.includes("birthdaysWithinWindow"), "the full list is never windowed");
  assert.ok(!screen.includes("DASHBOARD_BIRTHDAY_LIMIT"), "and never capped");
  assert.match(screen, /peopleWithoutBirthdays/u, "including the people with no date yet");

  // The dashboard's route to it survives.
  assert.match(dashboard, /href="\/birthdays"/u);

  // Filtering is a read. Nothing on the dashboard writes a birthday, and the
  // loader it reads from is a select.
  for (const forbidden of ["delete", "update", ".upsert(", ".insert(", ".rpc("]) {
    assert.ok(!dashboard.includes(forbidden), `the dashboard must not ${forbidden} anything`);
  }
  const loader = read("src", "utils", "supabase", "birthdays-server.ts");
  assert.ok(!/\.(insert|update|delete|upsert)\(/u.test(loader), "the birthday loader only reads");
});

// ---------------------------------------------------------------------------
// Your own birthday
//
// The rule: the celebrant never sees the planning for their own birthday, and
// admin does not beat it. Migration 031 enforces it in row level security --
// these pin the APPLICATION half, which is that the app explains the state
// instead of showing an empty or misleading one.
// ---------------------------------------------------------------------------

/**
 * The reader's own birthday card, field by field.
 *
 * The live regression this replaces: the card said "Planning not started yet"
 * and offered "START PLANNING →" for the reader's own birthday -- an invitation
 * to buy your own present, and a statement about your own presents that might
 * well have been false.
 *
 * These read the card's SOURCE and slice it into its three arms, so each
 * assertion is about the branch that actually renders, not about the file
 * happening to contain a word somewhere.
 */
function birthdayCardArms() {
  const dashboard = read("src", "app", "events-dashboard.tsx");
  const card = dashboard
    .slice(dashboard.indexOf("function BirthdayCard"))
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");

  // Sliced in ORDER, each arm found after the one before it. Searching the
  // whole component for ": planning" matched the `hasPlanning: planning`
  // argument up in the state derivation and silently produced an empty arm --
  // which every "must not contain" assertion would then have passed.
  const branch = card.indexOf("{isPrivate");
  const planned = card.indexOf(": planning", branch);
  const notStarted = card.indexOf("Planning not started yet", planned);
  const cta = card.indexOf('<div className="mt-auto', notStarted);
  assert.ok(branch > 0 && planned > branch && notStarted > planned && cta > notStarted,
    "the card must still have a private arm, a planned arm, a not-started arm and a call to action");

  return {
    card,
    header: card.slice(card.indexOf('<div className="flex items-start gap-3">'), branch),
    privateArm: card.slice(branch, planned),
    plannedArm: card.slice(planned, notStarted),
    action: card.slice(cta),
  };
}

test("the self card says the required sentence, and never the not-started one", () => {
  const { privateArm } = birthdayCardArms();
  assert.match(privateArm, /SELF_PRIVATE_HEADLINE/u, "the headline is the shared constant");
  assert.match(privateArm, /SELF_PRIVATE_DETAIL/u);
  assert.ok(!privateArm.includes("Planning not started yet"), "and never the not-started sentence");
});

test("the self card offers the wishlist, and nothing that is not the wishlist", () => {
  const { action, privateArm } = birthdayCardArms();

  /*
   * WHAT CHANGED, AND WHAT DID NOT.
   *
   * The card used to offer nothing at all, because there was nothing the
   * reader could do with their own birthday. There is now exactly one thing --
   * their own wishlist -- so the row is no longer suppressed and its LABEL is
   * what branches instead.
   *
   * The forbidden half is unchanged and asserted harder: the private label is
   * sliced out on its own, so "Start planning" or "Open" cannot pass by being
   * present somewhere else in the row.
   */
  const privateLabel = action.slice(action.indexOf("isPrivate"), action.indexOf(": planning ?"));
  assert.ok(privateLabel.length > 0, "the label must branch on the private state");
  assert.match(privateLabel, /SELF_PRIVATE_CTA/u, "and offer the wishlist, from the shared constant");

  for (const forbidden of ["Start planning", "Open →", "Budget", "Purchased"]) {
    assert.ok(!privateLabel.includes(forbidden), `the self card must not offer ${forbidden}`);
    assert.ok(!privateArm.includes(forbidden), `the self card must not show ${forbidden}`);
  }
});

test("the self card hides every financial figure", () => {
  const { privateArm } = birthdayCardArms();
  for (const forbidden of [
    "formatPennies", "budgetPennies", "spentPennies", "FinancialProgressBar",
    "giftCount", "ideaCount", "purchaseProgressStatus", "Badge",
  ]) {
    assert.ok(!privateArm.includes(forbidden), `the private card must not render ${forbidden}`);
  }
});

test("nothing financial is even COMPUTED for the reader's own card", () => {
  // Stronger than "the JSX does not use it". A badge derived from planning the
  // reader may not see is a leak waiting for somebody to move one line.
  const { card } = birthdayCardArms();
  assert.match(card, /const state = birthdayCardState\(\{ isSelf, hasPlanning: planning !== undefined \}\)/u);
  assert.match(card, /const status: PurchaseProgressStatus \| null = state === "planned" && planning/u);
  assert.match(card, /const hasBudget = state === "planned" &&/u);
});

test("the self card still shows the date, the days away and the age", () => {
  // These are not gift-planning data. The date is on the family calendar and
  // the age follows from it, so keeping them from the reader would be pointless
  // as well as unfriendly.
  const { header, card } = birthdayCardArms();
  assert.match(header, /formatBirthday\(person\.birthday\.month, person\.birthday\.day\)/u);
  assert.match(header, /describeDaysAway\(person\.next\.daysAway\)/u);
  assert.match(header, /\{turning &&/u, "the age is rendered in the shared header");

  // The header is ABOVE the private/planned branch, so all three appear
  // whatever the state -- which is exactly why they are asserted here.
  assert.ok(card.indexOf("{turning &&") < card.indexOf("{isPrivate"), "the age precedes the state branch");
  assert.match(card, /const turning = describeTurningAge\(person\.birthday, person\.next\.year\);/u,
    "and it comes from the occurrence chosen for this card, not from today");
});

test("the private card is identical whether or not planning exists", () => {
  // The point of the state: for the reader's own birthday, planning makes no
  // difference at all, so the card cannot leak it by the branch it takes.
  const { privateArm } = birthdayCardArms();
  assert.ok(!privateArm.includes("planning"), "the private arm must not consult planning at all");

  // And the model agrees, which is what the component relies on.
  assert.equal(
    birthdayCardState({ isSelf: true, hasPlanning: true }),
    birthdayCardState({ isSelf: true, hasPlanning: false }),
  );
});

test("the rule is the linked person id, never a name, an email or a position", () => {
  const dashboard = read("src", "app", "events-dashboard.tsx");
  assert.match(dashboard, /isSelf=\{person\.personId === viewerPersonId\}/u);

  const card = dashboard.slice(dashboard.indexOf("function BirthdayCard"));
  for (const wrong of ["person.name ===", "email", "index === 0", '=== "Taylor"']) {
    assert.ok(!card.includes(wrong), `self must not be identified by ${wrong}`);
  }

  // And the id comes from the membership row on the server -- specifically the
  // membership in the AREA ON SCREEN, which is what `getCurrentMember` resolves.
  // A `maybeSingle()` here would error the moment one login held two.
  const loader = read("src", "utils", "supabase", "birthdays-server.ts");
  assert.match(loader, /getCurrentMember\(\)/u, "the membership comes from the Area-aware helper");
  assert.match(loader, /const viewerPersonId = \(member\.person_id as string \| null\) \?\? null;/u);
  assert.ok(!loader.includes('.from("app_members")'),
    "the loader must not resolve a membership by hand any more");
});

test("the loader will not carry the reader's own planning even if RLS let it through", () => {
  // Two independent locks. Row level security is the authority, but it has
  // nobody to hide the birthday FROM when a membership has no person linked --
  // and that is precisely when the dashboard also cannot tell it is self. This
  // guard fails in the safe direction in that case.
  const loader = read("src", "utils", "supabase", "birthdays-server.ts");
  assert.match(loader, /if \(row\.celebrant_person_id === viewerPersonId\) continue;/u);

  const guard = loader.indexOf("if (row.celebrant_person_id === viewerPersonId) continue;");
  const assignment = loader.indexOf("planningByPerson[row.celebrant_person_id as string] = {");
  assert.ok(guard > 0 && assignment > guard, "the guard must come before the assignment");
});

test("everybody else's card is untouched by all of this", () => {
  const { plannedArm, action, card } = birthdayCardArms();

  // Planned: the money is still there in full.
  for (const shown of ["formatPennies", "budgetPennies", "spentPennies", "FinancialProgressBar", "giftCount", "ideaCount"]) {
    assert.ok(plannedArm.includes(shown), `a planned birthday must still show ${shown}`);
  }

  // Unplanned: still says so, and still invites an admin to start it.
  assert.match(card, /Planning not started yet/u);
  assert.match(action, /planning \? "Open →" : isAdmin \? "Start planning →" : "Open →"/u);
});

test("the resolver shows a privacy screen for your own birthday, and never redirects into it", () => {
  const page = read("src", "app", "birthdays", "[personId]", "page.tsx");

  // Checked BEFORE the redirect. Sending the celebrant to their own Event Home
  // is precisely the disclosure the rule exists to prevent.
  const selfCheck = page.indexOf("workspace.isSelf");
  const redirectCall = page.indexOf("redirect(destination)");
  assert.ok(selfCheck > 0, "the resolver must ask whether this is the reader's own birthday");
  assert.ok(redirectCall > 0, "and still redirect for everybody else's");
  assert.ok(selfCheck < redirectCall, "the privacy check must come first");

  assert.match(page, /<OwnBirthdayScreen/u);

  // A 404 would read as a broken app to the one person certain to try it.
  const selfArm = page.slice(selfCheck, redirectCall);
  assert.ok(!selfArm.includes("notFound()"), "their own birthday is not an error");
  assert.ok(!selfArm.includes("redirect("), "and not a redirect");
});

test("the own-birthday screen is a wishlist, and shows only what is not a secret", () => {
  const screen = read("src", "app", "birthdays", "[personId]", "own-birthday-screen.tsx");

  /*
   * IT USED TO BE A CLOSED DOOR: "You can't see what you're getting", and
   * nothing else on the page. That sentence was true about the presents and
   * wrong about the birthday -- there was one useful thing this person could
   * do here and the screen did not let them do it.
   *
   * The reassurance survives, in `WISHLIST_INTRO`; what changes is that it is
   * now underneath a list they can write rather than being the whole page.
   */
  assert.match(screen, /WISHLIST_HEADLINE/u, "the heading is the shared constant");
  assert.match(screen, /WISHLIST_INTRO/u, "and so is the sentence about the surprise");
  assert.match(screen, /applies to admins too/iu, "the rule outranks admin, and says so");
  assert.match(screen, /<WishlistEditor/u, "and it renders the list");

  // The date and the age are theirs. The money is not.
  assert.match(screen, /formatBirthday\(birthday\.month, birthday\.day\)/u);
  assert.match(screen, /describeTurningAge\(/u);
  for (const forbidden of ["formatPennies", "budgetPennies", "spentPennies", "FinancialProgressBar", "giftCount", "ideaCount"]) {
    assert.ok(!screen.includes(forbidden), `the own-birthday screen must not render ${forbidden}`);
  }
  assert.ok(!screen.includes("StartPlanningScreen"), "and must not offer to start it");

  // THE EDITOR ITSELF REACHES NOTHING BUT THE WISHLIST TABLE. It is the one
  // component the celebrant can drive, so what it is allowed to query matters
  // as much as what it renders.
  const editor = read("src", "app", "birthdays", "[personId]", "wishlist-editor.tsx");
  for (const table of ["purchases", "gift_ideas", "christmas_recipients", "contributors",
    "purchase_allocations", "recipient_contributions", "settlements", "payment_receipts", "events"]) {
    assert.ok(!editor.includes(`from("${table}")`), `the wishlist editor must not read ${table}`);
  }
  assert.match(editor, /from\("birthday_wishlist_ideas"\)/u);
  assert.ok(!editor.includes(".rpc("),
    "and must not call a SECURITY DEFINER routine, which is what bypasses a policy");
});

test("the loader refuses to hand the celebrant a workspace or a contributor list", () => {
  const loader = read("src", "utils", "supabase", "birthdays-server.ts");

  assert.match(loader, /const isSelf = \(member\.person_id as string \| null\) !== null/u);
  assert.match(loader, /member\.person_id === person\.personId/u);
  assert.match(loader, /if \(isSelf \|\| events\.length === 0\) \{/u,
    "their own birthday takes the same empty path as an unplanned one");
  assert.match(loader, /eligibleContributors: isSelf \? \[\] : eligibleContributors/u,
    "nobody is offered as a contributor to the reader's own birthday");

  // BOTH HALVES OF THE COMPARISON COME FROM ONE AREA. The person is fetched
  // with the Area on the query and the membership is the one for that Area, so
  // a login that is somebody else in another family cannot match here.
  assert.match(loader, /\.eq\("area_id", areaId\)/u);
});

test("the dashboard card says it is a surprise rather than 'not started'", () => {
  const dashboard = read("src", "app", "events-dashboard.tsx");

  assert.match(dashboard, /isSelf=\{person\.personId === viewerPersonId\}/u);
  assert.match(dashboard, /SELF_PRIVATE_HEADLINE/u, "the required sentence, from the shared constant");

  // "Planning not started yet" would be a claim about their own presents that
  // may well be false, so the surprise arm comes first.
  const card = dashboard
    .slice(dashboard.indexOf("function BirthdayCard"))
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  assert.ok(card.indexOf("{isSelf") < card.indexOf("Planning not started yet"));

  // And the status badge cannot be computed from planning they must not see.
  assert.match(dashboard, /const status: PurchaseProgressStatus | null = state === "planned" && planning/u);
});

test("the viewer's own person is read on the server, never guessed in the browser", () => {
  const loader = read("src", "utils", "supabase", "birthdays-server.ts");
  assert.match(loader, /viewerPersonId: string \| null;/u);
  assert.match(loader, /const \{ member \} = await getCurrentMember\(\);/u,
    "the membership row for the Area on screen is the source");

  const page = read("src", "app", "page.tsx");
  assert.match(page, /viewerPersonId = birthdayResult\.value\.viewerPersonId;/u);
  assert.match(page, /viewerPersonId=\{viewerPersonId\}/u);

  // A signed-out or membership-less render must not default to "somebody".
  assert.match(loader, /viewerPersonId: null, canEditBirthdays: false, isAdmin: false, today,/u);
});

test("the root page reads birthdays and events independently", () => {
  const page = read("src", "app", "page.tsx");
  assert.match(page, /loadFamilyBirthdays\(\)/);
  assert.match(page, /listEvents\(\)/);
  assert.match(page, /Promise\.allSettled/, "one failing must not take the other down");
  assert.match(page, /upcomingBirthdays\(birthdayResult\.value\.people, today\)/);
});

// ---------------------------------------------------------------------------
// 3. The birthday workspace
// ---------------------------------------------------------------------------

test("a birthday link resolves straight to Event Home, with nothing in between", () => {
  assert.equal(birthdayWorkspacePath("abc"), "/birthdays/abc");

  assert.match(resolverPage, /loadBirthdayWorkspace\(personId\)/u);
  assert.match(resolverPage, /if \(!workspace\) notFound\(\)/u, "an unknown person is a plain 404");

  // THE REDIRECT. Where this year's planning exists, the person route hands
  // straight over to Event Home. There is no second financial screen in the
  // way, because there is only one place the money lives.
  assert.match(resolverPage, /if \(workspace\.current\) \{/u);
  assert.match(resolverPage, /redirect\(destination\)/u);
  assert.match(resolverPage, /eventPath\(workspace\.current\.eventId\)/u);

  // The removed screen's shortcuts went with it.
  // The removed screen's shortcuts went with it. Comments are stripped first:
  // the resolver's own doc comment explains what used to be there, and a bare
  // search would find its own documentation.
  const BLOCK_COMMENT = new RegExp(String.raw`/\*[\s\S]*?\*/`, "gu");
  const LINE_COMMENT = new RegExp(String.raw`//[^\n]*`, "gu");
  const resolverCode = resolverPage.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
  assert.doesNotMatch(resolverCode, /Ideas & budget|Add a purchase|Payments/u, "no landing page remains");

  // Birthdays vocabulary, not event vocabulary, on what is left.
  assert.match(setupScreen, /eyebrow="Birthdays"/u);
});

test("history is genuine activity only, so an accidental occurrence never becomes a year", () => {
  const server = read("src", "utils", "supabase", "birthdays-server.ts");
  assert.ok(
    server.includes("occurrence.gifts.length > 0 || occurrence.openIdeas.length > 0"),
    "activity is what makes a year history",
  );
  assert.ok(server.includes(".filter(hasActivity)"), "history is filtered to occurrences with activity");
  assert.ok(server.includes("occurrence.year < currentYear"), "history is earlier years only");
  assert.ok(server.includes("right.year - left.year"), "most recent first");
});

test("an empty occurrence is still reachable, or it could never be tidied up", () => {
  // The hole this closes: a birthday occurrence is not a dashboard card, and an
  // empty one is not history either. Without a third list, an unused row for a
  // year that has passed would have no route to it anywhere in the app -- which
  // is exactly the state an accidental test event is in, and exactly the one
  // somebody needs to reach in order to remove it.
  const server = read("src", "utils", "supabase", "birthdays-server.ts");
  assert.ok(server.includes("const unused = occurrences"), "unused occurrences are collected");
  assert.ok(
    server.includes("occurrence !== current && !hasActivity(occurrence)"),
    "unused is exactly: not this year's planning, and nothing in it",
  );

  const screen = historyScreen;
  assert.ok(screen.includes("{isAdmin && unused.length > 0 && ("), "shown to the Global Admin only");
  assert.ok(screen.includes('eventPath(occurrence.eventId, "settings")'), "and it links somewhere useful");
});

// ---------------------------------------------------------------------------
// 4. Two reminder stages, and no third
// ---------------------------------------------------------------------------

test("only the week and day stages exist, in the app and in the database", () => {
  assert.deepEqual(REMINDER_STAGES.map((stage) => stage.stage), ["one_week", "one_day"]);

  // EVERY stage constraint, not merely one of them: the migration writes the
  // constraint twice (validated, and NOT VALID where history exists), and an
  // assertion that only one of them is right proves nothing about the other.
  const stageConstraints = [...sql.matchAll(/check \(stage in \(([^)]*)\)\)/gu)].map((match) => match[1]);
  assert.equal(stageConstraints.length, 2, "the constraint is written twice, for the two history cases");
  for (const listed of stageConstraints) {
    assert.equal(listed.trim(), "'one_week', 'one_day'", "every stage constraint lists exactly two stages");
  }
  assert.match(
    sql,
    /if p_stage not in \('one_week', 'one_day'\) then\s*\n\s*raise exception/u,
    "the claim function refuses anything else",
  );

  const dispatch = read("src", "lib", "notification-dispatch.ts");
  const copyStart = dispatch.indexOf("const STAGE_COPY = {");
  const copy = dispatch.slice(copyStart, dispatch.indexOf("} as const;", copyStart));
  assert.doesNotMatch(copy, /one_month/u, "no copy exists for a one-month reminder");
  assert.match(copy, /one_week/u);
  assert.match(copy, /one_day/u);
});

test("a stage with no copy produces no notification at all", () => {
  // How a historical one_month row is retired without being rewritten: the
  // dispatcher looks its stage up, finds nothing, and returns null.
  const dispatch = read("src", "lib", "notification-dispatch.ts");
  assert.match(
    dispatch,
    /const stage = STAGE_COPY\[row\.stage as keyof typeof STAGE_COPY\];\s*\n\s*if \(!stage\) return null;/u,
    "an unknown stage must send nothing rather than falling through",
  );
});

test("no one-month reminder is generated on any day of any year", () => {
  for (const birthday of [{ month: 1, day: 1 }, { month: 6, day: 15 }, { month: 11, day: 6 }, { month: 2, day: 29 }]) {
    for (let offset = 0; offset < 800; offset += 1) {
      const today = new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
      for (const due of dueReminderStages(birthday, today)) {
        assert.ok(
          due.stage === "one_week" || due.stage === "one_day",
          `${today} produced ${due.stage}`,
        );
      }
    }
  }
});

test("a duplicate week or day send is still impossible", () => {
  // Two layers, both in the database. Neither changed in 4.1, and both are
  // asserted here because retiring a stage is exactly the kind of edit that
  // quietly loosens the key it was part of.
  assert.match(sql, /on conflict \(person_id, occurrence_year, stage\) do nothing/u);
  assert.match(sql, /return claimed_id is not null;/u, "only the winner is told to send");

  const route = read("src", "app", "api", "birthdays", "reminders", "route.ts");
  assert.match(route, /if \(claim\.error \|\| claim\.data !== true\) continue;/u);
  assert.match(route, /fingerprint: `\$\{row\.occurrence_year\}:\$\{row\.stage\}`/u);
});

test("the occurrence year is still what makes a reminder annual", () => {
  const jan3 = { month: 1, day: 3 };
  const thisDecember = dueReminderStages(jan3, "2026-12-27");
  const nextDecember = dueReminderStages(jan3, "2027-12-27");
  assert.equal(thisDecember[0].occurrenceYear, 2027);
  assert.equal(nextDecember[0].occurrenceYear, 2028);
  assert.notEqual(thisDecember[0].occurrenceYear, nextDecember[0].occurrenceYear);

  // Nothing is cleared to make that work.
  assert.doesNotMatch(sql, /delete from public\.birthday_reminders/iu);
  assert.doesNotMatch(sql, /update public\.birthday_reminders[\s\S]{0,120}set stage/iu);
});

test("a historical one-month row is preserved, not rewritten", () => {
  // The instruction was explicit: do not destructively rewrite history. The
  // migration adds the constraint NOT VALID where such a row exists, which
  // refuses every new one while leaving the old ones exactly as they are.
  assert.match(sql, /check \(stage in \('one_week', 'one_day'\)\) not valid/u);
  assert.match(sql, /left untouched/iu, "and the migration says so out loud");
  assert.doesNotMatch(sql, /delete from public\.birthday_reminders/iu);
  assert.doesNotMatch(sql, /update public\.birthday_reminders/iu);
});

// ---------------------------------------------------------------------------
// 5. Deleting an occurrence: only while there is nothing to lose
// ---------------------------------------------------------------------------

test("an event can be physically deleted only when every category is empty", () => {
  const start = sql.indexOf("function public.delete_event_if_empty(");
  assert.ok(start > 0, "delete_event_if_empty must exist");
  const body = sql.slice(start, sql.indexOf("$$;", start));

  // Every category the instruction named, checked before the delete.
  for (const table of [
    "public.purchases",
    "public.purchase_allocations",
    "public.settlements",
    "public.payment_receipts",
    "public.gift_ideas",
  ]) {
    assert.ok(body.includes(table), `${table} must be checked`);
    assert.ok(
      body.indexOf(table) < body.indexOf("delete from public.events"),
      `${table} must be checked BEFORE the delete`,
    );
  }

  assert.match(body, /is_app_admin\(\)/u, "Global Admin only, checked in the database");
  assert.ok(
    body.indexOf("is_app_admin()") < body.indexOf("delete from public.events"),
    "and checked first",
  );
  assert.match(body, /blocking_count > 0/u);
  assert.match(body, /Archive it instead/u, "the refusal says what to do instead");

  // The delete is scoped to the ONE event that was checked. An unscoped or
  // differently-scoped delete would pass every assertion above and empty the
  // table, so the statement is pinned exactly.
  const deletes = sql.match(/delete from public.events[^;]*/gu) ?? [];
  assert.deepEqual(deletes, ["delete from public.events where id = p_event_id"],
    "exactly one delete, scoped to the checked event");
});

test("the deletion is recorded before the row disappears", () => {
  const start = sql.indexOf("function public.delete_event_if_empty(");
  const body = sql.slice(start, sql.indexOf("$$;", start));
  const auditAt = body.indexOf("insert into public.audit_log (");
  assert.ok(auditAt > 0, "the deletion must be written to the audit log");
  assert.ok(
    auditAt < body.indexOf("delete from public.events"),
    "the audit row is written first, so it survives whatever the delete does",
  );
  assert.match(body, /'removed'/u);
  assert.ok(
    body.includes("'events',") && body.includes("target_event.id,"),
    "the log names the event it removed",
  );
});

test("nothing else in the application can delete an event", () => {
  // The UI offering a delete is a convenience; the database is the boundary.
  // No screen, loader or route may reach past it.
  for (const parts of [
    ["src", "app", "events", "[eventId]", "settings", "settings-screen.tsx"],
    ["src", "app", "events", "[eventId]", "settings", "page.tsx"],
    ["src", "utils", "supabase", "events-server.ts"],
    ["src", "app", "birthdays", "[personId]", "start-planning-screen.tsx"],
    ["src", "app", "birthdays", "[personId]", "history", "history-screen.tsx"],
  ]) {
    const source = read(...parts);
    assert.doesNotMatch(
      source,
      /from\("events"\)[\s\S]{0,80}\.delete\(/u,
      `${parts.at(-1)} must not delete an event directly`,
    );
  }
});

test("the delete control is offered only for an empty event, and is not the authorization", () => {
  const page = read("src", "app", "events", "[eventId]", "settings", "page.tsx");
  assert.match(page, /const isEmpty = /u);
  for (const table of ["purchases", "gift_ideas", "settlements"]) {
    assert.match(page, new RegExp(`from\\("${table}"\\)`, "u"), `${table} must count towards emptiness`);
  }

  const screen = read("src", "app", "events", "[eventId]", "settings", "settings-screen.tsx");
  assert.match(screen, /\{isEmpty && \(/u, "hidden unless empty");
  assert.match(screen, /rpc\("delete_event_if_empty"/u, "and it calls the guarded function");
  assert.match(screen, /NOT the authorization/u, "the comment says which is which");
});

test("an occurrence with money or ideas can only ever be archived", () => {
  // Archiving keeps everything, and stays available whatever the event holds --
  // which is what makes "delete only when empty" a safe rule rather than a trap.
  const screen = read("src", "app", "events", "[eventId]", "settings", "settings-screen.tsx");
  const archiveAt = screen.indexOf('rpc("set_event_status"');
  assert.ok(archiveAt > 0, "archiving exists");
  assert.doesNotMatch(
    screen.slice(screen.indexOf("const setStatus"), screen.indexOf("const addRecipient")),
    /isEmpty/u,
    "archiving must not depend on the event being empty",
  );
});
