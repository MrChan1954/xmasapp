import { redirect } from "next/navigation";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { AppShell, PageHeader } from "../../components/app-shell";
import { EmptyState } from "../../components/ui";

export const dynamic = "force-dynamic";

/**
 * The Create Event shell.
 *
 * Deliberately inert for now: Checkpoint 4 builds the form and the
 * independently-authorized SECURITY DEFINER entry point that writes the row.
 * This route exists so the dashboard's admin action has a real destination, and
 * so the authorization check around it is written once, now, rather than
 * bolted on later.
 *
 * Nothing here can create an event. `events` has no INSERT policy and no write
 * grant for any browser session, so even a page that tried would be refused by
 * the database.
 */
export default async function CreateEventPage() {
  const { user, member } = await getCurrentMember();
  if (!user) redirect("/login");
  // Not an admin, or not a member at all: back to the dashboard. The real
  // protection is the database, which grants nobody a write path to `events`.
  if (!member || member.role !== "admin") redirect("/");

  return (
    <AppShell width="narrow">
      <PageHeader
        eyebrow="Global Admin"
        title="Create event"
        description="Set up a birthday, an Easter, a wedding or another occasion for the family to plan together."
      />
      <EmptyState
        className="mt-8"
        illustration="star"
        title="Coming next"
        body="Event creation arrives in the next step, together with choosing who receives and who contributes. Until then, existing events are on the dashboard."
      />
    </AppShell>
  );
}
