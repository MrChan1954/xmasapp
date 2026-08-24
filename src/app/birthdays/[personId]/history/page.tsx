import { notFound } from "next/navigation";
import { loadBirthdayWorkspace } from "@/utils/supabase/birthdays-server";
import { BirthdayHistoryScreen } from "./history-screen";

export const dynamic = "force-dynamic";

/**
 * What the family got somebody in previous years.
 *
 * WHY IT LIVES HERE AND NOT ON THE EVENT
 *   History belongs to the PERSON, not to any one year's occurrence. Asking
 *   "what did we get Taylor last year" from inside Taylor's 2027 planning is
 *   asking about a different event, and hanging it off the person keeps one
 *   answer instead of one per year.
 *
 *   It is reached from the birthday's own More screen, which is where somebody
 *   planning this year would look for it.
 *
 * PREVIOUS YEARS ARE PREVIOUS YEARS
 *   Nothing here feeds the current year's budget, spend or Owed. It is a
 *   read-only record, and the loader keeps the two apart: `current` is this
 *   year's planning and `previous` is everything before it that actually
 *   happened.
 */
export default async function BirthdayHistoryPage({ params }: PageProps<"/birthdays/[personId]/history">) {
  const { personId } = await params;
  const workspace = await loadBirthdayWorkspace(personId);
  if (!workspace) notFound();

  return (
    <BirthdayHistoryScreen
      personName={workspace.person.name}
      previous={workspace.previous}
      unused={workspace.unused}
      isAdmin={workspace.isAdmin}
    />
  );
}
