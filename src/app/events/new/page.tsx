import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { loadFamilyBirthdays, londonToday } from "@/utils/supabase/birthdays-server";
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

  const { people } = await loadFamilyBirthdays();
  const creatable: CreatablePerson[] = people.map((person) => ({
    personId: person.personId,
    name: person.name,
    birthday: person.birthday ? { month: person.birthday.month, day: person.birthday.day } : null,
  }));

  return (
    <Suspense fallback={null}>
      {/* The family's today, resolved on the server, so the form can tell a
          celebration being planned from a date of birth typed by mistake. */}
      <CreateEventForm people={creatable} today={londonToday()} />
    </Suspense>
  );
}
