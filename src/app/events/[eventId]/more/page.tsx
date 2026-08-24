import { requireEvent } from "@/utils/supabase/events-server";
import { MoreScreen } from "../../../more/more-screen";

export const dynamic = "force-dynamic";

export default async function EventMorePage({ params }: PageProps<"/events/[eventId]/more">) {
  const { eventId } = await params;
  const event = await requireEvent(eventId);
  return (
    <MoreScreen
      eventId={event.id}
      eventName={event.name}
      // Only a birthday has previous years belonging to one person, so only a
      // birthday offers the link. History lives on the PERSON, not on this
      // year's occurrence.
      celebrantPersonId={event.type === "birthday" ? event.celebrantPersonId : null}
    />
  );
}
