import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * ==========================================================================
 *  THE SERVICE ROLE. IT BYPASSES ROW LEVEL SECURITY *AND* THE WRITE BARRIER.
 * ==========================================================================
 *
 * A client built here is not "an admin client". It is the database with every
 * gate removed: no policy applies to it, migration 037's `default_area_for_new_row`
 * exempts it because it has no `auth.uid()`, and migration 052's global
 * approval gate never runs for it either. There is nothing underneath it.
 *
 * SO EVERY CALLER OWES THREE THINGS, IN THIS ORDER, BEFORE IT TOUCHES A ROW:
 *
 *   1. AUTHENTICATE.  Who is asking? A route handler is a public entry point;
 *                     a UI check upstream is not a check.
 *   2. AUTHORIZE.     May they do this? Read the role from the membership in
 *                     the Area on screen, never from a header or a body.
 *   3. SCOPE.         Say `.eq("area_id", ...)` -- by hand, on every query --
 *                     with an Area that came from step 2. Nothing else will.
 *
 * THIS IS THE ONLY MODULE IN `src/` THAT READS `SUPABASE_SECRET_KEY`, and
 * `scripts/canonical-paths.test.mjs` counts the occurrences so it stays that
 * way. Q18 left three hand-rolled copies of this constructor and a fourth was
 * added later; each threw its own domain error, which is exactly why they could
 * not be merged then. The split below is what makes them mergeable now:
 *
 *   * this module throws ONE low-level `ServiceRoleUnavailableError`, which
 *     says only that the server is not configured, and
 *   * each domain boundary CATCHES it and re-throws its own error type, so
 *     Family Access still answers 503 "Family Access is not configured" and
 *     Notifications still answers 503 "Notifications are not configured".
 *
 * There is no injected constructor and no factory parameter: a seam that lets a
 * caller supply its own client is a seam that lets a caller supply a client
 * built somewhere else, and this file exists to make that impossible.
 */
export class ServiceRoleUnavailableError extends Error {
  constructor() {
    super("The Supabase service role is not configured on this server.");
    this.name = "ServiceRoleUnavailableError";
  }
}

/**
 * A Supabase client holding the service-role key.
 *
 * @throws {ServiceRoleUnavailableError} when either environment value is absent.
 *   Thrown rather than returned, so a caller that forgets to check cannot end
 *   up with a client that quietly has no privileges at all.
 */
export function createServiceRoleClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) throw new ServiceRoleUnavailableError();

  return createSupabaseClient(supabaseUrl, supabaseSecretKey, {
    // No session of any kind: this client is never a person, and a refreshed or
    // persisted token here would be a service-role credential in a store that
    // was designed for a user's.
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

/** The type of the one client, for the helpers that are handed one. */
export type ServiceRoleClient = ReturnType<typeof createServiceRoleClient>;
