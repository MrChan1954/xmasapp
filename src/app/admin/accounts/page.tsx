import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { destinationFor } from "@/lib/account-status";
import { loadAccountStatus } from "@/utils/supabase/account-status-server";
import { GlobalAccountsScreen } from "./global-accounts-screen";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gift Planner accounts",
  description: "Approve, reject and suspend Gift Planner accounts.",
};

/**
 * THE GLOBAL APPROVAL QUEUE.
 *
 * The one screen in Gift Planner that is not about a family, and the only one
 * an account with NO family must be able to use. Every other route in the app
 * resolves a membership, an acting Area, or both; this one resolves neither,
 * and `scripts/account-approval-runtime.test.mjs` walks its imports to make
 * sure it stays that way. A Gift Planner administrator who belongs to no
 * family sees no gift, no budget, no birthday and no name -- that separation is
 * the entire point of having two kinds of administrator.
 *
 * TWO REFUSALS, AND THEY ARE DELIBERATELY DIFFERENT SHAPES:
 *
 *   not approved      redirected to wherever their own status says they belong
 *                     -- the sign-in form, the pending screen or the refused
 *                     one. They are being told about themselves, which is fair.
 *
 *   approved, not a   `notFound()`. A 403 would confirm that `/admin/accounts`
 *   global admin      exists and that there is a queue behind it, to somebody
 *                     who has just gone looking for one. A family administrator
 *                     gets the same page a typo gets.
 *
 * NEITHER IS THE BOUNDARY. `list_accounts`, `set_account_status`,
 * `grant_global_admin` and `revoke_global_admin` each re-ask
 * `is_global_admin()` for themselves and raise 42501 if the answer is no, so
 * the screen being reachable would still open nothing. This decides what is
 * rendered; the database decides what may be read or written.
 */
export default async function GlobalAccountsPage() {
  const status = await loadAccountStatus();

  const destination = destinationFor(status.state, "/admin/accounts");
  if (destination) redirect(destination);
  if (!status.isGlobalAdmin) notFound();

  return <GlobalAccountsScreen />;
}
