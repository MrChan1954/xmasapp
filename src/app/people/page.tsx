import { redirectLegacyRoute } from "@/utils/supabase/events-server";
import { loadPeopleDirectory } from "@/utils/supabase/people-server";
import { PeopleDirectoryScreen } from "./people-directory-screen";

export const dynamic = "force-dynamic";

/**
 * The family directory.
 *
 * TWO JOBS, DECIDED BY THE QUERY STRING, and that is deliberate rather than
 * tidy. `/people?person=<id>` is what every notification link written before
 * Checkpoint 2 says, and the id in it is a CHRISTMAS RECIPIENT id, not a person
 * id -- so those links still forward to the Christmas 2026 People screen
 * exactly as they did. `/people` on its own is now the directory: the durable
 * list of the family, independent of any event.
 *
 * Breaking a saved link to make a route look cleaner is not a trade worth
 * making, and the two cases cannot be confused: one has the parameter and the
 * other does not.
 */
export default async function PeoplePage({ searchParams }: PageProps<"/people">) {
  const params = await searchParams;
  const person = typeof params.person === "string" ? params.person : null;
  if (person) return redirectLegacyRoute("people", `?person=${encodeURIComponent(person)}`);

  const directory = await loadPeopleDirectory();
  return (
    <PeopleDirectoryScreen
      people={directory.people}
      today={directory.today}
      isAdmin={directory.isAdmin}
      canEditBirthdays={directory.canEditBirthdays}
      accounts={directory.accounts}
    />
  );
}
