// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { upcomingBirthdays, type UpcomingBirthday } from "@/lib/birthdays.ts";
import { loadFamilyBirthdays, londonToday } from "@/utils/supabase/birthdays-server";
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
  } else if (!error) {
    error = "The family's birthdays could not be loaded. Check your connection and try again.";
  }

  return (
    <EventsDashboard
      events={events}
      birthdays={birthdays}
      today={today}
      isAdmin={member.role === "admin"}
      error={error}
    />
  );
}
