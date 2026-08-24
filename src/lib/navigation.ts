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

export type GlobalNavSection = "events" | "people";

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
  if (pathname === "/") return "events";
  return null;
}
