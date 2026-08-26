import { redirect } from "next/navigation";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { loadPeopleDirectory } from "@/utils/supabase/people-server";
import { AddPersonForm } from "./add-person-form";

export const dynamic = "force-dynamic";

/**
 * Adding somebody to the family directory.
 *
 * Gated on the server before anything renders, and gated AGAIN in the database:
 * `create_person` checks Global Admin itself, so a hand-made request meets the
 * same answer as somebody who never sees this page.
 */
export default async function AddPersonPage() {
  const { user, member } = await getCurrentMember();
  if (!user || !member) redirect("/login");
  if (member.role !== "admin") redirect("/people");

  /*
   * THE NAMES ALREADY IN THIS FAMILY, so the form can WARN about a duplicate
   * without refusing one. Two people really can share a name -- a family with
   * two Jameses is not a data-entry error -- so the honest answer is to say so
   * and let whoever is adding them decide, never to block it.
   *
   * Area-scoped by `loadPeopleDirectory`, so it is this family's names only and
   * no other family's are disclosed by the warning.
   */
  const directory = await loadPeopleDirectory();

  return <AddPersonForm existingNames={directory.people.map((entry) => entry.name)} />;
}
