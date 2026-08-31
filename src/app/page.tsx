// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { upcomingBirthdays, type UpcomingBirthday } from "@/lib/birthdays.ts";
import { loadFamilyBirthdays, londonToday, type BirthdayPlanning } from "@/utils/supabase/birthdays-server";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { areaEntryFor, areaLabel, type Area } from "@/lib/areas.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { HOME_PATH, destinationFor } from "@/lib/account-status.ts";
import { redirect } from "next/navigation";
import { loadAccountStatus } from "@/utils/supabase/account-status-server";
import { loadAreaContext, rememberedAreaId } from "@/utils/supabase/areas-server";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { listEvents } from "@/utils/supabase/events-server";
import { AreaChooser } from "./area-chooser";
import { FamilyInvitations } from "./invitations/family-invitations";
import { CreateAreaForm } from "./areas/new/create-area-form";
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

  // Signed out: render the empty dashboard rather than leaking anything. The
  // client provider performs the sign-in redirect, as it has since the proxy
  // was removed.
  if (!user) {
    return <EventsDashboard events={[]} birthdays={[]} today={londonToday()} isAdmin={false} areaName="Your family" />;
  }

  /*
   * THE GLOBAL GATE, BEFORE ANY FAMILY IS RESOLVED.
   *
   * Only an approved account gets past here. The other three signed-in states
   * go to the screen that explains itself -- `/check-email`,
   * `/account-pending`, `/account-rejected` -- and they are the only redirects
   * this route performs.
   *
   * A REDIRECT ON "/" IS NORMALLY THE THING TO AVOID: it is the PWA's
   * `start_url`, so a hop here is a hop on every cold start, and historically
   * it is how the front door kept ending up inside Christmas. It is right this
   * once because it happens to nobody who can use the app: an approved account
   * never takes this branch, and an unapproved one has no dashboard to be shown
   * instead. `FamilyProvider` reaches the same conclusion from the same
   * routine, so a client navigation here lands in the same place.
   */
  const status = await loadAccountStatus();
  const destination = destinationFor(status.state, HOME_PATH);
  if (destination && destination !== HOME_PATH) redirect(destination);

  /*
   * AND THEN THE THREE SHAPES THE FRONT DOOR CAN TAKE, decided by
   * `areaEntryFor` -- a pure function, so the rule is testable rather than
   * inferred from this file.
   *
   * RENDERED, NOT REDIRECTED TO, all three. See above: "/" resolves to itself.
   */
  const { areas, active } = await loadAreaContext();
  const entry = areaEntryFor(areas, await rememberedAreaId());

  /*
   * NO FAMILY AT ALL. Not an error and not an empty dashboard: somebody
   * approved five minutes ago has nothing to see and no way to guess what to do
   * next, so the root renders the one action that starts everything. This is
   * also where a member who has just lost their last family lands, which is
   * correct -- losing a family is not losing an account.
   */
  /*
   * BUT FIRST: HAS SOMEBODY ALREADY ASKED THEM TO JOIN ONE?
   *
   * The zero-family branch used to offer exactly one way forward -- start a
   * family of your own -- which is the wrong first suggestion for the commonest
   * newcomer there is: somebody a family invited, who has just confirmed their
   * address. `list_my_family_invitations()` is the only thing that can tell
   * them apart, and it needs no Area, so it is safe to ask here.
   *
   * `compact` renders NOTHING when there is nothing waiting, so the person with
   * no invitation sees exactly the screen they saw before.
   */
  if (entry === "onboarding") {
    return (
      <div>
        <div className="mx-auto w-full max-w-2xl px-5 pt-8 sm:px-6">
          <FamilyInvitations compact reloadOnAccept />
        </div>
        <CreateAreaForm first />
      </div>
    );
  }

  /*
   * FAMILIES, BUT NO VALID CHOICE AMONG THEM. Ask, rather than pick one
   * silently. `member` is deliberately not consulted for this branch:
   * `getCurrentMember` refuses to guess between several memberships and
   * therefore answers nothing in exactly the case the chooser exists for.
   */
  if (entry === "chooser") return <ChooserWithInvitations areas={areas} />;

  /*
   * A REMEMBERED FAMILY THIS ACCOUNT IS IN, AND STILL NO MEMBERSHIP RESOLVED.
   * `is_area_member` requires an ACTIVE membership and `areas` sits behind it,
   * so this should be unreachable -- which is exactly why it is worth refusing
   * to guess about rather than rendering an empty dashboard that says nothing.
   */
  if (!member) return <ChooserWithInvitations areas={areas} />;

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
      areaName={areaLabel(active)}
      error={error}
    />
  );
}

/**
 * THE CHOOSER, WITH ANYTHING STILL BEING OFFERED ABOVE IT.
 *
 * An account can be in one family and invited to another at the same time, and
 * the chooser is exactly where that person looks. Rendering the invitation here
 * means the choice is between the families they are in AND the ones asking --
 * rather than the invitation being visible only on a screen they have no reason
 * to visit.
 *
 * `compact` renders nothing when nothing is pending, so the ordinary chooser is
 * untouched for everybody else. Accepting reloads: which of the three shapes
 * the front door takes is decided on the server from `areas`, and that list has
 * just changed.
 */
function ChooserWithInvitations({ areas }: { areas: Area[] }) {
  return (
    <div>
      <div className="mx-auto w-full max-w-2xl px-5 pt-8 sm:px-6">
        <FamilyInvitations compact reloadOnAccept />
      </div>
      <AreaChooser areas={areas} />
    </div>
  );
}
