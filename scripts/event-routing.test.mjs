import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Event-aware routing, as a regression suite.
 *
 * THE PROPERTY THESE PROTECT
 *   The event a screen is showing comes from the URL and from nowhere else. A
 *   tab, a link, a loader and a refresh must all agree, and none of them may
 *   fall back to "the Christmas one" — because the moment one does, a birthday
 *   purchase can land in Christmas and no test would notice.
 *
 *   The one deliberate exception is the legacy redirect layer, which exists to
 *   keep old bookmarks and old notification links alive. It is confined to a
 *   single named function, and the last test here proves it stays there.
 */

const root = process.cwd();
// Line endings are normalised on the way in. Git stores LF and checks files out
// as CRLF on Windows, so a multi-line pattern written with \n silently stops
// matching a file nobody has edited -- a false failure about the product,
// caused by a checkout setting.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");
const exists = (...parts) => existsSync(join(root, ...parts));

const { EVENT_SECTIONS, eventIdFromPath, eventPath, eventSectionFromPath, partitionEvents } =
  await import("../src/lib/events.ts");

const CHRISTMAS = "11111111-1111-4111-8111-111111111111";
const APP = ["src", "app"];
const EVENT_ROUTE = [...APP, "events", "[eventId]"];

// ---------------------------------------------------------------------------
// 1. The root is the dashboard
// ---------------------------------------------------------------------------

