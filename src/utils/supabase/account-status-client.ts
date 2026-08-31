/*
 * NO "use client" DIRECTIVE, for the reason given at the top of
 * `current-member-client.ts`: it would turn every export into a client
 * reference. This is browser code because of the client it builds.
 */
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { SIGNED_OUT, accountStatusFrom, type AccountStatus, type AccountStatusRow } from "@/lib/account-status.ts";
/*
 * THE ALIASED SPECIFIER, NOT `./client`, AND ON PURPOSE. The DOM suite's module
 * hook substitutes a fixture for `@/utils/supabase/client` by exact specifier,
 * so a relative import here would reach the real `createBrowserClient` in a
 * test with no Supabase URL and throw. Its two neighbours -- `area-choice-client`
 * and `current-member-client` -- are each substituted wholesale instead, which
 * is why they can spell it either way and this one cannot.
 */
import { createClient } from "@/utils/supabase/client";

/**
 * THIS ACCOUNT'S GLOBAL STATUS, IN THE BROWSER.
 *
 * ONE RPC AND NOTHING ELSE. `app_accounts` has no privilege for `authenticated`
 * and zero policies, so `db.from("app_accounts")` cannot work from a browser
 * even if somebody writes it -- and `scripts/account-approval-runtime.test.mjs`
 * asserts that nobody has. `my_account_status()` is the whole read surface: it
 * answers about the caller and nobody else, and it is the only routine an
 * unapproved account may call successfully.
 *
 * A FAILED CALL IS `signed_out`, NOT "approved". The RPC returns no row when
 * nobody is signed in; a network failure is indistinguishable from that here,
 * and treating either as approved would be the one mistake worth avoiding.
 * Nothing is opened by getting it wrong in this direction: the caller is sent
 * to `/login`, and every gated routine re-asks the question for itself.
 */
export async function loadAccountStatusClient(): Promise<AccountStatus> {
  const { data, error } = await createClient().rpc("my_account_status");
  if (error) return SIGNED_OUT;
  return accountStatusFrom(firstRow(data));
}

/**
 * `my_account_status()` is `returns table (...)`, so PostgREST sends an array
 * of at most one row -- but supabase-js unwraps a single-row set-returning
 * function to an object in some versions, and a fixture may hand back either.
 * Both shapes mean the same thing and neither is worth a bug.
 */
export function firstRow(data: unknown): AccountStatusRow | null {
  if (Array.isArray(data)) return (data[0] as AccountStatusRow | undefined) ?? null;
  if (data && typeof data === "object") return data as AccountStatusRow;
  return null;
}
