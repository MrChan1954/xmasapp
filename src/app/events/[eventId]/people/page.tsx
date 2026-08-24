import { requireEvent } from "@/utils/supabase/events-server";
import { PeopleScreen } from "../../../people/people-screen";

export const dynamic = "force-dynamic";

export default async function EventPeoplePage({ params }: PageProps<"/events/[eventId]/people">) {
  const { eventId } = await params;
  const event = await requireEvent(eventId);
  return (
    <PeopleScreen
      eventId={event.id}
      eventName={event.name}
      celebrantPersonId={event.celebrantPersonId}
    />
  );
}
