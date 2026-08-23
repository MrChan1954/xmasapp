import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ---------------------------------------------------------------------------
// Single-recipient events.
//
// THE PROPERTY THIS SUITE PROTECTS
//   Mother's Day is for one person. Making somebody open a People list, look at
//   a single card, and tap it before they can see a gift idea is a step that
//   answers nothing — so an event with exactly one active recipient shows that
//   recipient straight away.
//
//   And the two ways that could go wrong, both guarded here:
//
//     1. It must be decided by the COUNT, not the type. A custom event may be
//        for the whole family; a wedding may be for two people. The moment this
//        keys off `event_type`, every new occasion needs a rule and the first
//        one used differently gets the wrong screen.
//
//     2. It must be PRESENTATION ONLY. The recipient row, the contributor plan,
//        the allocation snapshots, Owed and the payment log are the proven
//        financial system, and none of them may learn about this at all.
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const { eventNavMode, groupDashboardEvents } = await import("../src/lib/events.ts");

// `nav-items.ts` imports lucide icons, which the test runner cannot load, so
// the table is read from the source the way the rest of this repository's
// navigation tests already do.
const navItems = read("src", "app", "components", "nav-items.ts");

/** The tab labels one mode offers, in order, parsed from `EVENT_NAV`. */
function tabsFor(mode) {
  const table = navItems.match(/const EVENT_NAV[\s\S]*?\n\};/u)?.[0];
  assert.ok(table, "EVENT_NAV must be a single table");
  const block = table.match(new RegExp(`\\n  ${mode}: \\[([\\s\\S]*?)\\n  \\],`, "u"));
  assert.ok(block, `${mode} must be a mode in EVENT_NAV`);
  return [...block[1].matchAll(/label: "([^"]+)"/gu)].map((match) => match[1]);
}

/** The sections one mode links to, in order. */
function sectionsFor(mode) {
  const table = navItems.match(/const EVENT_NAV[\s\S]*?\n\};/u)?.[0];
  const block = table.match(new RegExp(`\\n  ${mode}: \\[([\\s\\S]*?)\\n  \\],`, "u"));
  return [...block[1].matchAll(/section: "([^"]+)"/gu)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// 1. Christmas keeps People
// ---------------------------------------------------------------------------

test("Christmas, with many recipients, keeps Home / People / Add / Owed / More", () => {
  // Nineteen recipients, which is what production actually has.
  assert.equal(eventNavMode(19), "multi");
  assert.deepEqual(tabsFor("multi"), ["Home", "People", "Add", "Owed", "More"]);
  assert.deepEqual(sectionsFor("multi"), ["home", "people", "add-purchase", "owed", "more"]);

  // Two is already a list worth having.
  assert.equal(eventNavMode(2), "multi");
});

test("an unknown count offers everything rather than guessing", () => {
  // While the recipients are loading, or after a failed load, the honest answer
  // is "not known" — and the safe rendering is the full set. Treating that as
  // zero would hide the Add tab from an event that has plenty of people, and
  // would make the tab bar change shape under the reader's thumb.
  assert.equal(eventNavMode(null), "multi");
  assert.equal(eventNavMode(Number.NaN), "multi");

  const context = read("src", "app", "family-context.tsx");
  assert.match(
    context,
    /if \(!eventId \|\| loading \|\| error\) return null;/u,
    "loading and failure both answer null, never zero",
  );
});

// ---------------------------------------------------------------------------
// 2 & 5. One recipient, whatever the occasion is called
// ---------------------------------------------------------------------------

test("exactly one recipient replaces People with Gifts, on the same routes", () => {
  assert.equal(eventNavMode(1), "single");
  assert.deepEqual(tabsFor("single"), ["Home", "Gifts", "Add", "Owed", "More"]);
  // Same sections, same routes, same order: only the signpost changed.
  assert.deepEqual(sectionsFor("single"), sectionsFor("multi"));
});