test("1. GET / renders the Event Dashboard and never redirects into Christmas", () => {
  const rootPage = read(...APP, "page.tsx");

  // It RENDERS the dashboard...
  assert.match(rootPage, /export default async function \w+\(\)/, "the root is a page, not a redirect");
  assert.match(rootPage, /<EventsDashboard/, "the root renders the dashboard component");
  assert.match(rootPage, /listEvents\(\)/, "it lists every event the member may open");

  // ...and is incapable of doing anything else. These are the whole point:
  // "/" is the one route that must never resolve to a particular event.
  assert.doesNotMatch(rootPage, /redirect\(/, "the root must not redirect anywhere");
  assert.doesNotMatch(rootPage, /legacyChristmasEventId/, "the root must not resolve Christmas");
  assert.doesNotMatch(rootPage, /redirectLegacyRoute/, "the root is not a legacy route");
  assert.doesNotMatch(rootPage, /\/events\//, "the root must not forward into a specific event");
  assert.doesNotMatch(rootPage, /eq\("year"/, "the front door does not resolve a Christmas");

  // The legacy redirect list is event-specific routes only. "/" is not one of
  // them, and adding it would be caught here.
  //
  // `/people` and `/people/[id]` left this list when they became the People
  // directory and a person's profile. They still honour the old link -- that is
  // asserted where those two routes are -- but they are no longer ONLY a
  // redirect, and listing them here would keep asserting they had no screen.
  const legacyPaths = [...LEGACY, ...DUAL].map((entry) => `/${entry.folder.join("/")}`);
  assert.ok(!legacyPaths.includes("/"), "the root is not a legacy redirect");
  assert.deepEqual(
    legacyPaths.slice().sort(),
    ["/add-purchase", "/more", "/owed", "/payment-log", "/people", "/people/[id]"],
    "exactly these event-specific routes still answer a pre-Checkpoint-2 link",
  );

  // `/events` is the alias, so a guessed URL still lands somewhere sensible.
  const alias = read(...APP, "events", "page.tsx");
  assert.match(alias, /redirect\("\/"\)/);

  // The PWA opens at "/" — which is the dashboard itself, with no redirect on
  // a cold start.
  assert.match(read(...APP, "manifest.ts"), /start_url: "\/"/);
});

test("2. the dashboard groups by type, and the CARD itself is still type-agnostic", () => {
  // Checkpoint 4.1 changed where a card is put, not what a card is. The
  // grouping is a product decision and lives in one function in the model;
  // `EventCard` still renders whatever it is handed, using the shared type
  // registry for its icon, with no branch on any type name.
  const dashboard = read(...APP, "events-dashboard.tsx");
  assert.match(dashboard, /events\.map\(\(event\) => <EventCard/);
  assert.match(dashboard, /eventTypeMeta\(String\(event\.type\)\)/);

  const cardStart = dashboard.indexOf("function EventCard(");
  const cardCode = dashboard.slice(cardStart)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
  assert.doesNotMatch(cardCode, /christmas|birthday/iu, "the card must not special-case a type");

  // The grouping lives in the model, where it is tested directly.
  assert.match(dashboard, /groupDashboardEvents\(events, today\)/, "grouping comes from the model");

  const server = read("src", "utils", "supabase", "events-server.ts");
  assert.match(server, /from\("events"\)/, "every event is listed from the generalised table");
  assert.doesNotMatch(
    server.slice(0, server.indexOf("COMPATIBILITY ONLY")),
    /eq\("year"/,
    "listing events never filters by year",
  );
});

test("3. every event link carries the event id", () => {
  for (const section of EVENT_SECTIONS) {
    const path = eventPath(CHRISTMAS, section);
    assert.ok(path, `${section} must have a path`);
    assert.ok(path.includes(CHRISTMAS), `${section} must carry the event id`);
    assert.equal(eventIdFromPath(path), CHRISTMAS);
    assert.equal(eventSectionFromPath(path), section);
  }
  assert.equal(eventPath(CHRISTMAS), `/events/${CHRISTMAS}`);
});

// ---------------------------------------------------------------------------
// 4-9. Every section is a real route, and validates its event
// ---------------------------------------------------------------------------

const SECTION_ROUTES = [
  { section: "home", folder: [], screen: "EventHome" },
  { section: "people", folder: ["people"], screen: "PeopleScreen" },
  { section: "add-purchase", folder: ["add-purchase"], screen: "PurchaseForm" },
  { section: "owed", folder: ["owed"], screen: "OwedScreen" },
  { section: "more", folder: ["more"], screen: "EventMoreScreen" },
  { section: "payment-log", folder: ["payment-log"], screen: "PaymentLogScreen" },
];

test("4-9. each event section is a route that validates the event before rendering", () => {
  for (const { section, folder, screen } of SECTION_ROUTES) {
    const file = [...EVENT_ROUTE, ...folder, "page.tsx"];
    assert.ok(exists(...file), `/events/[eventId]/${folder.join("/")} must exist`);
    const page = read(...file);

    // The gate, on every single one. No route may render its screen first and
    // check afterwards.
    assert.match(page, /await requireEvent\(eventId\)/, `${section} must call requireEvent`);
    assert.ok(
      page.indexOf("requireEvent(eventId)") < page.indexOf(`<${screen}`),
      `${section} must validate before it renders`,
    );
    assert.match(page, /const \{ eventId \} = await params;/, `${section} takes its event from the route`);
    assert.match(page, new RegExp(`${screen}[\\s\\S]*?eventId=\\{event\\.id\\}`), `${section} passes the resolved event down`);

    // And no route smuggles in a fallback.
    assert.doesNotMatch(page, /eq\("year"/, `${section} must not resolve an event by year`);
  }

  // The section list and the route folders are the same set, so a link can
  // never be built for a section that has no page.
  const folders = readdirSync(join(root, ...EVENT_ROUTE), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(folders, EVENT_SECTIONS.filter((section) => section !== "home").slice().sort());
});

test("5. an invalid, unknown or unauthorized event id fails safely", () => {
  // A malformed id never becomes a link or a query.
  assert.equal(eventPath("not-a-uuid"), null);
  assert.equal(eventIdFromPath("/events/not-a-uuid"), null);
  assert.equal(eventIdFromPath("/events/../admin"), null);

  const server = read("src", "utils", "supabase", "events-server.ts");
  // Validate the shape, then ask the database, then 404 — and the three
  // failures are deliberately indistinguishable to the caller.
  assert.match(server, /const validId = validateUuid\(eventId\);\s*\n\s*if \(!validId\.ok\) return null;/);
  assert.match(server, /const \{ member \} = await getCurrentMember\(\);/);
  assert.match(server, /if \(!member\) notFound\(\);/);
  // And the event itself is reached through the family on screen or not at all.
  assert.match(server, /\.eq\("area_id", areaId\)/);
  assert.match(server, /const event = await getEvent\(eventId\);\s*\n\s*if \(!event\) notFound\(\);/);
  assert.match(server, /if \(!auth\.user\) redirect\("\/login"\);/);
  // Reading an event is behind the same RLS as everything else; this module
  // never uses a service-role client to look one up.
  assert.doesNotMatch(server, /SUPABASE_SECRET_KEY|createAdminSupabaseClient|service_role/);
});

// ---------------------------------------------------------------------------
// 10-11. Legacy routes
// ---------------------------------------------------------------------------

/** Routes that are ONLY a compatibility redirect, and must stay that way. */
const LEGACY = [
  { folder: ["owed"], section: "owed" },
  { folder: ["add-purchase"], section: "add-purchase" },
  { folder: ["more"], section: "more" },
  { folder: ["payment-log"], section: "payment-log" },
];

/**
 * `/people` and `/people/[id]` do TWO jobs now.
 *
 * They were pure redirects because there was nowhere else for them to go. They
 * are now the People directory and a person's profile -- and they still forward
 * the legacy form, because the id in a pre-Checkpoint-2 notification link is a
 * CHRISTMAS RECIPIENT id, not a person id. Breaking a saved link to make a
 * route look cleaner is not a trade worth making, so both are asserted: the new
 * screen, and the old link.
 */
const DUAL = [
  { folder: ["people"], screen: "PeopleDirectoryScreen" },
  { folder: ["people", "[id]"], screen: "PersonProfileScreen" },
];

test("10-11. every legacy route redirects into Christmas 2026 rather than breaking", () => {
  for (const { folder, section } of LEGACY) {
    const page = read(...APP, ...folder, "page.tsx");
    assert.match(page, /redirectLegacyRoute\(/, `/${folder.join("/")} must redirect`);
    assert.ok(page.includes(`redirectLegacyRoute("${section}"`), `/${folder.join("/")} -> ${section}`);
    assert.match(page, /COMPATIBILITY/, `/${folder.join("/")} must be labelled as compatibility`);
    // A redirect is all it is: no screen, no data loading, no duplicate
    // implementation of the page it forwards to.
    assert.doesNotMatch(page, /createClient|useState|"use client"/);
  }

  for (const { folder, screen } of DUAL) {
    const page = read(...APP, ...folder, "page.tsx");
    assert.ok(page.includes(screen), `/${folder.join("/")} must serve ${screen}`);
    assert.match(page, /redirectLegacyRoute\("people"/, `/${folder.join("/")} must still honour the old link`);
    // A server component, still: the redirect has to happen before anything
    // renders, and none of this may move into the browser.
    assert.doesNotMatch(page, /"use client"|useState/);
  }

  // The deep links notifications already use survive with their query intact.
  assert.match(read(...APP, "people", "page.tsx"), /\?person=\$\{encodeURIComponent\(person\)\}/);
  assert.match(read(...APP, "people", "[id]", "page.tsx"), /\?person=\$\{encodeURIComponent\(id\)\}/);
  assert.match(read(...APP, "add-purchase", "page.tsx"), /"edit", "idea", "recipient"/);

  // Notification links still point at those legacy paths, which is exactly why
  // the redirects have to exist.
  assert.match(read("src", "lib", "notification-content.ts"), /OWED_URL = "\/owed"/);
  assert.match(read("src", "lib", "notification-content.ts"), /\/people\?person=/);
});

// ---------------------------------------------------------------------------
// 12-13. Navigation
// ---------------------------------------------------------------------------

test("12-13. mobile and desktop navigation both carry the current event", () => {
  const navItems = read(...APP, "components", "nav-items.ts");
  // The nav is built from sections and `eventPath`, so there is no literal
  // "/owed" anywhere for a tab to accidentally point at.
  assert.match(
    navItems,
    /export function navItemsFor\(eventId: string \| null, activeRecipientCount: number \| null = null\): NavItem\[\]/,
  );
  assert.match(navItems, /const href = eventPath\(eventId, item\.section\);/);
  assert.match(navItems, /if \(!eventId\) return \[\];/);
  const eventNav = navItems.match(/const EVENT_NAV[\s\S]*?\n\};/)?.[0];
  assert.ok(eventNav);
  assert.doesNotMatch(eventNav, /href|"\//, "the nav table holds sections, never paths");

  for (const [surface, file] of [["mobile", "bottom-tabs.tsx"], ["desktop", "icon-rail.tsx"]]) {
    const source = read(...APP, "components", file);
    assert.match(source, /navItemsFor\(eventId/, `${surface} nav must be built per event`);
    assert.match(source, /activeNavSection\(pathname\)/, `${surface} nav highlights by section`);
    assert.doesNotMatch(
      source,
      /href="\/(people|owed|add-purchase|more|payment-log)"/,
      `${surface} nav must not contain a literal section path`,
    );
  }

  // Every href a real event produces contains that event.
  const items = navItemsFor(CHRISTMAS, navItems);
  assert.equal(items.length, 5);
  for (const href of items) assert.ok(href.includes(CHRISTMAS), `${href} must carry the event id`);
});

/** Rebuilds the nav hrefs the same way the components do. */
function navItemsFor(eventId) {
  return ["home", "people", "add-purchase", "owed", "more"].map((section) => eventPath(eventId, section));
}

test("there is always an obvious way back out to Events", () => {
  const navItems = read(...APP, "components", "nav-items.ts");
  // The top bar breadcrumb inside an event points at the dashboard, so leaving
  // never depends on the browser's Back button.
  assert.match(navItems, /export const EVENTS_HOME = \{ href: "\/", label: "Events" \}/);
  assert.match(navItems, /if \(section === "home"\) return \{ title: EVENT_SECTION_TITLES\.home, parent: EVENTS_HOME \};/);
  // The desktop rail carries it as a permanent first entry -- now from the
  // shared family list rather than hard-coded, so Events and People are built
  // the same way and neither can be dropped without the other noticing.
  const rail = read(...APP, "components", "icon-rail.tsx");
  assert.match(rail, /GLOBAL_NAV\.map\(\(item\) => \{/u);
  assert.deepEqual(
    [...navItems.matchAll(/\{ section: "(events|people)", href: "([^"]+)"/gu)].map((match) => [match[1], match[2]]),
    [["events", "/"], ["people", "/people"]],
    "Events first, then People, and both are family-level paths",
  );
});

test("the active event is named in the chrome, so nobody adds a gift to the wrong one", () => {
  const rail = read(...APP, "components", "icon-rail.tsx");
  assert.match(rail, /eventTypeMeta\(event\.type\)\.icon/);
  assert.match(rail, /event\.name/);
  assert.doesNotMatch(rail, /Christmas 2026/);

  // Event Home leads with the event's own name, icon and date.
  const home = read(...APP, "home-screen.tsx");
  assert.match(home, /\{eventName\}/);
  assert.match(home, /eventTypeMeta\(eventType\)\.icon/);
  assert.match(home, /formatEventDate\(eventDate\)/);
  assert.doesNotMatch(home, /Christmas<span/, "the masthead no longer hardcodes Christmas");
});

// ---------------------------------------------------------------------------
// 14. No hidden Christmas default
// ---------------------------------------------------------------------------

test("14. no event-scoped screen or loader resolves its event by year", () => {
  const screens = [
    ["home-screen.tsx"],
    ["people", "people-screen.tsx"],
    ["add-purchase", "purchase-form.tsx"],
    ["owed", "owed-screen.tsx"],
    ["owed", "owed-data.ts"],
    ["owed", "owed-summary.tsx"],
    ["payment-log", "payment-log-screen.tsx"],
    // Lives inside the event route now: it is that event's screen, not a
    // global one that happens to be shown there.
    ["events", "[eventId]", "more", "event-more-screen.tsx"],
    ["events-dashboard.tsx"],
    ["family-context.tsx"],
  ];
  for (const parts of screens) {
    const source = read(...APP, ...parts);
    assert.doesNotMatch(source, /eq\("year"/, `${parts.join("/")} must not look an event up by year`);
    assert.doesNotMatch(source, /christmas_events/, `${parts.join("/")} must not read the compatibility view`);
  }

  // The server loaders too.
  for (const parts of [["payment-log-server.ts"], ["events-server.ts"]]) {
    const source = read("src", "utils", "supabase", ...parts);
    const beforeCompat = source.includes("COMPATIBILITY ONLY")
      ? source.slice(0, source.indexOf("COMPATIBILITY ONLY"))
      : source;
    assert.doesNotMatch(beforeCompat, /eq\("year"/, `${parts[0]} must not look an event up by year`);
  }

  // The URL is authoritative: the family context reads the id from the path
  // rather than holding its own idea of the current event.
  const familyContext = read(...APP, "family-context.tsx");
  assert.match(familyContext, /const eventId = eventIdFromPath\(pathname\);/);
  assert.doesNotMatch(familyContext, /useState.*eventId|setEventId/);

  // Exactly one function in the whole application is allowed to find Christmas
  // by year, and it exists only to keep old links working.
  const yearLookups = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, ...dir), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      if (entry.isDirectory()) { walk([...dir, entry.name]); continue; }
      if (!/\.(ts|tsx)$/u.test(entry.name) || entry.name.endsWith(".test.ts")) continue;
      if (read(...dir, entry.name).includes('eq("year"')) yearLookups.push([...dir, entry.name].join("/"));
    }
  };
  walk(["src"]);
  assert.deepEqual(
    yearLookups,
    [
      // The legacy redirect resolver, and nothing else. Checkpoint 3 removed
      // the notification dispatcher's copy: it now derives each notification's
      // event from the record being notified about.
      "src/utils/supabase/events-server.ts",
    ],
    "only the legacy redirect resolver may find Christmas by year",
  );

  // The dispatcher's year lookup is gone, and so is the constant behind it.
  const dispatch = read("src", "lib", "notification-dispatch.ts");
  assert.doesNotMatch(dispatch, /CHRISTMAS_YEAR/, "the dispatcher's Christmas year constant is retired");
  assert.doesNotMatch(dispatch, /loadChristmasEventId/, "the dispatcher's Christmas lookup is retired");
  assert.ok(
    dispatch.includes("export async function resolveSubjectEventId("),
    "the dispatcher derives each notification's event from its subject",
  );
});

test("every runtime read of the Christmas compatibility view is enumerated and labelled", () => {
  // A year filter is not the only way to pin an event to Christmas: Family
  // Access uses `order by year desc limit 1`, which the search above cannot
  // see. So this enumerates every runtime READ of the compatibility view
  // instead, whatever shape the query takes.
  const readers = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, ...dir), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      if (entry.isDirectory()) { walk([...dir, entry.name]); continue; }
      if (!/\.(ts|tsx)$/u.test(entry.name) || entry.name.endsWith(".test.ts")) continue;
      const source = read(...dir, entry.name);
      if (/from\("christmas_events"\)/u.test(source)) readers.push([...dir, entry.name].join("/"));
    }
  };
  walk(["src"]);

  /*
   * NOTHING READS THE VIEW AT RUNTIME ANY MORE.
   *
   * Family Access came off this list at Checkpoint 4, when contributor editing
   * moved to Event Settings and the event became part of the URL.
   *
   * `legacyChristmasEventId` came off it with Areas. The view predates them and
   * exposes only `id, year, name, created_at` -- no `area_id` -- so a resolver
   * built on it cannot say WHICH family's Christmas it means. Live browser QA
   * caught it redirecting out of one family and into another's. It reads
   * `events` now, filtered by `event_type` and `area_id`; the christmas-only
   * guarantee comes from the filter rather than from the view.
   */
  const EXPECTED = {};

  assert.deepEqual(
    readers.sort(),
    Object.keys(EXPECTED).sort(),
    "a new runtime dependency on Christmas identity appeared — isolate and label it, or scope it to the route's event",
  );

  // Each one is confined to a single named helper and says why it exists.
  for (const [file, helper] of Object.entries(EXPECTED)) {
    const source = read(...file.split("/"));
    assert.match(source, new RegExp(`function ${helper}\\b`), `${file} must isolate the lookup in ${helper}`);
    assert.match(source, /COMPATIBILITY/, `${file} must label the lookup as compatibility`);
    assert.equal(
      (source.match(/from\("christmas_events"\)/gu) ?? []).length,
      1,
      `${file} must read the compatibility view exactly once`,
    );
  }

  // No event-scoped SCREEN is on that list.
  for (const file of readers) {
    assert.ok(
      !file.startsWith("src/app/events/"),
      `${file} is an event route and must take its event from the URL`,
    );
  }
});

test("the URL is the only source of the current event", () => {
  const familyContext = read(...APP, "family-context.tsx");

  // Derived on every render from the path. Not state, not a prop, not storage.
  assert.match(familyContext, /const eventId = eventIdFromPath\(pathname\);/);
  assert.doesNotMatch(familyContext, /setEventId/u, "the event id is never held in state");
  assert.doesNotMatch(familyContext, /localStorage|sessionStorage|currentEvent/u, "no client-side event fallback");

  // Because it is derived, a changed URL cannot leave a stale event behind:
  // the loader is keyed to it, so switching events refetches rather than
  // reusing the previous event's people.
  assert.match(familyContext, /\}, \[authRoute, eventId, router\]\);/, "the loader is keyed to the event id");
  assert.match(
    familyContext,
    /if \(!eventId\) \{ setPeople\(\[\]\); setEvent\(null\);/,
    "leaving an event clears its data",
  );

  // Every event-scoped screen takes the id as a prop from the validated route
  // and keys its own loaders to it, so none can hold a previous event's data.
  const keyedLoaders = [
    [["home-screen.tsx"], /\}, \[active, eventId\]\);/],
    [["people", "people-screen.tsx"], /\}, \[eventId\]\);/],
    [["add-purchase", "purchase-form.tsx"], /\}, \[editId, eventId, ideaId, queryError, requestedRecipientId\]\);/],
    [["owed", "owed-screen.tsx"], /\}, \[eventId\]\);/],
    [["payment-log", "payment-log-screen.tsx"], /\}, \[eventId\]\);/],
    [["owed", "owed-summary.tsx"], /\}, \[eventId, snapshot\]\);/],
  ];
  for (const [parts, pattern] of keyedLoaders) {
    assert.match(read(...APP, ...parts), pattern, `${parts.join("/")} must refetch when the event changes`);
  }

  // And nothing anywhere persists a "current event" outside the URL.
  for (const parts of [
    ["family-context.tsx"], ["events-dashboard.tsx"], ["components", "nav-items.ts"],
    ["components", "bottom-tabs.tsx"], ["components", "icon-rail.tsx"],
    ["components", "command-search.tsx"], ["components", "account-menu.tsx"],
  ]) {
    assert.doesNotMatch(
      read(...APP, ...parts),
      /localStorage|sessionStorage/u,
      `${parts.join("/")} must not store an event`,
    );
  }
});

