/**
 * THREE SCOPES, THREE PLACES, AND NOTHING LEAKING BETWEEN THEM.
 *
 * A setting's scope is not a layout preference. `src/lib/settings-scopes.ts`
 * explains why at length; this file checks that the SCREENS obey it.
 *
 * WHAT WAS WRONG. `/events/<id>/more` rendered the global `MoreScreen`, so
 * standing inside Mother's Day offered Falling snow, Account & security,
 * Notifications, the People directory, Birthdays, Activity, the family's
 * Payment log and Family access. Every one of those belongs to the reader or to
 * the SELECTED FAMILY. An event cannot scope a family, so an event screen must
 * not appear to.
 *
 * WHAT IS RIGHT NOW.
 *   /settings                    yours -- follows you into every family
 *   /settings/family             this family's -- name, access, members
 *   /events/<id>/settings        this occasion's -- name, date, who takes part
 *   /events/<id>/more            a menu of the line above, and nothing else
 *
 * And Settings is a PRIMARY destination -- the sidebar and the mobile tab bar --
 * so none of it is reached by walking into an event first.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./pg/rehearsal.mjs";

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/gu, "\n");

/**
 * The same source with its commentary removed.
 *
 * The event screen EXPLAINS at length which settings used to be on it and why
 * they left, naming every one of them. That explanation is the opposite of the
 * bug, so a sweep that reads it would fail on a screen that is exactly right.
 */
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
const APP = ["src", "app"];
const EVENT_MORE = [...APP, "events", "[eventId]", "more"];

const { NEVER_IN_EVENT_SCOPE } = await import("../src/lib/settings-scopes.ts");
const { activeGlobalSection } = await import("../src/lib/navigation.ts");

// ===========================================================================
// 1. The event's More screen is the event's
// ===========================================================================