test("the decision is the recipient count and never the event type", () => {
  // Mother's Day, a wedding, an anniversary and a "custom" occasion all reach
  // the same answer from the same input, because the input is a number.
  for (const count of [1]) assert.equal(eventNavMode(count), "single");
  for (const count of [2, 3, 19]) assert.equal(eventNavMode(count), "multi");

  // No event type appears anywhere in the decision.
  const events = read("src", "lib", "events.ts");
  const start = events.indexOf("export function eventNavMode(");
  const body = events.slice(start, events.indexOf("\n}", start));
  assert.doesNotMatch(body, /christmas|birthday|anniversary|wedding|event_type|\.type/iu,
    "eventNavMode must not look at the event type");

  // Nor in the screen's choice of shape.
  const screen = read("src", "app", "people", "people-screen.tsx");
  const modeLine = screen.match(/const mode = [^\n]*/u)?.[0] ?? "";
  assert.match(modeLine, /eventNavMode\(/u);
  assert.doesNotMatch(modeLine, /type/iu, "the screen decides on the count too");
});

test("a custom event for one person gets exactly the same treatment as Mother's Day", () => {
  // There is only one code path, so this is true by construction — asserted
  // because "add a special case for custom events" is the obvious wrong turn.
  const events = read("src", "lib", "events.ts");
  assert.equal(
    (events.match(/export function eventNavMode\(/gu) ?? []).length,
    1,
    "one decision function, no per-type variants",
  );
  assert.equal(
    (navItems.match(/const EVENT_NAV/gu) ?? []).length,
    1,
    "one navigation table, no per-type variants",
  );
});

// ---------------------------------------------------------------------------
// 3. The sole recipient's gifts are right there
// ---------------------------------------------------------------------------

test("the sole recipient's ideas and purchases render without opening a list", () => {
  const screen = read("src", "app", "people", "people-screen.tsx");

  assert.match(screen, /const soleRecipient = mode === "single" \? active\[0\] : null;/u);
  assert.match(
    screen,
    /<PersonModal person=\{soleRecipient\} onClose=\{\(\) => undefined\} variant="inline" \/>/u,
    "the recipient's own detail is the page",
  );

  // No list, no search and no filter bar in that branch.
  const singleBranch = screen.slice(
    screen.indexOf("if (soleRecipient) {"),
    screen.indexOf('if (mode === "empty") {'),
  );
  assert.doesNotMatch(singleBranch, /<PersonCard/u, "no card to tap");
  assert.doesNotMatch(singleBranch, /<Toolbar|<FilterChip|Search people/u, "nothing to search or filter");

  // An older notification linking to somebody since removed still opens them,
  // rather than silently showing the sole recipient's gifts instead.
  assert.ok(
    singleBranch.includes("selected && selected.id !== soleRecipient.id"),
    "a deep link to another recipient must still work",
  );

  // And it is the SAME component the multi-recipient list opens, not a copy.
  const modal = read("src", "app", "people", "person-modal.tsx");
  assert.equal(
    (modal.match(/export function PersonModal\(/gu) ?? []).length,
    1,
    "one recipient detail implementation",
  );
  assert.match(modal, /variant\?: "modal" \| "inline";/u);
  assert.match(modal, /if \(variant === "inline"\) return body;/u, "the frame differs, the body does not");
  assert.equal(
    (modal.match(/<DetailView/gu) ?? []).length,
    1,
    "one DetailView, so ideas and purchases cannot drift between the two shapes",
  );
});

test("a removed person is still restorable from the single-recipient screen", () => {
  // The trap: an event looks single-recipient precisely BECAUSE somebody was
  // removed from it by mistake. If the archived list only rendered on the
  // multi-recipient shape, there would be no way back.
  const screen = read("src", "app", "people", "people-screen.tsx");
  assert.equal(
    (screen.match(/<ArchivedPeople /gu) ?? []).length,
    3,
    "every shape of the screen offers the archived list",
  );
  assert.match(screen, /function ArchivedPeople\(/u, "and there is one implementation of it");
});

// ---------------------------------------------------------------------------
// 4 & 9. The financial system is untouched
// ---------------------------------------------------------------------------

test("no financial module knows this feature exists", () => {
  // If any of these mention the navigation mode, the presentation has leaked
  // into the money and this stopped being a navigation change.
  for (const parts of [
    ["src", "lib", "owed.ts"],
    ["src", "lib", "purchases.ts"],
    ["src", "lib", "recipient-allocations.ts"],
    ["src", "lib", "payment-confirmation.ts"],
    ["src", "lib", "payment-log.ts"],
    ["src", "lib", "currency.ts"],
  ]) {
    const source = read(...parts);
    assert.doesNotMatch(
      source,
      /eventNavMode|soleRecipient|EventNavMode|single-recipient/u,
      `${parts.at(-1)} must know nothing about how the event is navigated`,
    );
  }
});

test("Owed and the payment log are reached the same way whatever the shape", () => {
  // Both are ordinary sections in every mode, on the same route, with the same
  // event id in the URL. Nothing about a single-recipient event changes who
  // owes what or how a payment is recorded.
  for (const mode of ["multi", "single", "empty"]) {
    assert.ok(sectionsFor(mode).includes("owed"), `${mode} must reach Owed`);
    assert.ok(sectionsFor(mode).includes("more"), `${mode} must reach More, which owns the payment log`);
  }
  assert.match(navItems, /if \(section === "payment-log" \|\| section === "settings"\) return "more";/u);
});

test("no purchase, allocation or settlement write was touched", () => {
  // The write paths are SECURITY DEFINER functions in applied migrations. This
  // checkpoint added no migration at all, so the strongest possible statement
  // is that nothing in it writes money by any other route.
  for (const parts of [
    ["src", "app", "people", "people-screen.tsx"],
    ["src", "app", "people", "person-modal.tsx"],
    ["src", "app", "components", "nav-items.ts"],
    ["src", "app", "components", "bottom-tabs.tsx"],
    ["src", "app", "components", "icon-rail.tsx"],
    ["src", "lib", "events.ts"],
  ]) {
    const source = read(...parts);
    assert.doesNotMatch(
      source,
      /from\("(purchases|purchase_allocations|settlements|payment_receipts)"\)\s*\n?\s*\.(insert|update|delete|upsert)\(/u,
      `${parts.at(-1)} must not write a financial table`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Adding a second recipient brings People back
// ---------------------------------------------------------------------------

test("one recipient becomes two and the navigation follows, with no reconfiguration", () => {
  // The count is read live from the same `people` the screens use, so this is
  // arithmetic rather than a setting: nothing is stored, nothing is migrated,
  // and nothing has to be switched over.
  assert.equal(eventNavMode(1), "single");
  assert.equal(eventNavMode(2), "multi");
  // ...and back again, if the second person is removed.
  assert.equal(eventNavMode(1), "single");

  const context = read("src", "app", "family-context.tsx");
  assert.match(
    context,
    /return people\.filter\(\(person\) => person\.active\)\.length;/u,
    "counted live from the event's own recipients",
  );

  // The tab bar and the rail both take it from that one hook, so they cannot
  // disagree with each other or with the screen.
  for (const file of ["bottom-tabs.tsx", "icon-rail.tsx"]) {
    assert.match(
      read("src", "app", "components", file),
      /navItemsFor\(eventId, useActiveRecipientCount\(\)\)/u,
      `${file} must use the shared count`,
    );
  }

  // Nothing anywhere stores a mode.
  for (const parts of [["src", "lib", "events.ts"], ["src", "app", "family-context.tsx"]]) {
    assert.doesNotMatch(
      read(...parts),
      /nav_mode|navMode:|single_recipient|is_single/u,
      "the mode is derived, never stored",
    );
  }
});

// ---------------------------------------------------------------------------
// 7. No recipients yet
// ---------------------------------------------------------------------------

test("an event with nobody in it offers set-up, not a broken gift flow", () => {
  assert.equal(eventNavMode(0), "empty");

  // The Add tab is withheld: a purchase form with no recipient to choose is a
  // dead end. Everything else stays reachable.
  assert.deepEqual(tabsFor("empty"), ["Home", "Set up", "Owed", "More"]);
  assert.ok(!sectionsFor("empty").includes("add-purchase"), "no Add tab with nothing to add to");

  const screen = read("src", "app", "people", "people-screen.tsx");
  const emptyBranch = screen.slice(
    screen.indexOf('if (mode === "empty") {'),
    screen.indexOf("// ---- Two or more"),
  );
  assert.match(emptyBranch, /title="No recipients yet"/u);
  assert.match(emptyBranch, /\{addButton\}/u, "the admin is given the action");
  assert.doesNotMatch(emptyBranch, /<Toolbar|<FilterChip/u, "no filter bar over nothing");
  assert.match(screen, /\{mode === "multi" \? "Add person" : "Add recipient"\}/u);

  // The tab bar has four items there, and says so in a class Tailwind can see.
  assert.match(
    read("src", "app", "components", "bottom-tabs.tsx"),
    /items\.length === 4 \? "grid-cols-4" : "grid-cols-5"/u,
    "the tab grid must match the number of tabs",
  );

  // Reaching Add by URL anyway is answered, not crashed.
  const form = read("src", "app", "add-purchase", "purchase-form.tsx");
  assert.match(form, /if \(!editId && !recipients\.some\(\(row\) => row\.active\)\) \{/u);
  assert.match(form, /This event has nobody to buy for yet\./u);
  assert.match(form, /Go to set up/u);
});

// ---------------------------------------------------------------------------
// 8. Birthdays stay out of Special events
// ---------------------------------------------------------------------------

test("a birthday occurrence never appears among Special events", () => {
  const mothersDay = {
    id: "mothers-day", name: "Mother's Day 2026", type: "other",
    eventDate: "2026-03-15", status: "active", year: null,
    celebrantPersonId: null, description: null,
  };
  const birthday = {
    id: "birthday", name: "Taylor's Birthday 2026", type: "birthday",
    eventDate: "2026-09-10", status: "active", year: null,
    celebrantPersonId: "taylor", description: null,
  };
  const christmas = {
    id: "christmas", name: "Christmas 2026", type: "christmas",
    eventDate: "2026-12-25", status: "active", year: 2026,
    celebrantPersonId: null, description: null,
  };

  const grouped = groupDashboardEvents([mothersDay, birthday, christmas], "2026-01-01");
  assert.deepEqual(grouped.special.upcoming.map((event) => event.id), ["mothers-day"]);
  assert.deepEqual(grouped.special.past, []);
  assert.deepEqual(grouped.special.archived, []);
  assert.deepEqual(grouped.christmas.map((event) => event.id), ["christmas"]);
  assert.deepEqual(grouped.birthdayOccurrences.map((event) => event.id), ["birthday"]);

  // The root model, confirmed in the order the dashboard renders it.
  const dashboard = read("src", "app", "events-dashboard.tsx");
  const order = ['title="Christmas"', "<UpcomingBirthdaysSection", 'title="Special events"']
    .map((marker) => dashboard.indexOf(marker));
  assert.ok(order.every((at) => at > 0));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order);
});

test("Mother's Day, end to end", () => {
  // The worked example from the request, as one assertion chain.
  const mothersDay = {
    id: "mothers-day", name: "Mother's Day 2026", type: "other",
    eventDate: "2026-03-15", status: "active", year: null,
    celebrantPersonId: null, description: null,
  };

  // It is a Special event on the dashboard...
  const grouped = groupDashboardEvents([mothersDay], "2026-01-01");
  assert.deepEqual(grouped.special.upcoming.map((event) => event.id), ["mothers-day"]);

  // ...with one recipient it navigates Home / Gifts / Add / Owed / More...
  assert.equal(eventNavMode(1), "single");
  assert.deepEqual(tabsFor("single"), ["Home", "Gifts", "Add", "Owed", "More"]);

  // ...and if a second person is added it becomes an ordinary People event,
  // with nothing reconfigured.
  assert.equal(eventNavMode(2), "multi");
  assert.deepEqual(tabsFor("multi"), ["Home", "People", "Add", "Owed", "More"]);
});
