import "server-only";

import { notFound, redirect } from "next/navigation";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { isEventStatus, isEventType, type EventSummary } from "@/lib/events.ts";
import { validateUuid } from "@/lib/input-validation";
import { rememberedAreaId } from "./areas-server";
import { getCurrentMember } from "./current-member";
import { createClient } from "./server";

/**
 * Event identity, resolved on the server.
 *
 * WHY THIS IS SERVER-SIDE
 *   The event id arrives from the URL, which is entirely under the visitor's
 *   control. Every `/events/[eventId]/...` route therefore resolves it here
 *   before rendering anything, so a hand-typed id is answered by the database
 *   rather than by a React component that assumed it was real.
 *
 *   This is a convenience and a correctness boundary, NOT the security
 *   boundary. Row Level Security is: `events` is readable only by an active
 *   family member (migration 025), so an unauthorized reader gets zero rows
 *   from these queries and this module turns that into a plain 404 without
 *   saying whether the event exists. Every financial table keeps its own
 *   policies and its own SECURITY DEFINER write paths, unchanged.
 */

export type EventRecord = EventSummary & {
  /** Live purchases only, in integer pennies. */
  spentPennies: number;
  /** The sum of every active recipient's budget for this event. */
  budgetPennies: number;
  /**
   * HOW MANY PEOPLE THIS EVENT IS FOR, counting ACTIVE recipients only.
   *
   * The same population the two figures above are summed over, so a card
   * cannot say "3 people" beside a budget computed from two. An archived
   * recipient is not someone the family is still planning for.
   */
  activeRecipientCount: number;
};

const EVENT_COLUMNS = "id,name,event_type,event_date,status,year,celebrant_person_id,description";

type EventRow = {
  id: string;
  name: string;
  event_type: string;
  event_date: string;
  status: string;
  year: number | null;
  celebrant_person_id: string | null;
  description: string | null;
};

function toSummary(row: EventRow): EventSummary {
  return {
    id: row.id,
    name: row.name,
    // A type or status this build has not heard of is passed through rather
    // than coerced: `eventTypeMeta` already falls back to a generic icon, and
    // silently relabelling a row would be worse than showing it plainly.
    type: isEventType(row.event_type) ? row.event_type : row.event_type,
    eventDate: typeof row.event_date === "string" ? row.event_date.slice(0, 10) : String(row.event_date),
    status: isEventStatus(row.status) ? row.status : row.status,
    year: row.year,
    celebrantPersonId: row.celebrant_person_id,
    description: row.description,
  };
}

/**
 * Every event this member may open, with the two figures a dashboard card
 * shows.
 *
 * THE CARD MUST AGREE WITH THE SCREEN IT OPENS.
 *
 * Both figures are read from the same rows, under the same rule, as Event Home
 * -- which computes them in `useTotals` (src/app/family-context.tsx):
 *
 *     budget = sum of budget_pennies over ACTIVE recipients of the event
 *     spend  = sum of actual_price_pennies over LIVE purchases
 *              (deleted_at is null) belonging to those same ACTIVE recipients
 *
 * The "active recipients" half of the spend rule is easy to lose and matters:
 * archiving a person who already has purchases would otherwise leave the
 * dashboard reporting more than the event itself does. There is no second
 * definition of spend anywhere and no new financial concept here -- this is a
 * grouped read of `purchases`, in integer pennies, and nothing else.
 *
 * `scripts/event-dashboard-consistency.test.mjs` holds the two paths to exactly
 * this rule over generated data, so they cannot drift apart silently.
 */
export async function listEvents(): Promise<EventRecord[]> {
  const db = await createClient();

  /**
   * THE FAMILY ON SCREEN, AND ONLY THAT ONE.
   *
   * Row level security hands back every Area the reader belongs to, which is
   * right as a permission and wrong as a dashboard: a login in two families
   * would see both families' Christmases and birthdays in one list, with no way
   * to tell which was which. The recipients below need no filter of their own --
   * they are matched against these events by id, so anything from another
   * family has nothing to attach to.
   */
  const { member } = await getCurrentMember();
  const areaId = (member?.area_id as string | null) ?? null;
  if (!areaId) return [];

  const [eventResult, recipientResult] = await Promise.all([
    db.from("events").select(EVENT_COLUMNS).eq("area_id", areaId),
    db.from("christmas_recipients").select("id,christmas_event_id,budget_pennies,active"),
  ]);
  if (eventResult.error) throw new Error("The events list could not be loaded.");
  if (recipientResult.error) throw new Error("Event budgets could not be loaded.");

  // Archived recipients count towards neither figure, exactly as on Event Home.
  const recipients = (recipientResult.data ?? []).filter((row) => row.active);
  const eventByRecipient = new Map(recipients.map((row) => [row.id, row.christmas_event_id]));

  const budgetByEvent = new Map<string, number>();
  const recipientCountByEvent = new Map<string, number>();
  for (const row of recipients) {
    budgetByEvent.set(row.christmas_event_id, (budgetByEvent.get(row.christmas_event_id) ?? 0) + row.budget_pennies);
    recipientCountByEvent.set(row.christmas_event_id, (recipientCountByEvent.get(row.christmas_event_id) ?? 0) + 1);
  }

  const spentByEvent = new Map<string, number>();
  if (recipients.length) {
    const purchaseResult = await db
      .from("purchases")
      .select("christmas_recipient_id,actual_price_pennies")
      .in("christmas_recipient_id", recipients.map((row) => row.id))
      .is("deleted_at", null);
    if (purchaseResult.error) throw new Error("Event spending could not be loaded.");
    for (const purchase of purchaseResult.data ?? []) {
      const eventId = eventByRecipient.get(purchase.christmas_recipient_id);
      if (!eventId) continue;
      spentByEvent.set(eventId, (spentByEvent.get(eventId) ?? 0) + purchase.actual_price_pennies);
    }
  }

  return (eventResult.data ?? []).map((row) => ({
    ...toSummary(row as EventRow),
    spentPennies: spentByEvent.get(row.id) ?? 0,
    budgetPennies: budgetByEvent.get(row.id) ?? 0,
    activeRecipientCount: recipientCountByEvent.get(row.id) ?? 0,
  }));
}

