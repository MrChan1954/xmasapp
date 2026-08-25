/**
 * Areas: the families a person belongs to, and which one they are looking at.
 *
 * AN AREA IS A WHOLE SEPARATE FAMILY. Its people, its events, its money and its
 * history are invisible to every other one -- not filtered out in a query
 * somewhere, but refused by the database itself (migrations 034-038). Nothing in
 * this file is a security boundary; it decides which family to SHOW, and the
 * server decides what may be shown at all.
 *
 * WHY THE ACTIVE AREA IS A PREFERENCE, NOT A ROUTE. Every existing link in the
 * app -- `/events/<id>`, `/people/<id>`, every bookmark anybody has saved --
 * names a resource, not a family. Putting the Area in the path would break all
 * of them and would say the same thing twice, because a resource already knows
 * which Area it is in. So the Area is remembered per browser, and a resource is
 * authorised by its OWN Area regardless of which one is currently selected.
 */

/** The cookie the browser remembers a choice of Area in. */
export const AREA_COOKIE = "gp_area";

export type Area = {
  id: string;
  name: string;
  /** Set when a family has been put away. Still readable, never the default. */
  archivedAt: string | null;
};

export type AreaRow = {
  id: string;
  name: string;
  archived_at?: string | null;
};

export function areaFromRow(row: AreaRow): Area {
  return { id: row.id, name: row.name, archivedAt: row.archived_at ?? null };
}

/** Live families first, then archived, each alphabetically. */
export function sortAreas(areas: readonly Area[]): Area[] {
  return [...areas].sort((a, b) => {
    if ((a.archivedAt === null) !== (b.archivedAt === null)) return a.archivedAt === null ? -1 : 1;
    return a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" });
  });
}

/**
 * WHICH FAMILY TO SHOW.
 *
 * The remembered choice wins, but only if it is still one of theirs -- a cookie
 * left over from a family somebody has left names an Area they can no longer
 * read, and honouring it would produce a screen with nothing on it and no
 * explanation. Falling back to a family they ARE in is always better than
 * showing an empty one.
 *
 * An archived family can still be chosen deliberately; it is only never chosen
 * FOR you.
 */
export function resolveActiveArea(areas: readonly Area[], remembered: string | null | undefined): Area | null {
  const ordered = sortAreas(areas);
  if (ordered.length === 0) return null;

  const asked = remembered ? ordered.find((area) => area.id === remembered) : undefined;
  if (asked) return asked;

  return ordered.find((area) => area.archivedAt === null) ?? ordered[0];
}

/**
 * Somebody with no family at all. Not an error and not an empty dashboard: the
 * first thing they see should be the one action that gets them started.
 */
export function needsFirstArea(areas: readonly Area[]): boolean {
  return areas.length === 0;
}

/**
 * WHETHER TO OFFER A SWITCHER AT ALL.
 *
 * One family is the normal case and always will be for most people. Showing a
 * chooser with a single entry adds a control that can only ever do nothing, so
 * the switcher appears when there is genuinely something to switch to.
 */
export function shouldOfferSwitcher(areas: readonly Area[]): boolean {
  return areas.length > 1;
}

export type AreaChoice = Area & { active: boolean };

/** The switcher's list: every family, in order, with the current one marked. */
export function areaChoices(areas: readonly Area[], activeId: string | null): AreaChoice[] {
  return sortAreas(areas).map((area) => ({ ...area, active: area.id === activeId }));
}

/**
 * The name to put in front of somebody. Falls back rather than rendering the
 * word "undefined" into a header if an Area ever arrives without one.
 */
export function areaLabel(area: Area | null): string {
  const trimmed = area?.name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Your family";
}

/**
 * What a name has to be before it is worth sending to the server.
 *
 * The database has the last word (`areas_name_safe_check`); this exists so the
 * person typing finds out immediately rather than after a round trip.
 */
export function validateAreaName(input: string): { ok: true; value: string } | { ok: false; reason: string } {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0) return { ok: false, reason: "Give this family a name." };
  if (trimmed.length > 80) return { ok: false, reason: "That name is too long — 80 characters at most." };
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, reason: "That name contains characters we cannot store." };
  return { ok: true, value: trimmed };
}
