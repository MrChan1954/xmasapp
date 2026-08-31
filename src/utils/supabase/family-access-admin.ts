import "server-only";

import { validateUuid } from "@/lib/input-validation";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { ServiceRoleUnavailableError, createServiceRoleClient, type ServiceRoleClient } from "@/utils/supabase/service-role";

export class FamilyAccessError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FamilyAccessError";
  }
}

export type FamilyAccessAdminClient = ServiceRoleClient;

/**
 * The one service-role client, wearing this domain's error.
 *
 * Q18 could not merge the four hand-rolled copies of this constructor because
 * each threw a different type, on the most security-sensitive client in the
 * app. The split is what makes them mergeable: `service-role.ts` owns the key
 * and throws one low-level `ServiceRoleUnavailableError`, and each boundary
 * translates it into the message its own callers already expect. Nothing about
 * the response a browser sees has changed.
 */
function createAdminClient(): ServiceRoleClient {
  try {
    return createServiceRoleClient();
  } catch (error) {
    if (error instanceof ServiceRoleUnavailableError) {
      throw new FamilyAccessError(503, "Family Access is not configured on the server.");
    }
    throw error;
  }
}

/**
 * MAY THIS CALLER ADMINISTER THE FAMILY THEY ARE LOOKING AT?
 *
 * WHY THIS IS NOT "DO THEY HAVE EXACTLY ONE MEMBERSHIP". It used to be, and
 * that was correct for exactly as long as one login meant one family. With
 * Areas it locks out the very person the switcher exists for: administer
 * Alpha, belong to Bravo, and the count is two, so Family Access refused them
 * in BOTH. Failing closed is the right direction to fail, but it is still a
 * failure -- there is no way to run a family you administer.
 *
 * WHAT REPLACES IT. The membership in the Area on screen, resolved by
 * `getCurrentMember` -- the same mechanism every other screen uses, so there is
 * one answer to "which family is this about" and not two that can disagree.
 *
 * THE SELECTED AREA IS A CHOICE, NEVER A PERMISSION.
 *   * The list of memberships is read through the CALLER'S OWN session, so row
 *     level security has already narrowed it to their own rows -- and since
 *     migration 052 that policy also requires global approval, so a rejected or
 *     suspended account reads none of them and is refused here too. A cookie
 *     naming a family they are not in matches nothing and they are refused.
 *   * The role is then read from THAT membership. Administering Alpha says
 *     nothing about Bravo, and selecting Bravo does not carry Alpha's role into
 *     it.
 *   * A login with several memberships and no choice made gets none, which
 *     every caller already treats as "not permitted".
 *
 * Nothing a browser can send makes this return an Area the caller is not an
 * active administrator of.
 *
 * WHAT THIS IS STILL FOR, NOW THAT MOST OF FAMILY ACCESS IS RPCs. Migration 052
 * moved reading, granting and revoking into `list_area_access`,
 * `grant_area_access` and `revoke_area_access`, which authorise themselves from
 * the acting Area and need none of this. What is left needs the SUPABASE ADMIN
 * API -- sending an invitation email, minting a setup link, minting a recovery
 * link -- and there is no database routine that can do those. So this check
 * survives for exactly three actions, and it is the only thing standing between
 * them and the wrong family.
 */
export async function requireFamilyAccessAdmin() {
  const { user, member } = await getCurrentMember();

  if (!user) {
    throw new FamilyAccessError(401, "You must sign in to continue.");
  }

  /**
   * No membership in the family on screen. Deliberately the SAME refusal as
   * "you are a member here but not its administrator": telling the two apart
   * would let somebody probe which families an account belongs to.
   */
  if (!member || !member.active || member.role !== "admin") {
    throw new FamilyAccessError(
      403,
      "Only this family's admin can manage its access.",
    );
  }

  /**
   * THE AREA THIS PERMISSION WAS GRANTED IN, RETURNED WITH IT.
   *
   * Everything past this point uses the SERVICE ROLE -- it has to, because the
   * Admin API is the only thing that can send an invitation or mint a link --
   * and the service role bypasses row level security AND migration 037's write
   * barrier, which exempts callers with no `auth.uid()`. So there is nothing
   * left underneath to keep this route inside one family: the Area has to be
   * carried from the check that authorised it and applied to every query by
   * hand.
   *
   * Without it, an administrator of one family could mint a password-recovery
   * link for the account of a family they have never been in.
   */
  const areaId = (member.area_id as string | null) ?? null;
  if (!areaId) {
    throw new FamilyAccessError(403, "Your account is not linked to a family.");
  }

  return {
    admin: createAdminClient(),
    authUserId: user.id,
    personId: (member.person_id as string | null) ?? null,
    areaId,
  };
}

export function requirePersonId(value: unknown) {
  const result = validateUuid(value, "Select a valid family member.");
  if (!result.ok) throw new FamilyAccessError(400, result.error);
  return result.value;
}

export function passwordSetupRedirect(requestOrigin: string) {
  return new URL(
    "/auth/callback?next=/account-setup",
    requestOrigin,
  ).toString();
}