/** One event, or null when the id is malformed, unknown, or not visible. */
export async function getEvent(eventId: string): Promise<EventSummary | null> {
  const validId = validateUuid(eventId);
  if (!validId.ok) return null;

  const db = await createClient();

  /**
   * Opened through the family on screen or not at all -- the same rule the
   * listing follows. A login in two families may legitimately read an event in
   * either, and row level security allows it; what it must not do is open one
   * family's event while every other panel on the page is about the other.
   */
  const { member } = await getCurrentMember();
  const areaId = (member?.area_id as string | null) ?? null;
  if (!areaId) return null;

  const result = await db
    .from("events").select(EVENT_COLUMNS).eq("id", validId.value).eq("area_id", areaId).maybeSingle();
  if (result.error || !result.data) return null;
  return toSummary(result.data as EventRow);
}

/**
 * The gate every event route passes through.
 *
 * Signed out -> the sign-in screen. Signed in but not an active member, or the
 * event does not exist, or RLS hides it -> a plain 404. The three are
 * deliberately indistinguishable to the caller: telling somebody "that event
 * exists but is not yours" is itself a disclosure.
 */
export async function requireEvent(eventId: string): Promise<EventSummary> {
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) redirect("/login");

  // `maybeSingle()` would ERROR for a login that belongs to two families, which
  // turns a legitimate member into a 404 on every event route.
  const { member } = await getCurrentMember();
  if (!member) notFound();

  const event = await getEvent(eventId);
  if (!event) notFound();
  return event;
}

/**
 * COMPATIBILITY ONLY -- the one place allowed to look an event up by year.
 *
 * Production URLs, saved bookmarks and every notification link written before
 * Checkpoint 2 point at `/owed`, `/people` and friends, with no event in them.
 * Those routes redirect through here so they keep working. It reads the
 * compatibility view from migration 025, which exposes Christmas-type events
 * only, so it can never resolve to a birthday.
 *
 * Nothing else in the application may resolve an event this way. Event pages
 * take their event from the URL; this exists purely so that old links do not
 * break during the transition, and it should be deleted once they have aged
 * out.
 */
export const LEGACY_CHRISTMAS_YEAR = 2026;

export async function legacyChristmasEventId(): Promise<string | null> {
  /*
   * SCOPED TO THE FAMILY ON SCREEN, and not merely to the reader.
   *
   * FOUND IN LIVE BROWSER QA. This asked only for `year = 2026`. Row level
   * security narrows that to the Areas the reader belongs to -- which is the
   * right permission and the wrong question. Somebody in two families, standing
   * in the second one, opening a stale `/people/<id>` link, was redirected into
   * the FIRST family's Christmas: a URL in an Area they had not selected,
   * reached from an Area they had. No data crossed -- the destination is still
   * authorised by its own Area -- but the app must never steer a reader out of
   * the family they are looking at.
   *
   * It was also a `maybeSingle()` on a query that can match more than once. The
   * moment a second family has a Christmas 2026 that ERRORS rather than
   * choosing, and the redirect silently degrades to the dashboard. Both faults
   * have the same cause and the same fix: ask about one Area.
   *
   * With no Area selected, or no Christmas in it, the caller falls back to the
   * dashboard -- "choose an event" rather than "here is somebody else's".
   *
   * IT READS `events`, NOT `christmas_events`. The compatibility view exposes
   * only `id, year, name, created_at` -- it predates Areas and has no
   * `area_id` -- so filtering it by Area is not merely wrong, it is a 42703
   * that turns every legacy redirect into the dashboard for everybody. The
   * first version of this fix did exactly that and the source-text tests could
   * not see it, which is why `scripts/migration-execution.test.mjs` now runs
   * this query shape against a real schema.
   */
  const areaId = await rememberedAreaId();
  if (!areaId) return null;

  const db = await createClient();
  const result = await db
    .from("events")
    .select("id")
    .eq("event_type", "christmas")
    .eq("year", LEGACY_CHRISTMAS_YEAR)
    .eq("area_id", areaId)
    .limit(1)
    .maybeSingle();
  if (result.error || !result.data) return null;
  return result.data.id as string;
}

/**
 * Send a legacy path to its Christmas 2026 equivalent.
 *
 * Falls back to the Events dashboard rather than a dead end if that event is
 * ever absent, so an old bookmark degrades to "choose an event" instead of an
 * error page.
 */
export async function redirectLegacyRoute(section: string, search = ""): Promise<never> {
  const eventId = await legacyChristmasEventId();
  if (!eventId) redirect("/");
  const suffix = section ? `/${section}` : "";
  redirect(`/events/${eventId}${suffix}${search}`);
}
