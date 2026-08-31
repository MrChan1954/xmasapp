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
 * ==========================================================================
 *  THIS JOINS NOBODY TO ANYTHING. IT RETURNS `false`, ALWAYS.
 * ==========================================================================
 *
 * READ THIS BEFORE "FIXING" IT. Everything the name promises was true until
 * migration 053 and is now false. `claim_app_member()` is
 * `$$ select false $$` -- `language sql`, `immutable`, so PostgreSQL folds it
 * away entirely. There is no UPDATE left in it to narrow, and NOTHING here
 * writes `app_members.user_id`.
 *
 * WHY IT WAS RETIRED. The old body was one UPDATE with no `where id =`, so
 * confirming an email address joined you to EVERY family that had ever typed it
 * into Family Access, in every Area, with no consent step and no way to learn
 * which families you had just joined. That was coherent while invitations were
 * private and issued by one trusted person; public sign-up made it wrong.
 *
 * WHAT REPLACED IT is an explicit answer the invitee gives themselves:
 * `accept_family_invitation(id)` and `decline_family_invitation(id)`, called
 * from `/invitations` and from nowhere else in this application.
 *
 * WHY THE CALL IS STILL HERE. 053 retired the behaviour and kept the name and
 * the EXECUTE grant on purpose, so an in-flight browser session could not start
 * erroring mid-deploy. Every caller already treated `false` as the ordinary
 * case -- "nothing was waiting on this address" -- so they all kept working and
 * simply stopped joining anybody. The call sites are harmless and are removed
 * with the routine itself, in one change, once no deployed client can still
 * reach it.
 *
 * DO NOT restore an automatic claim, and do not "repair" this by pointing it at
 * `accept_family_invitation`. Joining a family requires the invitee to say yes.
 */
export async function claimInvitations(): Promise<boolean> {
  const db = await createClient();
  const { data, error } = await db.rpc("claim_app_member");
  if (error) return false;
  return data === true;
}