test("the compatibility resolver can never return a birthday", () => {
  const server = read("src", "utils", "supabase", "events-server.ts");
  const compat = server.slice(server.indexOf("COMPATIBILITY ONLY"));
  /*
   * THE GUARANTEE IS THE SAME; THE MECHANISM MOVED.
   *
   * It used to read the christmas-only view from migration 025, which made a
   * birthday impossible by construction. That view has no `area_id`, so with
   * Areas it could not say which family it meant -- and did, in live QA, pick
   * the wrong one. The resolver reads `events` now and pins the kind itself.
   */
  assert.match(compat, /from\("events"\)/);
  assert.match(compat, /\.eq\("event_type", "christmas"\)/,
    "a birthday must still be impossible -- now by filter rather than by view");
  assert.match(compat, /\.eq\("area_id", areaId\)/,
    "and it must be THIS family's Christmas");
  // And a missing Christmas degrades to the dashboard rather than an error.
  assert.match(compat, /if \(!eventId\) redirect\("\/"\);/);
});

// ---------------------------------------------------------------------------
// 15. The money is untouched
// ---------------------------------------------------------------------------

test("15. this checkpoint changed navigation, not money", () => {
  // The Owed engine, the split engine and the allocation validator are all
  // byte-identical to Checkpoint 1 — routing must never reach into them.
  for (const file of ["owed.ts", "purchases.ts", "recipient-allocations.ts", "currency.ts", "payment-confirmation.ts"]) {
    const source = read("src", "lib", file);
    assert.doesNotMatch(source, /events|eventId/i, `${file} must know nothing about events`);
  }

  // The Owed loader still nets confirmed money only, and still uses the same
  // engine. All that changed is which event's rows reach it.
  const owedData = read(...APP, "owed", "owed-data.ts");
  assert.match(owedData, /export async function loadOwedData\(eventId: string\)/);
  assert.match(owedData, /calculateNetOwedBalances\(obligations, settlements\)/);
  assert.match(owedData, /confirmed_amount_pennies/);
  assert.match(owedData, /\.eq\("christmas_event_id", eventId\)/);

  // Dashboard spend is a read of the same rows Event Home reads, under the
  // same rule, not a second definition of spend.
  const server = read("src", "utils", "supabase", "events-server.ts");
  assert.match(server, /\.is\("deleted_at", null\)/, "voided purchases are excluded");
  assert.match(server, /actual_price_pennies/);
  assert.doesNotMatch(server, /Math\.round|parseFloat|toFixed/, "pennies stay integers");

  const home = read(...APP, "home-screen.tsx");
  assert.match(home, /\.is\("deleted_at", null\)/);

  // No route or navigation file writes to a financial table.
  const routed = [
    ["page.tsx"], ["events-dashboard.tsx"], ["components", "nav-items.ts"],
    ["components", "bottom-tabs.tsx"], ["components", "icon-rail.tsx"],
    ["events", "page.tsx"], ["events", "new", "page.tsx"],
    ["events", "[eventId]", "page.tsx"],
  ];
  for (const parts of routed) {
    const source = read(...APP, ...parts);
    assert.doesNotMatch(source, /\.rpc\(|\.insert\(|\.update\(|\.delete\(/, `${parts.join("/")} must not write`);
  }
});

test("creating an event is admin-only on the server, and writes only through the RPC", () => {
  // Checkpoint 2 asserted a "Coming next" placeholder here. Checkpoint 4
  // replaced the placeholder with the real form, so this now asserts the
  // property that actually matters: the page gates on the server, and the only
  // write is the SECURITY DEFINER function that gates again in the database.
  const page = read(...APP, "events", "new", "page.tsx");
  assert.match(page, /member\.role !== "admin"\) redirect\("\/"\)/, "admin only");
  assert.doesNotMatch(page, /Coming next/, "the placeholder is gone");
  assert.doesNotMatch(
    page,
    /\.insert\(|from\("events"\)/u,
    "the page must not write to events directly",
  );

  const form = read(...APP, "events", "new", "create-event-form.tsx");
  assert.match(form, /rpc\("create_event"/, "the form creates through create_event");
  assert.doesNotMatch(
    form,
    /from\("events"\)|from\("christmas_recipients"\)|from\("contributors"\)/u,
    "the form must not reach past the RPC into the tables it guards",
  );

  // The dashboard offers it to Global Admin only.
  const dashboard = read(...APP, "events-dashboard.tsx");
  assert.match(dashboard, /isAdmin \? \(\s*\n\s*<ButtonLink href="\/events\/new"/);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("the dashboard orders events deterministically, never by insertion", () => {
  const events = [
    { id: "a", name: "Easter 2027", type: "easter", eventDate: "2027-03-28", status: "active", year: null, celebrantPersonId: null, description: null },
    { id: "b", name: "Christmas 2026", type: "christmas", eventDate: "2026-12-25", status: "active", year: 2026, celebrantPersonId: null, description: null },
    { id: "c", name: "Paige's Birthday", type: "birthday", eventDate: "2027-03-14", status: "active", year: null, celebrantPersonId: "p", description: null },
    { id: "d", name: "Christmas 2025", type: "christmas", eventDate: "2025-12-25", status: "archived", year: 2025, celebrantPersonId: null, description: null },
  ];

  const shuffled = [events[2], events[0], events[3], events[1]];
  const first = partitionEvents(events, "2027-01-10");
  const second = partitionEvents(shuffled, "2027-01-10");
  assert.deepEqual(first.upcoming.map((e) => e.id), second.upcoming.map((e) => e.id), "order is independent of input order");

  assert.deepEqual(first.upcoming.map((e) => e.name), ["Paige's Birthday", "Easter 2027"], "soonest first");
  assert.deepEqual(first.past.map((e) => e.name), ["Christmas 2026"], "most recent first");
  assert.deepEqual(first.archived.map((e) => e.name), ["Christmas 2025"], "archived kept apart");

  // The dashboard's sections, in the order Checkpoint 4.1 specified:
  // Christmas, then Upcoming birthdays, then Special events, then history.
  const dashboard = read(...APP, "events-dashboard.tsx");
  // Keyed on the JSX, not on prose: the doc comment at the top of the file
  // describes the same sections in the same order, which an indexOf on words
  // alone would find first.
  const order = ['title="Christmas"', "<UpcomingBirthdaysSection", 'title="Special events"', 'title="Past"', 'title="Archived"']
    .map((marker) => dashboard.indexOf(marker));
  assert.ok(order.every((at) => at > 0), "every section must exist");
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, "the sections are in the specified order");
});

test("the dashboard is responsive and its cards are comfortable to tap", () => {
  const dashboard = read(...APP, "events-dashboard.tsx");
  // One card per row on a phone, a grid above that.
  assert.match(dashboard, /grid gap-4 sm:grid-cols-2 xl:grid-cols-3/);
  // The whole card is the control, which is far larger than 44px.
  assert.match(dashboard, /min-h-\[11rem\]/);
  // Long names wrap instead of overflowing.
  assert.match(dashboard, /break-words/);
  assert.match(dashboard, /focus-visible:outline/, "keyboard focus is visible");
});
