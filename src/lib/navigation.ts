/**
 * WHERE A PATH IS, said two ways: which primary destination it belongs to, and
 * what the sticky bar should call it.
 *
 * SEPARATE FROM `nav-items.ts` FOR ONE REASON: everything here is string logic
 * over RELATIVE imports, so it can be exercised as a real function by a test.
 * `nav-items` pulls in lucide's icon components and the `@/` path alias, neither
 * of which the plain test runner can load -- which would leave route matching
 * provable only by reading the source, and route matching is exactly the part
 * worth running.
 *
 * `pageTitleFor` MOVED HERE FROM `nav-items.ts` DURING Q9, and the move is the
 * point rather than tidying: the table had five routes missing and two wrong
 * parents, and every one of those was invisible to a regex that only checked
 * the entries which were already there. A test can now ask it what it answers.
 *
 * "Family" is the current planning context. Phase 5 makes that an Area; these
 * are plain paths, so nothing here has to change when it does.
 */
// Explicit `.ts` extensions: Node's built-in type-stripping test runner
// resolves the specifier literally, which is what lets a test import this file
// and call the real function.
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventIdFromPath, eventPath, eventSectionFromPath, type EventSection } from "./events.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { CREATE_AREA_LABEL } from "./areas.ts";

export type GlobalNavSection = "events" | "people" | "settings";

/**
 * The settings destinations, listed once.
 *
 * Settings is a HUB, not a single page: `/settings` offers the global scope and
 * points at the family's own, and both of those lead on to screens that keep
 * their historic routes (`/account`, `/more/notifications`, `/more/activity`,
 * `/more/family-access`). All of them are still "in Settings" as far as the
 * reader is concerned, so all of them keep the nav entry lit rather than
 * dropping the highlight the moment somebody follows a link.
 *
 * `/more` on its own is deliberately absent: it is a legacy redirect INTO an
 * event, not a settings screen.
 */
const SETTINGS_ROUTES = [
  "/settings",
  "/account",
  "/more/notifications",
  "/more/activity",
  "/more/family-access",
];

/**
 * A person's profile keeps People lit. Being three levels into somebody's gift
 * history is still being in People, and letting the highlight fall back to
 * Events would tell the reader they were somewhere they are not.
 *
 * AN EVENT'S PEOPLE TAB IS NOT THIS. `/events/<id>/people` is that event's
 * recipients -- a different question wearing the same word -- and the two
 * prefixes cannot reach each other.
 */
export function activeGlobalSection(pathname: string): GlobalNavSection | null {
  if (pathname === "/people" || pathname.startsWith("/people/")) return "people";
  if (SETTINGS_ROUTES.some((route) => pathname === route || pathname.startsWith(route + "/"))) {
    return "settings";
  }
  if (pathname === "/") return "events";
  return null;
}

// ---------------------------------------------------------------------------
// What the sticky bar calls a route, and what it leads back to
// ---------------------------------------------------------------------------

export type Crumb = { href: string; label: string };
export type PageTitle = { title: string; parent?: Crumb };

/** The dashboard, and the breadcrumb target from anywhere inside an event. */
export const EVENTS_HOME = { href: "/", label: "Events" } as const;
/** The two settings hubs. See `src/lib/settings-scopes.ts` for why there are three scopes. */
export const SETTINGS_HOME = { href: "/settings", label: "Settings" } as const;
export const FAMILY_SETTINGS_HOME = { href: "/settings/family", label: "Family settings" } as const;
const PEOPLE_HOME = { href: "/people", label: "People" } as const;

/** The name of the app itself, used only when no route below claims the path. */
export const DEFAULT_PAGE_TITLE = "Family Gift Planner";

const EVENT_SECTION_TITLES: Record<EventSection, string> = {
  home: "Overview",
  people: "People",
  "add-purchase": "Add purchase",
  owed: "Owed",
  more: "More",
  "payment-log": "Payment log",
  settings: "Event settings",
};

