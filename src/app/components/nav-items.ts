import { CalendarDays, Contact, Gift, House, MoreHorizontal, Scale, Settings, Sparkles, UserPlus, Users, type LucideIcon } from "lucide-react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventNavMode, eventPath, eventSectionFromPath, type EventNavMode, type EventSection } from "@/lib/events.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { DEFAULT_PAGE_TITLE, EVENTS_HOME, FAMILY_SETTINGS_HOME, SETTINGS_HOME, activeGlobalSection, pageTitleFor, type Crumb, type GlobalNavSection, type PageTitle } from "@/lib/navigation.ts";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  section: EventSection;
  /** Rendered as the raised gold action on the mobile tab bar. */
  primary?: boolean;
};

type NavEntry = { section: EventSection; label: string; icon: LucideIcon; primary?: boolean };

/**
 * The destinations inside an event, in tab order, for each shape an event can
 * take.
 *
 * SAME ROUTES, DIFFERENT SIGNPOSTS.
 *
 * Every mode below points at the same five sections. Nothing is duplicated, no
 * screen is forked, and no financial path changes -- what changes is the WORD
 * on the tab and, for an event with nobody in it yet, whether a tab that has no
 * target is offered at all.
 *
 *   multi   Christmas, and any event for two or more people. Unchanged.
 *   single  Mother's Day, a wedding, an anniversary. "People" becomes "Gifts",
 *           because a list of one card is a tap that answers nothing.
 *   empty   Nothing has been set up. "Add" is withheld -- a purchase form with
 *           no recipient to choose is a dead end -- and the People tab becomes
 *           the setup step it actually is.
 *
 * Nothing here is a literal path. The rail and the mobile tabs both build their
 * links from `eventPath`, so a link can only ever point at the event the reader
 * is currently in -- tapping Owed inside Paige's Birthday cannot land on
 * Christmas Owed, because there is nowhere in this file for a bare "/owed" to
 * come from.
 */
const EVENT_NAV: Record<EventNavMode, NavEntry[]> = {
  multi: [
    { section: "home", label: "Home", icon: House },
    { section: "people", label: "People", icon: Users },
    { section: "add-purchase", label: "Add", icon: Gift, primary: true },
    { section: "owed", label: "Owed", icon: Scale },
    { section: "more", label: "More", icon: MoreHorizontal },
  ],
  single: [
    { section: "home", label: "Home", icon: House },
    // Sparkles is already the app's glyph for a gift idea, and this one tab is
    // where the ideas and the bought gifts both live.
    { section: "people", label: "Gifts", icon: Sparkles },
    { section: "add-purchase", label: "Add", icon: Gift, primary: true },
    { section: "owed", label: "Owed", icon: Scale },
    { section: "more", label: "More", icon: MoreHorizontal },
  ],
  empty: [
    { section: "home", label: "Home", icon: House },
    { section: "people", label: "Set up", icon: UserPlus },
    { section: "owed", label: "Owed", icon: Scale },
    { section: "more", label: "More", icon: MoreHorizontal },
  ],
};

/**
 * The navigation for one event, or an empty list when the reader is not inside
 * one. An empty list is how the dashboard says "there is no event to navigate".
 *
 * @param activeRecipientCount how many people this event is currently for, or
 *   `null` while that is still loading -- which yields the full set rather than
 *   a tab bar that changes shape under the reader's thumb.
 */
export function navItemsFor(eventId: string | null, activeRecipientCount: number | null = null): NavItem[] {
  if (!eventId) return [];
  return EVENT_NAV[eventNavMode(activeRecipientCount)].flatMap((item) => {
    const href = eventPath(eventId, item.section);
    return href ? [{ ...item, href }] : [];
  });
}

