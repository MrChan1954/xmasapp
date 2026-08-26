/**
 * STARTING ANOTHER FAMILY, WITHOUT KNOWING A URL.
 *
 * WHAT WAS WRONG. `/areas/new` shipped with Areas and was linked from no screen
 * in the application. The account menu's Family section listed the families
 * somebody already belonged to and offered nothing else, and it only rendered
 * when there was more than one -- so the person with a single family, who is
 * exactly the person who has never started a second, saw no family section at
 * all. The only way to a second family was to be told that `/areas/new` exists
 * and type it into the address bar. `/settings/family` was in the same
 * position: a real screen, reachable by nobody.
 *
 * A FEATURE NOBODY CAN FIND IS NOT SHIPPED. This file checks the doors are
 * there, that they lead to the ONE flow that already exists, and that nothing
 * is created by opening one.
 *
 * WHY SOURCE TEXT AND NOT A RENDER. There is no DOM test runner in this
 * project, and the sweeps here are about which screen names which route --
 * exactly what source text can answer. What a route DOES is proved where it is
 * implemented: `src/lib/areas.test.ts` runs the visibility rule, and
 * `scripts/area-lifecycle.test.mjs` runs `create_area` against a real database.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./pg/rehearsal.mjs";

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/gu, "\n");
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\{\/\*[\s\S]*?\*\/\}/gu, "").replace(/^\s*\/\/.*$/gmu, "");

const { CREATE_AREA_LABEL, CREATE_AREA_PATH } = await import("../src/lib/areas.ts");
const { NEVER_IN_EVENT_SCOPE } = await import("../src/lib/settings-scopes.ts");

const APP = ["src", "app"];
const MENU = read(...APP, "components", "account-menu.tsx");
const SETTINGS = read(...APP, "settings", "settings-screen.tsx");

// ===========================================================================
// 1. The switcher in the account menu
// ===========================================================================

describe("the family switcher offers a way to start another family", () => {
  const menu = withoutComments(MENU);

  test("it still lists the families somebody belongs to", () => {
    assert.match(menu, /choices\.map\(\(choice\) =>/u, "the existing entries stay");
    assert.match(menu, /aria-checked=\{choice\.active\}/u);
    assert.match(menu, /role="menuitemradio"/u);
  });

  test("and the current one is still ticked", () => {
    assert.match(menu, /choice\.active && <Check/u,
      "the tick is how somebody knows which family they are in");
  });

  test("THE CREATE ACTION IS THERE, and says so in words a person would use", () => {
    assert.match(menu, /CREATE_AREA_LABEL/u);
    assert.equal(CREATE_AREA_LABEL, "Create new family");
  });

  test("it points at the real create flow, by the name the whole app shares", () => {
    assert.match(menu, /href=\{CREATE_AREA_PATH\}/u,
      "not a hand-written path that could drift from the route");
    assert.match(MENU, /from "@\/lib\/areas"/u);
  });

  test("A SINGLE-FAMILY ACCOUNT SEES IT -- which is the whole defect", () => {
    /*
     * The section used to render on `canSwitch` alone. One family means nothing
     * to switch to, so the section vanished, and it was carrying the only route
     * to a second family.
     */
    assert.match(menu, /\{\(canSwitch \|\| canCreate\) && \(/u,
      "the section must render when EITHER question says so");
    assert.match(menu, /\{canSwitch && choices\.map/u,
      "the list is still gated on there being something to switch to");
    assert.match(menu, /\{canCreate && \(/u,
      "and the action on there being a family already");
  });

  test("and so does an account in several", () => {
    // `canCreate` is `areas.length > 0`, so it is true wherever `canSwitch` is.
    const hook = read(...APP, "components", "use-areas.ts");
    assert.match(hook, /canCreate: areas \? shouldOfferCreate\(areas\) : false/u);
    assert.match(hook, /canSwitch: areas \? shouldOfferSwitcher\(areas\) : false/u);
  });

  test("the action is separated from the families, not one more of them", () => {
    assert.match(menu, /canSwitch \? "mt-1\.5 border-t border-line pt-1\.5" : ""/u);
  });
});

// ===========================================================================
// 2. It leads to the flow that already exists
// ===========================================================================

describe("there is one create-a-family flow, and every door opens it", () => {
  test("the route named by the constant is a real page", () => {
    assert.equal(CREATE_AREA_PATH, "/areas/new");
    assert.ok(existsSync(join(ROOT, ...APP, "areas", "new", "page.tsx")));
    assert.ok(existsSync(join(ROOT, ...APP, "areas", "new", "create-area-form.tsx")));
  });

  test("and that page renders the form a brand new account is given", () => {
    const page = read(...APP, "areas", "new", "page.tsx");
    assert.match(page, /import \{ CreateAreaForm \}/u);
    // The same component the root renders for somebody with no family at all,
    // so there is one screen and one set of rules, not two that drift.
    assert.match(read(...APP, "page.tsx"), /import \{ CreateAreaForm \}/u);
  });

  test("NOBODY DUPLICATES THE CREATE LOGIC. Exactly one place posts a new family", () => {
    const posts = [];
    const walk = (relative) => {
      for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) { walk(child); continue; }
        if (!/\.tsx?$/u.test(entry.name) || /\.test\./u.test(entry.name)) continue;
        const source = withoutComments(read(...child.split("/")));
        // A browser POST to the create route, or a direct call to the routine.
        if (/fetch\("\/api\/areas",\s*\{\s*\n?\s*method: "POST"/u.test(source)
          || /rpc\("create_area"/u.test(source)) {
          posts.push(child);
        }
      }
    };
    walk("src");
    assert.deepEqual(posts.sort(), [
      "src/app/api/areas/route.ts",              // the route itself
      "src/app/areas/new/create-area-form.tsx",  // and the one form that calls it
    ]);
  });

  test("AND NOTHING IS CREATED BY OPENING THE DOOR", () => {
    /*
     * The menu entry and the Settings entry are LINKS. If either were a button
     * that called the route, somebody would make a family by brushing a menu.
     */
    for (const [name, source] of [["the account menu", MENU], ["Your settings", SETTINGS]]) {
      const code = withoutComments(source);
      assert.ok(!/fetch\("\/api\/areas",\s*\{\s*\n?\s*method: "POST"/u.test(code),
        `${name} must not create a family itself`);
      assert.ok(!/create_area/u.test(code), `${name} must not call the routine`);
    }
    // And the form does not act until it is submitted.
    const form = read(...APP, "areas", "new", "create-area-form.tsx");
    assert.match(form, /<form onSubmit=\{submit\}/u);
    assert.match(form, /const submit = async \(event: React\.FormEvent\) => \{/u);
    assert.match(form, /event\.preventDefault\(\);/u);
  });
});

// ===========================================================================
// 3. Settings, which is where somebody looks when a menu has not helped
// ===========================================================================

describe("global Settings manages the families this account belongs to", () => {
  const settings = withoutComments(SETTINGS);

  test("it has a families section of its own", () => {
    assert.match(settings, /<SettingsGroup label="Your families">/u);
    assert.match(settings, /function YourFamilies\(\)/u);
    assert.match(settings, /<YourFamilies \/>/u, "and it is actually rendered");
  });

  test("it lists them, marks the current one, and can switch", () => {
    assert.match(settings, /choices\.map\(\(choice\) =>/u);
    assert.match(settings, /choice\.active/u);
    assert.match(settings, /switchTo\(choice\.id\)/u);
  });

  test("IT OFFERS THE SAME CREATE ACTION, by the same name and route", () => {
    assert.match(settings, /href=\{CREATE_AREA_PATH\}/u);
    assert.match(settings, /title=\{CREATE_AREA_LABEL\}/u);
  });

  test("and it is the only screen that finally links this family's own settings", () => {
    // `/settings/family` was reachable from nowhere at all before this.
    assert.match(settings, /href=\{scopeMeta\("area"\)\.href\}/u,
      "taken from the scope model, so the two cannot name different routes");
  });

  test("Settings itself is a primary destination on every width", () => {
    // Which is what makes the section above reachable without a hover menu.
    const nav = read(...APP, "components", "nav-items.ts");
    assert.match(nav, /section: "settings", href: "\/settings"/u);
    assert.match(read(...APP, "components", "bottom-tabs.tsx"), /GLOBAL_NAV\.map\(\(item\) => \{/u);
  });
});

// ===========================================================================
// 4. On a phone
// ===========================================================================

describe("a phone can reach it too, and not by hovering", () => {
  const bar = read(...APP, "components", "top-bar.tsx");

  test("THE ACCOUNT MENU IS IN THE TOP BAR AT EVERY WIDTH", () => {
    /*
     * The switcher is not desktop chrome: `TopBar` renders on every screen and
     * the account button sits in the same row as search and the bell, with no
     * breakpoint hiding it. So the create action ships to the phone without a
     * second implementation to keep in step.
     */
    assert.match(bar, /<AccountMenu \/>/u);
    const actions = bar.slice(bar.indexOf('className="flex shrink-0 items-center gap-1.5'), bar.indexOf("</header>"));
    assert.ok(actions.includes("<AccountMenu />"), "it must be in the always-visible action row");
    assert.ok(!/hidden|lg:only/u.test(actions.split("<AccountMenu />")[0].split("\n").pop() ?? ""),
      "and not behind a breakpoint");
  });

  test("and the mobile tab bar reaches Settings, which carries the same action", () => {
    const tabs = read(...APP, "components", "bottom-tabs.tsx");
    assert.match(tabs, /lg:hidden/u, "the tab bar is the phone's navigation");
    assert.match(tabs, /GLOBAL_NAV\.map/u);
    const nav = read(...APP, "components", "nav-items.ts");
    assert.match(nav, /label: "Settings"/u);
  });

  test("TWO WAYS IN, so losing one is not a lockout", () => {
    for (const source of [MENU, SETTINGS]) {
      assert.match(withoutComments(source), /CREATE_AREA_PATH/u);
    }
  });
});

// ===========================================================================
// 5. And it is not an event's business
// ===========================================================================

describe("an event does not offer to create a family", () => {
  test("the scope model says so, once, where the screens can read it", () => {
    for (const name of ["Create new family", "Your families"]) {
      assert.ok(NEVER_IN_EVENT_SCOPE.includes(name),
        `${name} must be listed as never belonging to an event`);
    }
  });

  test("THE EVENT'S MORE SCREEN NAMES NEITHER THE ACTION NOR THE ROUTE", () => {
    const screen = withoutComments(read(...APP, "events", "[eventId]", "more", "event-more-screen.tsx"));
    assert.ok(!screen.includes(CREATE_AREA_LABEL));
    assert.ok(!screen.includes(CREATE_AREA_PATH));
    assert.ok(!screen.includes("Your families"));
  });

  test("nor does the event settings screen", () => {
    const screen = withoutComments(read(...APP, "events", "[eventId]", "settings", "settings-screen.tsx"));
    assert.ok(!screen.includes(CREATE_AREA_LABEL));
    assert.ok(!screen.includes(CREATE_AREA_PATH));
  });

  test("and the FAMILY settings screen does not either -- it is one family's own", () => {
    // Which families you belong to is a fact about the account, and lives in
    // Your settings. A family cannot own the answer.
    const screen = withoutComments(read(...APP, "settings", "family", "family-settings-screen.tsx"));
    assert.ok(!screen.includes(CREATE_AREA_LABEL));
    assert.ok(!screen.includes(CREATE_AREA_PATH));
  });
});
