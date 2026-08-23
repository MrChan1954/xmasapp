import { getCurrentMember } from "@/utils/supabase/current-member";
import { listEvents } from "@/utils/supabase/events-server";
import { EventsDashboard, type DashboardEvent } from "./events-dashboard";

export const dynamic = "force-dynamic";

/**
 * The root of the app is the Events dashboard.
 *
 * `/events` redirects here rather than the other way round, so the PWA's
 * `start_url` of "/" opens the dashboard directly with no redirect hop on every
 * cold start, and there is exactly one implementation of the screen.
 *
 * Opening the app no longer means opening Christmas: the reader chooses an
 * event, and that choice becomes part of the URL.
 */
export default async function EventsPage() {
  const { user, member } = await getCurrentMember();

  // Signed out, or no active membership: render the empty dashboard rather than
  // leaking anything. The client provider performs the sign-in redirect, as it
  // has since the proxy was removed.
  if (!user || !member) {
    return <EventsDashboard events={[]} today={londonToday()} isAdmin={false} />;
  }

  let events: DashboardEvent[] = [];
  let error: string | null = null;
  try {
    events = await listEvents();
  } catch {
    error = "Your events could not be loaded. Check your connection and try again.";
  }

  return (
    <EventsDashboard
      events={events}
      today={londonToday()}
      isAdmin={member.role === "admin"}
      error={error}
    />
  );
}

/**
 * "Upcoming" has to mean the same thing on the server and in the browser, so
 * the boundary is computed once, here, in the family's own timezone.
 */
function londonToday() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
