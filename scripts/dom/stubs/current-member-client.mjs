/**
 * `current-member-client`, for the DOM suite.
 *
 * This is the trusted answer to "which family is on screen" -- in production it
 * is the `gp_area` cookie reconciled against the reader's own memberships.
 * Switching family here is what switching family does there: the same login,
 * the same two memberships, a different one selected.
 */
export const membership = {
  current: null,
  reset(member = null) { this.current = member; },
  /** A login that belongs to both families, standing in one of them. */
  selectArea(areaId) {
    this.current = { id: "member-" + areaId, person_id: "person-" + areaId, contributor_id: null, role: "admin", active: true, area_id: areaId };
  },
};

export function rememberedAreaId() {
  return membership.current?.area_id ?? null;
}

export async function getCurrentMemberClient() {
  return membership.current;
}
