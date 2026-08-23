import { loadFamilyBirthdays } from "@/utils/supabase/birthdays-server";
import { BirthdaysScreen } from "./birthdays-screen";

export const dynamic = "force-dynamic";

/**
 * The family Birthday Calendar.
 *
 * Family-wide, and deliberately outside any event: a birthday belongs to a
 * person. Reading it is behind the same RLS as every other person field, so a
 * signed-out visitor and a deactivated member both see nothing.
 */
export default async function BirthdaysPage() {
  const { people, birthdayEventsByPersonYear, isAdmin, today } = await loadFamilyBirthdays();
  return (
    <BirthdaysScreen
      people={people}
      birthdayEventsByPersonYear={birthdayEventsByPersonYear}
      isAdmin={isAdmin}
      today={today}
    />
  );
}
