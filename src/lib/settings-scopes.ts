/**
 * WHERE A SETTING LIVES.
 *
 * Before Areas there was one family, so "settings" was one list and the only
 * question was who was allowed to change what. With more than one family, a
 * setting has a second question that matters more: HOW FAR DOES IT REACH?
 *
 *   global  Follows the PERSON. Their password, their notifications, whether
 *           snow falls. Changing it in one family changes it in all of them,
 *           because it was never about a family at all.
 *   area    Belongs to ONE FAMILY. Its name, who can get into it, who is in it,
 *           what it has recorded. Invisible and irrelevant to every other.
 *   event   Belongs to ONE OCCASION inside a family. Its date, its recipients,
 *           its contributors.
 *
 * PUTTING A SETTING IN THE WRONG SCOPE IS A REAL BUG, not a layout preference.
 * A notification preference filed under a family would silently stop applying
 * when somebody switched; a family's name filed globally would rename both.
 * This module is where that decision is written down once, so the screens agree
 * and a test can check them.
 */

export type SettingsScope = "global" | "area" | "event";

export type ScopeMeta = {
  scope: SettingsScope;
  title: string;
  reach: string;
  href: string;
};

export const SCOPES: readonly ScopeMeta[] = [
  {
    scope: "global",
    title: "Your settings",
    reach: "Follow you into every family you belong to.",
    href: "/settings",
  },
  {
    scope: "area",
    title: "Family settings",
    reach: "Apply to this family only. No other family sees them.",
    href: "/settings/family",
  },
  {
    scope: "event",
    title: "Event settings",
    reach: "Apply to one occasion inside this family.",
    href: "",
  },
];

export type SettingsEntry = {
  key: string;
  scope: SettingsScope;
  title: string;
  description: string;
  href: string;
  /** True when only this family's administrator may open it. */
  adminOnly?: boolean;
};

/**
 * Everything that is not per-event. Event settings are built from the event
 * itself, because their route needs its id and their wording needs its name.
 */
export const SETTINGS: readonly SettingsEntry[] = [
  {
    key: "account",
    scope: "global",
    title: "Account & security",
    description: "Change your password or sign out.",
    href: "/account",
  },
  {
    key: "notifications",
    scope: "global",
    title: "Notifications",
    description: "Choose what you are told about, and on which devices.",
    href: "/more/notifications",
  },
  {
    key: "appearance",
    scope: "global",
    title: "Appearance",
    description: "Falling snow, and how the app looks.",
    href: "/settings",
  },
  {
    key: "family-name",
    scope: "area",
    title: "Family name",
    description: "What this family is called in the switcher.",
    href: "/settings/family",
    adminOnly: true,
  },
  {
    key: "family-access",
    scope: "area",
    title: "Family access",
    description: "Invite family and manage their app access.",
    href: "/more/family-access",
    adminOnly: true,
  },
  {
    key: "people",
    scope: "area",
    title: "People",
    description: "Everyone this family plans for, and what has been bought for them.",
    href: "/people",
  },
  {
    key: "birthdays",
    scope: "area",
    title: "Birthdays",
    description: "Everyone's birthday, and what is coming up.",
    href: "/birthdays",
  },
  {
    key: "activity",
    scope: "area",
    title: "Activity",
    description: "Everything added or removed in this family, and who did it.",
    href: "/more/activity",
  },
];

/** The entries for one scope, in the order they should be shown. */
export function settingsFor(scope: SettingsScope, options: { isAdmin: boolean }): SettingsEntry[] {
  return SETTINGS.filter((entry) => entry.scope === scope)
    .filter((entry) => !entry.adminOnly || options.isAdmin);
}

export function scopeMeta(scope: SettingsScope): ScopeMeta {
  const found = SCOPES.find((meta) => meta.scope === scope);
  if (!found) throw new Error("unknown settings scope: " + scope);
  return found;
}

/**
 * WHAT SWITCHING FAMILY CHANGES.
 *
 * Used by the family-settings screen to say, in the person's own words, that
 * what they are looking at belongs to the family named at the top and to no
 * other. Keeping the sentence here rather than in the markup means the screens
 * and the model cannot drift apart.
 */
export function scopeReminder(scope: SettingsScope, areaName: string): string {
  if (scope === "global") return "These follow you into every family you belong to.";
  if (scope === "area") return "These apply to " + areaName + " only. No other family sees them.";
  return "These apply to one occasion inside " + areaName + ".";
}
