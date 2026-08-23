import { notFound } from "next/navigation";
import { loadBirthdayWorkspace } from "@/utils/supabase/birthdays-server";
import { BirthdayWorkspaceScreen } from "./workspace-screen";

export const dynamic = "force-dynamic";

/**
 * One person's birthday.
 *
 * The route is the PERSON, not an event: `/birthdays/<personId>`. A birthday
 * belongs to somebody permanently, and the year being planned is derived from
 * today, so this URL keeps working every year with nothing renamed or
 * recreated.
 *
 * A person id that does not exist, or a visitor who is not an active family
 * member, both get a plain 404. The loader returns null for each without saying
 * which, and every read inside it is behind the same RLS as the rest of the app.
 */
export default async function BirthdayWorkspacePage({ params }: PageProps<"/birthdays/[personId]">) {
  const { personId } = await params;
  const workspace = await loadBirthdayWorkspace(personId);
  if (!workspace) notFound();
  return <BirthdayWorkspaceScreen workspace={workspace} />;
}
