/**
 * WHO CAN REACH THIS FAMILY, AND HOW FAR THROUGH THE DOOR THEY ARE.
 *
 * Family Access used to answer this from three service-role reads -- every
 * person, every membership, and EVERY AUTH ACCOUNT IN THE PROJECT -- and derive
 * four states from them in the route handler. Migration 052 replaced all of
 * that with `list_area_access()`, which takes no Area and no email parameter,
 * so it cannot be pointed at another family and cannot be used to probe whether
 * an address has an account. What is left is this: turning one of its rows into
 * one word.
 *
 * PURE, AND SEPARATE FROM THE SCREEN, so a test can run the real mapping rather
 * than assert on markup. Nothing here is a permission -- the routine has
 * already refused anybody who is not this Area's administrator.
 *
 * WHY THERE ARE FIVE STATES AND THERE USED TO BE FOUR. The old `pending` meant
 * "invited, has not set a password". Under 052 that one word was hiding two
 * completely different situations with different people to chase:
 *
 *   awaiting_signup            nobody has claimed the invitation yet. The
 *                              family administrator can act: resend it.
 *   awaiting_global_approval   somebody HAS claimed it, and Gift Planner has
 *                              not approved their account. The family
 *                              administrator can do nothing at all, and telling
 *                              them so is the point.
 */

export type AreaAccessStatus =
  | "no_access"
  | "awaiting_signup"
  | "awaiting_global_approval"
  | "active"
  | "revoked";

/** One row of `list_area_access()`, exactly as the routine declares it. */
export type AreaAccessRow = {
  person_id: string;
  person_name: string;
  /** Null when this person has no seat in this family at all. */
  app_member_id: string | null;
  email: string | null;
  role: string | null;
  active: boolean | null;
  claimed: boolean | null;
  /** Null until a login is attached; the routine will not disclose otherwise. */
  account_status: string | null;
  email_confirmed: boolean | null;
};

/**
 * The one word, in the order the questions have to be asked.
 *
 *   1. NO SEAT is not the same as a disabled one, and it comes first because
 *      every field below it is null in that case.
 *   2. REVOKED beats everything a revoked seat still remembers. `active = false`
 *      keeps `user_id` and the address deliberately, so restoring access
 *      restores the same person's seat rather than opening it to whoever asks
 *      -- which means a revoked seat can still look claimed and approved.
 *   3. UNCLAIMED is an invitation. `user_id` is null, so there is no account to
 *      have a status and the routine sends none.
 *   4. Everything else turns on the GLOBAL status, and only `approved` is in.
 *      An unconfirmed address lands here too: the account exists, and it is
 *      waiting on the same thing.
 */
export function areaAccessStatus(row: AreaAccessRow): AreaAccessStatus {
  if (!row.app_member_id) return "no_access";
  if (row.active !== true) return "revoked";
  if (row.claimed !== true) return "awaiting_signup";
  return row.account_status === "approved" && row.email_confirmed === true
    ? "active"
    : "awaiting_global_approval";
}

export const AREA_ACCESS_LABELS: Record<AreaAccessStatus, string> = {
  no_access: "No access",
  awaiting_signup: "Awaiting sign-up",
  awaiting_global_approval: "Waiting for Gift Planner approval",
  active: "Active",
  revoked: "Revoked",
};

/**
 * WHAT THE ADMINISTRATOR CAN ACTUALLY DO ABOUT IT.
 *
 * The sentence for `awaiting_global_approval` is the one that had to be
 * written carefully. A family administrator seeing "waiting" with no
 * explanation will resend the invitation, change the address, and eventually
 * ask the person to sign up again -- none of which can possibly help, because
 * the thing being waited on is not in this family at all. So it says who can
 * end it, and it does not offer a link to `/admin/accounts`: an ordinary Area
 * administrator has no business there, and a door that answers 404 is worse
 * than no door.
 */
export const AREA_ACCESS_EXPLANATIONS: Record<AreaAccessStatus, string> = {
  no_access: "They are in the family, but cannot sign in yet.",
  awaiting_signup: "The invitation is waiting for them to sign up with this address.",
  awaiting_global_approval:
    "This family’s access is ready. Their Gift Planner account is still waiting for approval, which only a Gift Planner administrator can give.",
  active: "They can sign in and use this family.",
  revoked: "Their access is switched off. The seat is kept, so giving it back restores the same person.",
};

/**
 * ADMINISTRATORS ARE NOT MANAGED HERE, and the database agrees.
 *
 * `grant_area_access` refuses the administrator's own seat and
 * `revoke_area_access` refuses `role = 'admin'`, because an Area has exactly
 * one active administrator (035) and neither routine knows that invariant.
 * Administration moves through `transfer_area_admin` and departs through
 * `leave_area`. Offering a control that is going to be refused is worse than
 * offering none, so the screen asks this before drawing any.
 */
export function isAdminSeat(row: AreaAccessRow): boolean {
  return row.role === "admin";
}

/** Whether "Give access" is the offer, or "Remove access" is. */
export function canGrantAccess(row: AreaAccessRow): boolean {
  if (isAdminSeat(row)) return false;
  const status = areaAccessStatus(row);
  return status === "no_access" || status === "revoked";
}

export function canRevokeAccess(row: AreaAccessRow): boolean {
  if (isAdminSeat(row)) return false;
  return !canGrantAccess(row);
}
