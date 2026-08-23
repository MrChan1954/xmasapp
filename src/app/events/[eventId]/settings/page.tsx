import { getCurrentMember } from "@/utils/supabase/current-member";
import { requireEvent } from "@/utils/supabase/events-server";
import { createClient } from "@/utils/supabase/server";
import { EventSettingsScreen, type SettingsPerson } from "./settings-screen";

export const dynamic = "force-dynamic";

/**
 * Event Settings for one named event.
 *
 * `requireEvent` resolves and authorizes the event from the URL exactly as
 * every other event route does. The admin check below decides what the page
 * renders; the database decides what it can actually do.
 */
export default async function EventSettingsPage({ params }: PageProps<"/events/[eventId]/settings">) {
  const { eventId } = await params;
  const event = await requireEvent(eventId);
  const [{ member }, db] = await Promise.all([getCurrentMember(), createClient()]);

  const [peopleResult, recipientResult, contributorResult] = await Promise.all([
    db.from("people").select("id,name").order("name"),
    db.from("christmas_recipients").select("person_id,active").eq("christmas_event_id", event.id),
    db.from("contributors").select("person_id,active").eq("christmas_event_id", event.id),
  ]);

  const people: SettingsPerson[] = (peopleResult.data ?? []).map((row) => ({
    personId: row.id as string,
    name: row.name as string,
  }));

  return (
    <EventSettingsScreen
      event={{
        id: event.id,
        name: event.name,
        type: String(event.type),
        eventDate: event.eventDate,
        description: event.description,
        status: String(event.status),
        celebrantPersonId: event.celebrantPersonId,
      }}
      people={people}
      recipientPersonIds={(recipientResult.data ?? []).filter((row) => row.active).map((row) => row.person_id as string)}
      contributorPersonIds={(contributorResult.data ?? []).filter((row) => row.active).map((row) => row.person_id as string)}
      isAdmin={member?.role === "admin"}
    />
  );
}
