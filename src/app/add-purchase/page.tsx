import { redirectLegacyRoute } from "@/utils/supabase/events-server";

export const dynamic = "force-dynamic";

/** COMPATIBILITY: forwards an old `/add-purchase` link into Christmas 2026. */
export default async function LegacyAddPurchaseRedirect({ searchParams }: PageProps<"/add-purchase">) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["edit", "idea", "recipient"]) {
    const value = params[key];
    if (typeof value === "string") query.set(key, value);
  }
  const search = query.toString();
  return redirectLegacyRoute("add-purchase", search ? `?${search}` : "");
}
