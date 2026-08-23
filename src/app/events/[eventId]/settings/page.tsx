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
    db.from("christmas_recipients").select("id,person_id,active").eq("christmas_event_id", event.id),
    db.from("contributors").select("person_id,active").eq("christmas_event_id", event.id),
  ]);

  // Is there anything here worth keeping?
  //
  // This decides whether the DELETE CONTROL IS SHOWN, and nothing more. The
  // authority is `delete_event_if_empty`, which repeats every one of these
  // checks inside the same statement as the delete -- so a row written between
  // this read and that click cannot be lost, and a hand-made request cannot
  // skip the question.
  const recipientIds = (recipientResult.data ?? []).map((row) => row.id as string);
  const [purchaseCount, ideaCount, settlementCount] = await Promise.all([
    recipientIds.length
      ? db.from("purchases").select("id", { count: "exact", head: true }).in("christmas_recipient_id", recipientIds)
      : Promise.resolve({ count: 0 }),
    recipientIds.length
      ? db.from("gift_ideas").select("id", { count: "exact", head: true }).in("christmas_recipient_id", recipientIds)
      : Promise.resolve({ count: 0 }),
    db.from("settlements").select("id", { count: "exact", head: true }).eq("christmas_event_id", event.id),
  ]);
  const isEmpty = (purchaseCount.count ?? 0) === 0
    && (ideaCount.count ?? 0) === 0
    && (settlementCount.count ?? 0) === 0;

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
      isEmpty={isEmpty}
    />
  );
}
