import { Gift, House, MoreHorizontal, Scale, Users, type LucideIcon } from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
  /** Rendered as the raised gold action on the mobile tab bar. */
  primary?: boolean;
};

const moreMatch = (pathname: string) =>
  pathname.startsWith("/more") || pathname.startsWith("/account") || pathname.startsWith("/payment-log");

/** Single source of truth — the rail and the mobile tabs both read this. */
export const navItems: NavItem[] = [
  { href: "/", label: "Home", icon: House, match: (p) => p === "/" },
  { href: "/people", label: "People", icon: Users, match: (p) => p.startsWith("/people") },
  { href: "/add-purchase", label: "Add", icon: Gift, match: (p) => p.startsWith("/add-purchase"), primary: true },
  { href: "/owed", label: "Owed", icon: Scale, match: (p) => p.startsWith("/owed") },
  { href: "/more", label: "More", icon: MoreHorizontal, match: moreMatch },
];

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

const TITLES: Array<{ test: RegExp; title: string; parent?: { href: string; label: string } }> = [
  { test: /^\/$/u, title: "Overview" },
  { test: /^\/people$/u, title: "People" },
  { test: /^\/add-purchase/u, title: "Add purchase" },
  { test: /^\/owed/u, title: "Owed" },
  { test: /^\/payment-log/u, title: "Payment log", parent: { href: "/more", label: "More" } },
  { test: /^\/more\/family-access/u, title: "Family access", parent: { href: "/more", label: "More" } },
  { test: /^\/more$/u, title: "More" },
  { test: /^\/account$/u, title: "Account", parent: { href: "/more", label: "More" } },
];

/** Falls back to the app name so the top bar is never blank on an unknown route. */
export function pageTitleFor(pathname: string): { title: string; parent?: { href: string; label: string } } {
  const match = TITLES.find((entry) => entry.test.test(pathname));
  return match ? { title: match.title, parent: match.parent } : { title: "Christmas Budget" };
}
