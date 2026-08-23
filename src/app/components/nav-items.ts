import { Gift, House, MoreHorizontal, Scale, Users, type LucideIcon } from "lucide-react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventIdFromPath, eventPath, eventSectionFromPath, type EventSection } from "@/lib/events.ts";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  section: EventSection;
  /** Rendered as the raised gold action on the mobile tab bar. */
  primary?: boolean;
};

/**
 * The five destinations inside an event, in tab order.
 *
 * Nothing here is a literal path. The rail and the mobile tabs both build their
 * links from `eventPath`, so a link can only ever point at the event the reader
 * is currently in -- tapping Owed inside Paige's Birthday cannot land on
 * Christmas Owed, because there is nowhere in this file for a bare "/owed" to
 * come from.
 */
const EVENT_NAV: Array<{ section: EventSection; label: string; icon: LucideIcon; primary?: boolean }> = [
  { section: "home", label: "Home", icon: House },
  { section: "people", label: "People", icon: Users },
  { section: "add-purchase", label: "Add", icon: Gift, primary: true },
  { section: "owed", label: "Owed", icon: Scale },
  { section: "more", label: "More", icon: MoreHorizontal },
];

/**
 * The navigation for one event, or an empty list when the reader is not inside
 * one. An empty list is how the dashboard says "there is no event to navigate".
 */
export function navItemsFor(eventId: string | null): NavItem[] {
  if (!eventId) return [];
  return EVENT_NAV.flatMap((item) => {
    const href = eventPath(eventId, item.section);
    return href ? [{ ...item, href }] : [];
  });
}

/**
 * Which tab a path lights up.
 *
 * `more` also owns the screens reached from it -- Payment Log, Account, Family
 * Access, Activity -- so the tab bar does not go blank when the reader follows
 * one of those links.
 */
export function activeNavSection(pathname: string): EventSection | null {
  const section = eventSectionFromPath(pathname);
  if (section === "payment-log" || section === "settings") return "more";
  if (section) return section;
  if (pathname.startsWith("/more") || pathname.startsWith("/account") || pathname.startsWith("/payment-log")) return "more";
  return null;
}

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

/** The dashboard, and the breadcrumb target from anywhere inside an event. */
export const EVENTS_HOME = { href: "/", label: "Events" } as const;

const EVENT_SECTION_TITLES: Record<EventSection, string> = {
  home: "Overview",
  people: "People",
  "add-purchase": "Add purchase",
  owed: "Owed",
  more: "More",
  "payment-log": "Payment log",
  settings: "Event settings",
};

const TITLES: Array<{ test: RegExp; title: string; parent?: { href: string; label: string } }> = [
  { test: /^\/$/u, title: "Events" },
  // Family Access, Activity, Notifications and Account belong to the family
  // rather than to any one event, so they lead back to the dashboard. Sending
  // them to "/more" would bounce through the legacy redirect and land the
  // reader in Christmas even if they arrived from a birthday.
  { test: /^\/more\/family-access/u, title: "Family access", parent: EVENTS_HOME },
  { test: /^\/more\/activity/u, title: "Activity", parent: EVENTS_HOME },
  { test: /^\/more\/notifications/u, title: "Notifications", parent: EVENTS_HOME },
  { test: /^\/account$/u, title: "Account", parent: EVENTS_HOME },
  { test: /^\/events\/new$/u, title: "Create event", parent: EVENTS_HOME },
];

/**
 * The top bar's title and breadcrumb.
 *
 * Inside an event the breadcrumb is the event itself -- Payment Log sits under
 * More, everything else sits under Events -- so there is always a one-tap way
 * back out to the dashboard without reaching for the browser's Back button.
 */
export function pageTitleFor(pathname: string): { title: string; parent?: { href: string; label: string } } {
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
  return match ? { title: match.title, parent: match.parent } : { title: "Christmas Budget" };
}
