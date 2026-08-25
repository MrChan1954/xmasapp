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
