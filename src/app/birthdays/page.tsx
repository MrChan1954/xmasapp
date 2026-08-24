import { loadFamilyBirthdays, londonToday, type FamilyBirthdays } from "@/utils/supabase/birthdays-server";
import { BirthdaysScreen } from "./birthdays-screen";

export const dynamic = "force-dynamic";

/**
 * The family Birthday Calendar.
 *
 * Family-wide, and deliberately outside any event: a birthday belongs to a
 * person. Reading it is behind the same RLS as every other person field, so a
 * signed-out visitor and a deactivated member both see nothing.
 *
 * A FAILED LOAD IS NOT A CRASH.
 *
 * This used to let `loadFamilyBirthdays` throw straight past it, which put the
 * whole page into the app's generic "Something went wrong" boundary — the same
 * screen the reader sees for a genuine bug, with no clue that the cause was a
 * dropped connection and no way to tell it apart from anything else. Now the
 * screen renders and says what happened.
 *
 * Only the LOAD is inside the try. Constructing the JSX there would be
 * pointless — React renders it afterwards, so a render error would sail past
 * the catch — and misleading to anybody reading it later.
 */
export default async function BirthdaysPage() {
  let data: FamilyBirthdays | null = null;
  try {
    data = await loadFamilyBirthdays();
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <BirthdaysScreen
        people={[]}
        birthdayEventsByPersonYear={{}}
        canEditBirthdays={false}
        today={londonToday()}
        // Deliberately not the thrown message: a server-side failure can carry
        // connection details, and this page is family-readable.
        loadError="The family's birthdays could not be loaded. Check your connection and try again."
      />
    );
  }

  return (
    <BirthdaysScreen
      people={data.people}
      birthdayEventsByPersonYear={data.birthdayEventsByPersonYear}
      canEditBirthdays={data.canEditBirthdays}
      today={data.today}
    />
  );
}
