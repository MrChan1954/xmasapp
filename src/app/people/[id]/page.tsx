import { redirectLegacyRoute } from "@/utils/supabase/events-server";

export const dynamic = "force-dynamic";

/**
 * COMPATIBILITY. This route never had a screen of its own -- it has always
 * forwarded to the People list, which opens the person's modal. It now forwards
 * to that list inside Christmas 2026, so notification deep links written before
 * Checkpoint 2 still land on the right person.
 */
export default async function LegacyPersonRedirect({ params }: PageProps<"/people/[id]">) {
  const { id } = await params;
  return redirectLegacyRoute("people", `?person=${encodeURIComponent(id)}`);
}