describe("an event's More screen offers only that event", () => {
  const screen = read(...EVENT_MORE, "event-more-screen.tsx");

  test("NOT ONE GLOBAL OR FAMILY SETTING IS NAMED ON IT", () => {
    /*
     * The sweep that would have caught the original bug. It reads the screen's
     * own source, so a well-meaning re-addition fails here rather than in
     * somebody's hands.
     *
     * The closing paragraph deliberately NAMES what is not here, in prose, so
     * the reader is not left hunting -- that sentence is excluded from the
     * sweep by looking only at the markup above it.
     */
    const code = withoutComments(screen);
    const markup = code.slice(0, code.indexOf("Your account, notifications"));
    assert.ok(markup.length > 200, "the screen body must still be there to sweep");

    for (const forbidden of NEVER_IN_EVENT_SCOPE) {
      assert.ok(!markup.includes(forbidden),
        `"${forbidden}" is not a setting of one event -- it belongs to the person or the family`);
    }
  });

  test("and it links to no family-level route", () => {
    for (const route of ["/account", "/more/notifications", "/more/activity", "/more/family-access", "/people", "/birthdays", "/settings/family"]) {
      assert.ok(!screen.includes(`"${route}"`), `${route} must not be linked from an event screen`);
    }
  });

  test("it builds its list from the scope model rather than writing one out", () => {
    // So the rule lives in one file and the pure test can run it.
    assert.match(screen, /eventSettingsFor\(/u);
  });

  test("the page renders the event screen, not the old global one", () => {
    const page = read(...EVENT_MORE, "page.tsx");
    assert.match(page, /import \{ EventMoreScreen \} from "\.\/event-more-screen"/u);
    // The old import reached up three levels into `src/app/more`.
    assert.ok(!/from "\.\.\/\.\.\/\.\.\/more\//u.test(page),
      "the global More screen must not be imported here");
  });

  test("AND THE GLOBAL MORE SCREEN IS GONE ENTIRELY", () => {
    // Left in place it would be dead code that still reads like the intended
    // design, and the next person would wire it back up.
    assert.equal(existsSync(join(ROOT, ...APP, "more", "more-screen.tsx")), false);
  });
});

// ===========================================================================
// 2. Settings is a primary destination
// ===========================================================================

describe("Settings is in the main navigation, not inside an event", () => {
  const nav = read(...APP, "components", "nav-items.ts");
  const globalNav = nav.match(/export const GLOBAL_NAV[\s\S]*?\n\];/u)?.[0];

  test("the global nav offers Settings, pointing at the global scope", () => {
    assert.ok(globalNav, "GLOBAL_NAV must exist");
    assert.match(globalNav, /section: "settings"/u);
    assert.match(globalNav, /href: "\/settings"/u);
    assert.match(globalNav, /label: "Settings"/u);
  });

  test("it sits beside Events and People, which are the other two", () => {
    const sections = [...globalNav.matchAll(/section: "([a-z]+)"/gu)].map((m) => m[1]);
    assert.deepEqual(sections, ["events", "people", "settings"]);
  });

  test("the desktop sidebar renders that list", () => {
    const rail = read(...APP, "components", "icon-rail.tsx");
    assert.match(rail, /GLOBAL_NAV\.map\(\(item\) => \{/u);
    assert.match(rail, /activeGlobalSection\(pathname\)/u);
  });

  test("and so does the mobile tab bar", () => {
    const tabs = read(...APP, "components", "bottom-tabs.tsx");
    assert.match(tabs, /GLOBAL_NAV\.map\(\(item\) => \{/u);
  });

  test("THE MOBILE BAR'S COLUMN COUNT FOLLOWS THE LIST", () => {
    /*
     * It was hard-coded to two while the list held two. Adding Settings
     * without this would have crushed three tabs into two columns on every
     * phone -- and Tailwind cannot generate a composed `grid-cols-${n}`, so
     * the fix has to name each width in full.
     */
    const tabs = read(...APP, "components", "bottom-tabs.tsx");
    const block = tabs.match(/function GlobalTabs[\s\S]*?\n\}/u)?.[0];
    assert.ok(block);
    assert.match(block, /GLOBAL_NAV\.length/u, "the width must be derived from the list");
    assert.match(block, /grid-cols-3/u, "and three tabs need three columns");
  });
});

// ===========================================================================
// 3. Route matching, run rather than read
// ===========================================================================

describe("which primary destination a path belongs to", () => {
  test("every settings screen keeps Settings lit", () => {
    for (const path of [
      "/settings",
      "/settings/family",
      "/account",
      "/more/notifications",
      "/more/activity",
      "/more/family-access",
    ]) {
      assert.equal(activeGlobalSection(path), "settings", path);
    }
  });

  test("and it does not steal the other two", () => {
    assert.equal(activeGlobalSection("/people"), "people");
    assert.equal(activeGlobalSection("/people/8f14e45f-ceea-467a-9f36-dd1a1b0b8b1c"), "people");
    assert.equal(activeGlobalSection("/"), "events");
  });

  test("a legacy /more redirect is not a settings screen", () => {
    // `/more` on its own forwards INTO an event. Lighting Settings there would
    // be lit for the length of a redirect and then wrong.
    assert.equal(activeGlobalSection("/more"), null);
  });

  test("nothing inside an event lights a primary destination", () => {
    for (const path of ["/events/abc/more", "/events/abc/settings", "/events/abc/people"]) {
      assert.equal(activeGlobalSection(path), null, path);
    }
  });
});

// ===========================================================================
// 4. The three scoped screens exist, and stay distinct
// ===========================================================================

describe("the three scopes have three screens, and do not duplicate each other", () => {
  test("each scope's route is present", () => {
    assert.ok(existsSync(join(ROOT, ...APP, "settings", "page.tsx")), "/settings");
    assert.ok(existsSync(join(ROOT, ...APP, "settings", "family", "page.tsx")), "/settings/family");
    assert.ok(existsSync(join(ROOT, ...APP, "events", "[eventId]", "settings", "page.tsx")), "event settings");
  });

  test("the global screen carries no family or event controls", () => {
    const global = read(...APP, "settings", "settings-screen.tsx");
    for (const forbidden of ["Family access", "Family name", "Event settings", "transfer-admin"]) {
      assert.ok(!global.includes(forbidden), `${forbidden} is not a global setting`);
    }
  });

  test("the family screen carries no event controls", () => {
    const family = read(...APP, "settings", "family", "family-settings-screen.tsx");
    assert.ok(!family.includes("Event settings"), "an event's settings are not the family's");
    assert.ok(!family.includes("Falling snow"), "appearance follows the person, not the family");
  });

  test("and the event screen is not a second copy of either", () => {
    const screen = read(...EVENT_MORE, "event-more-screen.tsx");
    assert.ok(!screen.includes("settingsFor("),
      "the event screen must not render the global or family lists");
  });

  test("the event SETTINGS screen carries nothing global or family-level either", () => {
    /*
     * The screen behind "Event settings" -- name, date, recipients,
     * contributors, delete. Swept by NAME rather than by route: it links to a
     * person's birthday page as the place to land after an event is deleted,
     * which is a destination, not a setting.
     */
    const event = withoutComments(
      read(...APP, "events", "[eventId]", "settings", "settings-screen.tsx"));

    /*
     * A narrower list than NEVER_IN_EVENT_SCOPE, on purpose. This screen
     * explains its own scope in prose -- it tells the reader that moving an
     * event's date does NOT change the person's saved birthday, and names the
     * Birthdays page while doing so. That sentence is the scope model being
     * honest, not a leak, so the words that can legitimately appear in such an
     * explanation are left out and the unambiguous ones are swept.
     */
    for (const forbidden of [
      "Falling snow", "Account & security", "Family access", "Family settings", "Your settings",
    ]) {
      assert.ok(!event.includes(forbidden), `${forbidden} is not a setting of one event`);
    }

    // And nothing on it navigates to a family-level or global destination.
    for (const route of ["/settings", "/account", "/more/", "/people"]) {
      assert.ok(!event.includes(`"${route}`), `${route} must not be linked from an event screen`);
    }
  });
});

// ===========================================================================
// 4. Q9 -- the shell says where you are, and asks before it hides a family
// ===========================================================================

const { DEFAULT_PAGE_TITLE, FAMILY_SETTINGS_HOME, SETTINGS_HOME, pageTitleFor } =
  await import("../src/lib/navigation.ts");

/**
 * WHAT THE STICKY BAR CALLS EACH SCREEN.
 *
 * Run rather than read. `pageTitleFor` lived in `nav-items.ts` until Q9, where
 * the only thing a test could do was match a regular expression against the
 * source -- and a regex can confirm the entries that are already written and
 * nothing about the ones that are missing. Five routes were missing. Measured
 * on the deployed site before the fix: `/settings`, `/settings/family`,
 * `/people`, `/birthdays` and `/areas/new` all had a top bar reading "Family
 * Gift Planner", the application's own name, where the screen's name belongs.
 */
describe("every screen outside an event says what it is", () => {
  const NAMED = [
    ["/", "Events"],
    ["/people", "People"],
    ["/people/new", "Add person"],
    ["/settings", "Settings"],
    ["/settings/family", "Family settings"],
    ["/birthdays", "Birthdays"],
    ["/account", "Account"],
    ["/more/notifications", "Notifications"],
    ["/more/activity", "Activity"],
    ["/more/family-access", "Family access"],
    ["/areas/new", "Create new family"],
    ["/events/new", "Create event"],
  ];

  test("NOT ONE OF THEM FALLS BACK TO THE APP'S OWN NAME", () => {
    for (const [path, title] of NAMED) {
      assert.equal(pageTitleFor(path).title, title, path + " must name itself");
      assert.notEqual(pageTitleFor(path).title, DEFAULT_PAGE_TITLE, path + " still reads as the app");
    }
  });

  test("the fallback is still there for a route nobody has claimed", () => {
    // Proves the assertion above is testing the table rather than a function
    // that can only ever return a name.
    assert.equal(pageTitleFor("/nothing-here").title, DEFAULT_PAGE_TITLE);
  });

  test("the family's settings beat the person's, because first match wins", () => {
    assert.equal(pageTitleFor("/settings/family").title, "Family settings");
    assert.deepEqual(pageTitleFor("/settings/family").parent, SETTINGS_HOME);
  });
});

/**
 * WHERE THE BACK-CHEVRON GOES.
 *
 * A breadcrumb is a claim about where the reader came from. Family access and
 * Activity are Area-scoped settings catalogued on the family's own settings
 * screen, and both pointed at "Events" and "/" -- the dashboard, which is
 * neither where they came from nor a screen containing what they were looking
 * at. Account and Notifications had already been patched one at a time on their
 * own pages, which is the drift a single table exists to prevent.
 */
describe("a breadcrumb leads to the screen that lists it", () => {
  test("the family's own settings lead back to the family's settings", () => {
    for (const path of ["/more/family-access", "/more/activity"]) {
      assert.deepEqual(pageTitleFor(path).parent, FAMILY_SETTINGS_HOME,
        path + " is an Area setting and belongs under the family's own");
    }
  });

  test("what follows the person leads back to their own settings", () => {
    for (const path of ["/account", "/more/notifications", "/settings/family", "/areas/new"]) {
      assert.deepEqual(pageTitleFor(path).parent, SETTINGS_HOME, path + " belongs under Your settings");
    }
  });

  test("NO FAMILY-LEVEL SETTING IS SENT TO THE DASHBOARD ANY MORE", () => {
    for (const path of ["/account", "/more/notifications", "/more/activity", "/more/family-access"]) {
      assert.notEqual(pageTitleFor(path).parent?.href, "/",
        path + " must not drop the reader on the events list");
    }
  });

  test("the three primary destinations have nothing above them", () => {
    // They are what the rail and the tab bar point AT, so a parent would be a
    // rung on a ladder that does not exist.
    for (const path of ["/", "/people", "/settings"]) {
      assert.equal(pageTitleFor(path).parent, undefined, path + " is a primary destination");
    }
    // Birthdays is bare for the other reason: it is reached from the dashboard
    // AND from the family's settings, so any fixed parent lies half the time.
    assert.equal(pageTitleFor("/birthdays").parent, undefined);
  });
});

/**
 * ARCHIVING A WHOLE FAMILY ASKS FIRST.
 *
 * Handing over asks, leaving asks, and deleting a single event asks. Putting
 * away the entire family -- the widest of the four, and the one felt by every
 * other member at once -- called the API straight from the click. The
 * `confirming` state already had "archive" in its union with nothing setting
 * it, which is what half-finished looks like.
 */
describe("the family's destructive controls confirm", () => {
  const familySettings = () =>
    read(...APP, "settings", "family", "family-settings-screen.tsx");

  test("archive goes through a confirmation, not straight to the server", () => {
    const source = withoutComments(familySettings());
    assert.match(source, /setConfirming\("archive"\)/u, "the archive button must open the question");
    assert.doesNotMatch(source, /onClick=\{\(\) => void act\("archive"\)\}/u,
      "archiving must not fire from the click");
    assert.match(source, /confirming === "archive" && \(\s*<ConfirmDialog/u,
      "and the question must be the shared ConfirmDialog");
  });

  test("the confirmation says who else it affects, and that nothing is deleted", () => {
    const source = familySettings();
    assert.match(source, /leaves the switcher for everybody in it/u);
    assert.match(source, /Nothing is deleted/u);
  });

  test("bringing a family back does NOT ask -- it undoes rather than hides", () => {
    assert.match(withoutComments(familySettings()), /void act\("unarchive"\)/u);
  });

  test("handing over and leaving still ask, so all three read alike", () => {
    const source = withoutComments(familySettings());
    for (const state of ["handover", "leave"]) {
      assert.ok(source.includes('confirming === "' + state + '"'), state + " must still confirm");
    }
  });
});

/**
 * A SWITCH IS 32x18. A THUMB IS NOT.
 *
 * Stock shadcn draws the track at `h-[1.15rem]` -- 18 CSS pixels, measured on
 * the deployed site -- which is below the 24x24 minimum in WCAG 2.2 Target Size
 * and well under the 44px a finger needs. Both places it is used are places a
 * phone goes. jsdom has no layout, so what is checked here is that the
 * component DECLARES the expanded hit area; that it measures 44px is confirmed
 * in live browser QA.
 */
describe("the switch is bigger than it looks", () => {
  test("it carries a 44px hit area that does not change its size", () => {
    const source = read(...APP, "components", "ui", "switch.tsx");
    assert.match(source, /before:h-11/u, "the hit area must be 44px tall");
    assert.match(source, /before:w-11/u, "and 44px wide");
    // Absolute and centred, so it is out of flow: nothing around it moves and
    // the track keeps its 32x18 appearance.
    assert.match(source, /before:absolute/u);
    assert.match(source, /before:-translate-x-1\/2/u);
    assert.match(source, /before:-translate-y-1\/2/u);
    assert.match(source, /"relative /u, "an absolute child needs a positioned parent");
    // The visible track is untouched.
    assert.match(source, /data-\[size=default\]:h-\[1\.15rem\]/u);
  });
});

/**
 * AN AREA-SCOPED DOCUMENT IS NEVER STORED.
 *
 * Found in live browser QA: standing in one family, open one of its events,
 * switch family, press Back -- and the event came back on screen, named and
 * dated, while the reader was somewhere else. Asking the server for that URL at
 * that moment returned 404, because `requireEvent` scopes to the acting Area
 * and had already refused. The browser never asked: the response had been
 * stored under `Cache-Control: no-cache` with no `ETag`, no `Last-Modified` and
 * a `Vary` that did not list `Cookie`, so a history navigation reused it.
 */
describe("documents are not storable", () => {
  test("the document rule says no-store, not no-cache", () => {
    const config = read("next.config.ts");
    assert.match(
      config,
      /source: "\/\(\(\?!_next\/static\|_next\/image\|api\/\)\.\*\)",\n\s*headers: \[\{ key: "Cache-Control", value: "no-store" \}\],/u,
      "every rendered document must be no-store",
    );
  });

  test("hashed build output keeps its immutable lifetime", () => {
    // The exclusions are what stop no-store reaching the bundle. Without them
    // every navigation would refetch it.
    const config = read("next.config.ts");
    assert.match(config, /\(\?!_next\/static\|_next\/image\|api\/\)/u);
    assert.match(
      read("public", "_headers"),
      /\/_next\/static\/\*\n\s*Cache-Control: public,max-age=31536000,immutable/u,
    );
  });
});
