/**
 * `shared-session`, for the DOM suite: the same three answers, NOT shared.
 *
 * The real module shares an answer between callers for a few seconds, keyed by
 * the session token. This suite changes the signed-in user, the global status
 * and the selected family between tests in one process, and its fake client has
 * no session token to key on -- so here every call asks afresh, through the same
 * fakes the provider used before the sharing existed. The sharing itself is
 * covered by `src/lib/shared-lookup.test.ts`.
 */
import { loadAccountStatusClient } from "@/utils/supabase/account-status-client";
import { createClient } from "./supabase-client.mjs";
import { getCurrentMemberClient } from "./current-member-client.mjs";

export async function sharedUser() {
  const { data } = await createClient().auth.getUser();
  return data.user ?? null;
}

export async function sharedAccountStatus() {
  return loadAccountStatusClient();
}

export async function sharedMember() {
  return getCurrentMemberClient();
}
