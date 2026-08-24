import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { loadFamilyBirthdays, londonToday } from "@/utils/supabase/birthdays-server";
import { listEvents } from "@/utils/supabase/events-server";
import { CreateEventForm, type CreatablePerson } from "./create-event-form";

export const dynamic = "force-dynamic";

/**
 * Create Event.
 *
 * Global Admin only, checked here so the page never renders for anybody else —
 * and checked again by `create_event` in the database, which is the boundary
 * that actually matters. `events` has no write policy and no write grant for
 * any browser session, so even a hand-made request cannot insert one.
 */
export default async function CreateEventPage() {
  const { user, member } = await getCurrentMember();
  if (!user) redirect("/login");
  if (!member || member.role !== "admin") redirect("/");

  const [{ people }, existing] = await Promise.all([
    loadFamilyBirthdays(),
    listEvents().catch(() => []),
  ]);

  const takenYears: Record<string, number[]> = {};
  for (const event of existing) {
    if (event.status !== "active") continue;
    const year = Number(String(event.eventDate).slice(0, 4));
    if (!Number.isInteger(year)) continue;
    const type = String(event.type);
    takenYears[type] = [...(takenYears[type] ?? []), year];
  }
  const creatable: CreatablePerson[] = people.map((person) => ({
    personId: person.personId,
    name: person.name,
    birthday: person.birthday ? { month: person.birthday.month, day: person.birthday.day } : null,
    // Everyone can RECEIVE a gift. Only the family's contributor pool is
    // offered when choosing who shares the cost.
    isFamilyContributor: person.isFamilyContributor,
  }));

  return (
    <Suspense fallback={null}>
      {/* The family's today, resolved on the server, so the form can tell a
          celebration being planned from a date of birth typed by mistake.

          `takenYears` is which years each recurring occasion already has, so
          the wizard proposes the next AVAILABLE one instead of a duplicate the
          database would refuse. */}
      <CreateEventForm people={creatable} today={londonToday()} takenYears={takenYears} />
    </Suspense>
  );
}
