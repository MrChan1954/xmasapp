// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { hasFixedSingleRecipient } from "@/lib/events.ts";
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
      // Only a birthday is structurally single-recipient. A wedding or an
      // anniversary may also name somebody, and must still be able to add a
      // second person.
      fixedRecipientPersonId={hasFixedSingleRecipient(event) ? event.celebrantPersonId : null}
    />
  );
}