/**
 * The routes that are not inside an event, in FIRST-MATCH order -- which is why
 * `/settings/family` is listed above `/settings`.
 *
 * WHAT WAS WRONG HERE, measured on the deployed site rather than reasoned
 * about. Two faults with one cause: the table had only ever been given the
 * routes that existed before Settings became a primary destination.
 *
 *   1. NO ENTRY MEANT THE APP'S OWN NAME. `pageTitleFor` falls back to
 *      `DEFAULT_PAGE_TITLE`, so the sticky bar on `/settings`,
 *      `/settings/family`, `/people`, `/birthdays` and `/areas/new` read
 *      "Family Gift Planner" -- the application's name where the screen's name
 *      belongs. On a phone that bar and the tab bar are the whole of the
 *      chrome, and one of the two was saying nothing. `/settings/family` had no
 *      way back up to `/settings` at all except the browser's own Back button.
 *
 *   2. THE FAMILY'S OWN SETTINGS LED TO THE DASHBOARD. Family access and
 *      Activity are Area-scoped settings catalogued on `/settings/family`, and
 *      their breadcrumb said "Events" and went to `/`. Following it dropped the
 *      reader on the events list -- not where they came from, and not
 *      containing what they had just been looking at. Account and Notifications
 *      had already been patched one at a time with an explicit `parent` prop on
 *      their own pages; these two were missed, which is precisely the drift a
 *      single table exists to prevent.
 *
 * WHY SOME ENTRIES CARRY NO PARENT. Events, People and Settings are the three
 * primary destinations -- they are what the rail and the tab bar point AT, so
 * there is nothing above them to go to. `/birthdays` is bare for the opposite
 * reason: it is reached both from the dashboard and from the family's settings,
 * so any fixed breadcrumb would be a lie half the time.
 */
const TITLES: Array<{ test: RegExp; title: string; parent?: Crumb }> = [
  { test: /^\/$/u, title: "Events" },
  { test: /^\/people$/u, title: "People" },
  { test: /^\/people\/new$/u, title: "Add person", parent: PEOPLE_HOME },
  { test: /^\/settings\/family$/u, title: FAMILY_SETTINGS_HOME.label, parent: SETTINGS_HOME },
  { test: /^\/settings$/u, title: SETTINGS_HOME.label },
  { test: /^\/birthdays$/u, title: "Birthdays" },
  { test: /^\/more\/family-access/u, title: "Family access", parent: FAMILY_SETTINGS_HOME },
  { test: /^\/more\/activity/u, title: "Activity", parent: FAMILY_SETTINGS_HOME },
  { test: /^\/more\/notifications/u, title: "Notifications", parent: SETTINGS_HOME },
  { test: /^\/account$/u, title: "Account", parent: SETTINGS_HOME },
  { test: /^\/areas\/new$/u, title: CREATE_AREA_LABEL, parent: SETTINGS_HOME },
  { test: /^\/events\/new$/u, title: "Create event", parent: EVENTS_HOME },
];

/**
 * The top bar's title and breadcrumb.
 *
 * Inside an event the breadcrumb is the event itself -- Payment Log sits under
 * More, everything else sits under Events -- so there is always a one-tap way
 * back out to the dashboard without reaching for the browser's Back button.
 */
export function pageTitleFor(pathname: string): PageTitle {
  const eventId = eventIdFromPath(pathname);
  const section = eventSectionFromPath(pathname);
  if (eventId && section) {
    if (section === "home") return { title: EVENT_SECTION_TITLES.home, parent: EVENTS_HOME };
    const parent = section === "payment-log"
      ? { href: eventPath(eventId, "more") ?? "/", label: "More" }
      : EVENTS_HOME;
    return { title: EVENT_SECTION_TITLES[section], parent };
  }

  const match = TITLES.find((entry) => entry.test.test(pathname));
  return match ? { title: match.title, parent: match.parent } : { title: DEFAULT_PAGE_TITLE };
}
