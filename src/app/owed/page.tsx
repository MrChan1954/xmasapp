import { redirectLegacyRoute } from "@/utils/supabase/events-server";

export const dynamic = "force-dynamic";

/**
 * COMPATIBILITY. Every money notification written before Checkpoint 2 points
 * here, so this has to keep working: it forwards to Christmas 2026's Owed.
 */
export default async function LegacyOwedRedirect() {
  return redirectLegacyRoute("owed");
}
