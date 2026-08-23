import { requireEvent } from "@/utils/supabase/events-server";
import { OwedScreen } from "../../../owed/owed-screen";

export const dynamic = "force-dynamic";

export default async function EventOwedPage({ params }: PageProps<"/events/[eventId]/owed">) {
  const { eventId } = await params;
  const event = await requireEvent(eventId);
  return <OwedScreen eventId={event.id} eventName={event.name} />;
}
