/**
 * Which family-level destination a path belongs to.
 *
 * SEPARATE FROM `nav-items.ts` FOR ONE REASON: this is pure string logic with
 * no imports, so it can be exercised as a real function by a test. `nav-items`
 * pulls in the event model through a path alias the plain test runner cannot
 * resolve, which would leave route matching provable only by reading the source
 * -- and route matching is exactly the part worth running.
 *
 * "Family" is the current planning context. Phase 5 makes that an Area; these
 * are plain paths, so nothing here has to change when it does.
 */

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
