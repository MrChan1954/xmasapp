// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { upcomingBirthdays, type UpcomingBirthday } from "@/lib/birthdays.ts";
import { loadFamilyBirthdays, londonToday, type BirthdayPlanning } from "@/utils/supabase/birthdays-server";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { listEvents } from "@/utils/supabase/events-server";
import { EventsDashboard, type DashboardEvent } from "./events-dashboard";

export const dynamic = "force-dynamic";

/**
 * The root of the app.
 *
 * `/events` redirects here rather than the other way round, so the PWA's
 * `start_url` of "/" opens the dashboard directly with no redirect hop on every
 * cold start, and there is exactly one implementation of the screen.
 *
 * Two independent reads, deliberately:
 *
 *   `listEvents()`          the occasions the family plans and pays for.
 *   `loadFamilyBirthdays()` the permanent dates on people.
 *
 * The birthdays are NOT derived from events. That is what lets a birthday
 * appear on the front page with the days to go before anybody has created
 * anything for it, and it is why the one-month push reminder was retired: the
 * warning is already here, every time the app is opened.
 */
export default async function EventsPage() {
  const { user, member } = await getCurrentMember();

  // Signed out, or no active membership: render the empty dashboard rather than
  // leaking anything. The client provider performs the sign-in redirect, as it
  // has since the proxy was removed.
  if (!user || !member) {
    return <EventsDashboard events={[]} birthdays={[]} today={londonToday()} isAdmin={false} />;
  }

  const today = londonToday();
  let events: DashboardEvent[] = [];
  let birthdays: UpcomingBirthday[] = [];
  // The money on each birthday card. `loadFamilyBirthdays` has already
  // aggregated it from the same rows Event Home reads, so this page carries
  // that record through untouched. It must never recompute a figure here, or a
  // card and the screen it opens could disagree. Omitting it is not a neutral
  // default: the prop falls back to {} and every card silently reads
  // "Planning not started yet", however much has actually been planned.
  let planningByPerson: Record<string, BirthdayPlanning> = {};
  // Which of these birthdays is the reader's own. Row level security has
  // already removed their own planning from everything above; this is only so
  // the card can say "it's a surprise" rather than "not started yet".
  let viewerPersonId: string | null = null;
  let error: string | null = null;

  // A birthday list that fails to load must not take the events with it, and
  // the other way round: each half of the page is worth having on its own.
  const [eventResult, birthdayResult] = await Promise.allSettled([
    listEvents(),
    loadFamilyBirthdays(),
  ]);

  if (eventResult.status === "fulfilled") events = eventResult.value;
  else error = "Your events could not be loaded. Check your connection and try again.";

  if (birthdayResult.status === "fulfilled") {
    birthdays = upcomingBirthdays(birthdayResult.value.people, today);
    planningByPerson = birthdayResult.value.planningByPerson;
    viewerPersonId = birthdayResult.value.viewerPersonId;
  } else if (!error) {
    error = "The family's birthdays could not be loaded. Check your connection and try again.";
  }

  return (
    <EventsDashboard
      events={events}
      birthdays={birthdays}
      planningByPerson={planningByPerson}
      viewerPersonId={viewerPersonId}
      today={today}
      isAdmin={member.role === "admin"}
      error={error}
    />
  );
}
