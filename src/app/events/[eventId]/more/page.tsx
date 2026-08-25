import { requireEvent } from "@/utils/supabase/events-server";
import { EventMoreScreen } from "./event-more-screen";

export const dynamic = "force-dynamic";

/**
 * The EVENT scope. It used to render the global `MoreScreen`, which is why an
 * event's More menu carried the whole application's settings; that screen is
 * gone and `/settings` is the hub. See `src/lib/settings-scopes.ts`.
 */
export default async function EventMorePage({ params }: PageProps<"/events/[eventId]/more">) {
  const { eventId } = await params;
  const event = await requireEvent(eventId);
  return <EventMoreScreen eventId={event.id} eventName={event.name} />;
}
