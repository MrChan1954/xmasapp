import { SIGNED_OUT, accountStatusFrom, type AccountStatus } from "@/lib/account-status";
import { firstRow } from "./account-status-client";
import { createClient } from "./server";

/**
 * THIS ACCOUNT'S GLOBAL STATUS, ON THE SERVER.
 *
 * The mirror of `account-status-client.ts`, which cannot be used from a Server
 * Component because its client reads `document.cookie`. Both call the same
 * routine and both hand the row to the same pure function, so a server render
 * and the browser that hydrates it cannot reach different conclusions about the
 * same account.
 *
 * NO AREA IS INVOLVED AND NONE MAY BE. `my_account_status()` takes no
 * parameter, reads no membership and touches no family table -- which is
 * exactly what lets `/admin/accounts` authorise itself for a Gift Planner
 * administrator who belongs to no family at all.
 */
export async function loadAccountStatus(): Promise<AccountStatus> {
  const db = await createClient();
  const { data, error } = await db.rpc("my_account_status");
  if (error) return SIGNED_OUT;
  return accountStatusFrom(firstRow(data));
}

/**
 * Attach this login to any invitation waiting on its confirmed address.
 *
 * THE ONE ROUTINE THAT MAY WRITE `app_members.user_id`, and the only supported
 * way to do it -- `grant_area_access` deliberately never writes that column,
 * because only the claimant can prove which login is theirs.
 *
 * SAFE TO CALL WHENEVER, AND CALLED ON EVERY SIGN-IN ON PURPOSE. It returns
 * `false` for an unconfirmed address (052 added that conjunct: signing up as
 * somebody else's address used to be enough to walk into their family), `false`
 * when there is nothing to claim, and it refuses a second seat in a family this
 * login already sits in. So an invitation issued AFTER somebody signed up is
 * picked up the next time they sign in, instead of needing a fresh email.
 *
 * A FAILURE IS NEVER FATAL. The claim is an improvement to the caller's
 * situation, not a permission check; swallowing the error keeps a database
 * hiccup from turning a legitimate sign-in into a lockout.
 */
export async function claimInvitations(): Promise<boolean> {
  const db = await createClient();
  const { data, error } = await db.rpc("claim_app_member");
  if (error) return false;
  return data === true;
}
