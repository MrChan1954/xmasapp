/*
 * NO "use client" DIRECTIVE, for the reason `current-member-client.ts` gives:
 * this is browser code by virtue of what it calls, and a server module that
 * imported a client reference would throw at render.
 */
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { SIGNED_OUT, type AccountStatus } from "@/lib/account-status.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { createSharedLookup } from "@/lib/shared-lookup.ts";
import { loadAccountStatusClient } from "./account-status-client";
import { createClient } from "./client";
import { getCurrentMemberClient, rememberedAreaId, type ClientMember } from "./current-member-client";

/**
 * WHO IS SIGNED IN, THEIR STATUS AND THEIR MEMBERSHIP -- ASKED ONCE PER BURST.
 *
 * The family context, the account menu and each screen used to ask these for
 * themselves on every page load, so Event Home made seven `getUser` calls,
 * two status calls and three membership reads before its figures arrived.
 * These share one answer between callers for a few seconds; see
 * `createSharedLookup` for the rules.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT. Every caller uses the answer to decide
 * what to SHOW or where to send somebody. None of it authorizes anything: every
 * row is behind row level security, which asks for itself on every request.
 *
 * KEYED BY THE SESSION. The access token is read from the browser's own
 * session storage (no network unless it has expired), so a sign-in, sign-out
 * or token refresh is a new key. A membership is also keyed by the remembered
 * Area, so switching family is a fresh answer, never the previous family's.
 *
 * Only a positive answer is shared. A signed-out status, a missing user or a
 * missing membership is returned to its caller and then forgotten, so a
 * transient failure is never repeated to anybody else.
 */
const SHARE_FOR_MS = 5_000;
const share = createSharedLookup(SHARE_FOR_MS);

class NothingToShare extends Error {}

async function sessionToken(): Promise<string | null> {
  const { data } = await createClient().auth.getSession();
  return data.session?.access_token ?? null;
}

/** The signed-in user, or null. A drop-in for `auth.getUser()`'s `data.user`. */
export async function sharedUser() {
  const token = await sessionToken();
  if (!token) return null;
  try {
    return await share("user", token, async () => {
      const { data } = await createClient().auth.getUser();
      if (!data.user) throw new NothingToShare();
      return data.user;
    });
  } catch {
    return null;
  }
}

/** `my_account_status()`, as `loadAccountStatusClient` answers it. */
export async function sharedAccountStatus(): Promise<AccountStatus> {
  const token = await sessionToken();
  if (!token) return loadAccountStatusClient();
  try {
    return await share("status", token, async () => {
      const status = await loadAccountStatusClient();
      if (status.state === "signed_out") throw new NothingToShare();
      return status;
    });
  } catch {
    return SIGNED_OUT;
  }
}

/** The membership in the family on screen, as `getCurrentMemberClient` answers it. */
export async function sharedMember(): Promise<ClientMember | null> {
  const token = await sessionToken();
  if (!token) return null;
  try {
    return await share("member", `${token}|${rememberedAreaId() ?? ""}`, async () => {
      const member = await getCurrentMemberClient(await sharedUser());
      if (!member) throw new NothingToShare();
      return member;
    });
  } catch {
    return null;
  }
}