/**
 * Which tab a path lights up.
 *
 * `more` owns the two screens reached from it that still belong to the event --
 * this event's Payment Log and this event's Settings -- so the tab bar does not
 * go blank when the reader follows either.
 *
 * IT NO LONGER CLAIMS THE FAMILY-LEVEL ROUTES. `/account`, `/more/notifications`
 * and the rest used to light the event's More tab, because the event More screen
 * was where they were listed. They are Settings now, they are not inside any
 * event, and `activeGlobalSection` lights them instead -- so answering "more"
 * here would light a tab bar that is not even rendered on those screens.
 */
export function activeNavSection(pathname: string): EventSection | null {
  const section = eventSectionFromPath(pathname);
  if (section === "payment-log" || section === "settings") return "more";
  return section ?? null;
}

// ---------------------------------------------------------------------------
// Navigation that belongs to the FAMILY, not to an event
// ---------------------------------------------------------------------------

/**
 * The destinations that exist whether or not the reader is inside an event.
 *
 * WHY THIS LIST HAD TO EXIST. Every navigation item in this file used to be
 * event-scoped: `navItemsFor` returns nothing without an event id, so outside
 * one the rail offered a single hard-coded Events link and the mobile tab bar
 * rendered NOTHING AT ALL. That was survivable while every screen worth
 * reaching lived inside an event. The People directory does not, so it was
 * reachable only by typing the URL.
 *
 * PEOPLE HERE IS NOT AN EVENT'S PEOPLE TAB. This is the family directory: every
 * person, their birthday, and what has been bought for them across every event.
 * An event's People tab is its RECIPIENTS -- who that one occasion is for. Same
 * word, different question, and they are deliberately built from different
 * lists so neither can drift into the other.
 *
 * "The family" is the current planning context. Phase 5 makes that an Area; the
 * href stays a plain path so nothing here has to change when it does.
 */
export type GlobalNavItem = {
  section: GlobalNavSection;
  href: string;
  label: string;
  icon: LucideIcon;
};

export const GLOBAL_NAV: readonly GlobalNavItem[] = [
  { section: "events", href: "/", label: "Events", icon: CalendarDays },
  // `Contact` rather than `Users`: `Users` is the event People tab, and two
  // different questions should not wear the same glyph in the same app.
  { section: "people", href: "/people", label: "People", icon: Contact },
  /*
   * SETTINGS IS A PRIMARY DESTINATION, not something reached from inside an
   * event.
   *
   * It used to be neither: the whole settings list was rendered by the event
   * More screen, so the only way to change your own password was to walk into
   * an event first -- and once Areas existed, the family-level screens in that
   * list looked like they belonged to the event surrounding them. Settings sits
   * beside Events and People because that is its actual scope: it follows the
   * reader, not the occasion.
   */
  { section: "settings", href: "/settings", label: "Settings", icon: Settings },
];

// Route matching lives in `src/lib/navigation.ts` and is re-exported here, so
// the components have one import and a test can run the real function.
export { activeGlobalSection, type GlobalNavSection };

/**
 * Signed-out entry points. These render their own full-screen frame, carry no
 * app chrome, and have no family data to load.
 */
const AUTH_ROUTES = new Set([
  "/login",
  "/forgot-password",
  "/reset-password",
  "/account-setup",
  "/auth/callback",
]);

export function isAuthRoute(pathname: string) {
  return AUTH_ROUTES.has(pathname);
}

/*
 * TITLES AND BREADCRUMBS MOVED TO `src/lib/navigation.ts` IN Q9, and are
 * re-exported here so every component keeps its single import.
 *
 * THE MOVE IS THE FIX, not tidying. While the table lived in this file it could
 * only ever be checked by matching a regular expression against the source --
 * this module imports lucide's icon components, which the plain test runner
 * cannot load -- and a regex can only confirm the entries that are ALREADY
 * there. It cannot notice five routes that were never added, or two parents
 * pointing at a screen the reader did not come from, and those were exactly the
 * faults. Next door the same function is a plain call a test can make.
 */
export {
  DEFAULT_PAGE_TITLE,
  EVENTS_HOME,
  FAMILY_SETTINGS_HOME,
  SETTINGS_HOME,
  pageTitleFor,
  type Crumb,
  type PageTitle,
};
