import { requireEvent } from "@/utils/supabase/events-server";
import { MoreScreen } from "../../../more/more-screen";

export const dynamic = "force-dynamic";

export default async function EventMorePage({ params }: PageProps<"/events/[eventId]/more">) {
  const { eventId } = await params;
  const event = await requireEvent(eventId);
  return <MoreScreen eventId={event.id} eventName={event.name} />;
}
