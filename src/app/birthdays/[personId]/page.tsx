import { notFound, redirect } from "next/navigation";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath } from "@/lib/events.ts";
import { loadBirthdayWorkspace } from "@/utils/supabase/birthdays-server";
import { OwnBirthdayScreen } from "./own-birthday-screen";
import { StartPlanningScreen } from "./start-planning-screen";

export const dynamic = "force-dynamic";

/**
 * One person's birthday — a RESOLVER, not a screen.
 *
 * WHY THIS ROUTE STILL EXISTS
 *   A birthday belongs to a person all year round, so the person is the stable
 *   thing to link to. `/birthdays/<personId>` keeps working every year with
 *   nothing renamed or recreated, and every card in the app points at it.
 *
 * WHAT IT DOES
 *   Works out which birthday is coming, looks for that year's planning, and
 *   then gets out of the way:
 *
 *     planning exists      -> redirect to its Event Home
 *     planning does not    -> the focused setup screen, for the Global Admin
 *
 *   There used to be a financial landing page in between, with its own budget,
 *   spend and links to Ideas, Add, Owed and Payments. It was a second copy of
 *   Event Home reached one tap earlier, and it is gone: the money lives in one
 *   place.
 *
 * REDIRECTS AND `notFound` ARE THROWN CONTROL FLOW
 *   Both are called at the top level of this function, never inside a try/catch,
 *   because catching them would turn a redirect into a crash. The loader returns
 *   `null` for "no such person" and for "not an active member" without saying
 *   which, so an unknown id and an unauthorised reader look identical.
 */
export default async function BirthdayPage({ params }: PageProps<"/birthdays/[personId]">) {
  const { personId } = await params;
  const workspace = await loadBirthdayWorkspace(personId);
  if (!workspace) notFound();

  /**
   * YOUR OWN BIRTHDAY IS THE ONE YOU CANNOT OPEN.
   *
   * Checked before anything else, and deliberately not as a redirect: sending
   * the celebrant to their own Event Home is precisely the disclosure the rule
   * exists to prevent, and a 404 would read as a broken app to the one person
   * certain to try it. They get a screen that says so, with their own date and
   * age on it -- which were never the secret.
   *
   * The lock itself is migration 031's row level security. `isSelf` is how this
   * page knows to explain rather than to show an empty workspace.
   */
  if (workspace.isSelf) {
    return (
      <OwnBirthdayScreen
        personName={workspace.person.name}
        birthday={workspace.person.birthday}
        year={workspace.currentYear}
        today={workspace.today}
      />
    );
  }

  // The occurrence for the birthday that is COMING. A past year's planning is
  // history and must never stand in for it.
  if (workspace.current) {
    const destination = eventPath(workspace.current.eventId);
    if (destination) redirect(destination);
  }

  return (
    <StartPlanningScreen
      personId={workspace.person.personId}
      personName={workspace.person.name}
      birthday={workspace.person.birthday}
      year={workspace.currentYear}
      occurrenceDate={workspace.nextOccurrenceDate}
      contributors={workspace.eligibleContributors}
      isAdmin={workspace.isAdmin}
    />
  );
}
