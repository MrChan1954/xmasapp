import { requireEvent } from "@/utils/supabase/events-server";
import { EventHome } from "../../home-screen";

export const dynamic = "force-dynamic";

/**
 * Event Home.
 *
 * `requireEvent` runs before anything renders: it resolves the id from the URL
 * through RLS and answers a plain 404 when the event does not exist or is not
 * visible to this member. The screen below therefore never has to wonder
 * whether its event is real.
 */
export default async function EventHomePage({ params }: PageProps<"/events/[eventId]">) {
  const { eventId } = await params;
  const event = await requireEvent(eventId);
  return (
    <EventHome
      eventId={event.id}
      eventName={event.name}
      eventType={String(event.type)}
      eventDate={event.eventDate}
    />
  );
}
