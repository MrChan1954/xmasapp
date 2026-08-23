import { redirectLegacyRoute } from "@/utils/supabase/events-server";

export const dynamic = "force-dynamic";

/** COMPATIBILITY: forwards an old `/more` link into Christmas 2026. */
export default async function LegacyMoreRedirect() {
  return redirectLegacyRoute("more");
}
