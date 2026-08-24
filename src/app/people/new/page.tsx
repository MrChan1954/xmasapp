import { redirect } from "next/navigation";
import { getCurrentMember } from "@/utils/supabase/current-member";
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

  return <AddPersonForm />;
}
