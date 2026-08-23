import { redirectLegacyRoute } from "@/utils/supabase/events-server";

export const dynamic = "force-dynamic";

/**
 * COMPATIBILITY. `/people` predates event-aware routing and is still in saved
 * bookmarks and in notification links written before Checkpoint 2, so it
 * forwards to the Christmas 2026 People screen with its query string intact.
 * See `redirectLegacyRoute` for why this is the only place allowed to resolve
 * an event by year.
 */
export default async function LegacyPeopleRedirect({ searchParams }: PageProps<"/people">) {
  const params = await searchParams;
  const person = typeof params.person === "string" ? params.person : null;
  return redirectLegacyRoute("people", person ? `?person=${encodeURIComponent(person)}` : "");
}
