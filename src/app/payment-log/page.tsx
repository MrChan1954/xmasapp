import { redirectLegacyRoute } from "@/utils/supabase/events-server";

export const dynamic = "force-dynamic";

/** COMPATIBILITY: forwards an old `/payment-log` link into Christmas 2026. */
export default async function LegacyPaymentLogRedirect() {
  return redirectLegacyRoute("payment-log");
}
