import "server-only";

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { nextBirthdayOccurrence, type Birthday, type PersonBirthday } from "@/lib/birthdays.ts";
import { createClient } from "./server";

/**
 * The family's birthdays, read on the server.
 *
 * Birthdays live on `people`, which every active member may read and nobody may
 * write from a browser, so this is an ordinary RLS-scoped select: a signed-out
 * visitor gets nothing, and a member gets the same list the calendar shows.
 */

export type FamilyBirthdays = {
  people: PersonBirthday[];
  /** Active Birthday Events, keyed by `<personId>:<year>` for the calendar. */
  birthdayEventsByPersonYear: Record<string, { id: string; name: string }>;
  isAdmin: boolean;
  /** Today, in the family's own timezone. Never derived from a UTC instant. */
  today: string;
};

export async function loadFamilyBirthdays(): Promise<FamilyBirthdays> {
  const db = await createClient();
  const today = londonToday();

  const { data: auth } = await db.auth.getUser();
  if (!auth.user) {
    return { people: [], birthdayEventsByPersonYear: {}, isAdmin: false, today };
  }

  const [membership, peopleResult, eventResult] = await Promise.all([
    db.from("app_members").select("role").eq("user_id", auth.user.id).eq("active", true).maybeSingle(),
    db.from("people").select("id,name,birthday_month,birthday_day,birthday_year").order("name"),
    // Only birthdays, only active ones: an archived event must not present
    // itself as "this year is already set up".
    db.from("events")
      .select("id,name,event_date,celebrant_person_id")
      .eq("event_type", "birthday")
      .eq("status", "active"),
  ]);

  if (!membership.data) {
    return { people: [], birthdayEventsByPersonYear: {}, isAdmin: false, today };
  }
  if (peopleResult.error) throw new Error("The family's birthdays could not be loaded.");

  const people: PersonBirthday[] = (peopleResult.data ?? []).map((row) => ({
    personId: row.id as string,
    name: row.name as string,
    birthday: row.birthday_month === null || row.birthday_day === null
      ? null
      : {
        month: Number(row.birthday_month),
        day: Number(row.birthday_day),
        year: row.birthday_year === null ? null : Number(row.birthday_year),
      } satisfies Birthday,
  }));

  const birthdayEventsByPersonYear: Record<string, { id: string; name: string }> = {};
  for (const row of eventResult.data ?? []) {
    if (!row.celebrant_person_id) continue;
    const year = String(row.event_date).slice(0, 4);
    birthdayEventsByPersonYear[`${row.celebrant_person_id}:${year}`] = {
      id: row.id as string,
      name: row.name as string,
    };
  }

  return {
    people,
    birthdayEventsByPersonYear,
    isAdmin: membership.data.role === "admin",
    today,
  };
}

/**
 * Today, as a calendar date in the family's timezone.
 *
 * A birthday is a calendar date, so "today" has to be one too. Taking it from a
 * UTC instant is exactly what puts a reminder on the wrong day at half past
 * midnight in British Summer Time.
 */
export function londonToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// ---------------------------------------------------------------------------
// One person's birthday workspace
// ---------------------------------------------------------------------------

/** One gift that was actually bought, for the history list. */
export type BirthdayGift = {
  id: string;
  description: string;
  pricePennies: number;
  purchaseDate: string;
  buyerName: string | null;
};

/** One year of a person's birthday: the planning, or the history. */
export type BirthdayOccurrence = {
  year: number;
  eventId: string;
  eventName: string;
  eventDate: string;
  status: string;
  budgetPennies: number;
  spentPennies: number;
  gifts: BirthdayGift[];
  /** Ideas nobody bought. Useful next year; not evidence of anything.  */
  openIdeas: Array<{ id: string; title: string; estimatedPricePennies: number | null }>;
};

export type BirthdayWorkspace = {
  person: PersonBirthday;
  /** The occurrence the family is planning for now, if one has been started. */
  current: BirthdayOccurrence | null;
  /** The year `current` is for, whether or not planning has started. */
  currentYear: number;
  /**
   * Earlier years that actually happened.
   *
   * An occurrence with no purchases and no ideas is NOT history — it is an
   * empty row somebody created and never used, and putting it here would
   * present "nothing was bought for Taylor in 2026" as a fact about the family
   * rather than an accident of the software.
   */
  previous: BirthdayOccurrence[];
  /**
   * Rows that are neither this year's planning nor history: created, never
   * used, and left behind.
   *
   * They are listed for the Global Admin ONLY, and only so there is a way to
   * reach them. Without this they would be invisible everywhere — not a
   * dashboard card, not the current year, not history — and the only way to
   * tidy one up would be to know its id.
   */
  unused: BirthdayOccurrence[];
  isAdmin: boolean;
  today: string;
};

/**
 * Everything the person's birthday page shows.
 *
 * The word "event" does not appear on that page. It is still an event row
 * underneath -- with recipients, contributors, purchases, allocations and Owed,
 * exactly like Christmas -- because that is what makes the money work. What
 * changes is the framing: this is Taylor's birthday, and 2026 is one year of
 * it.
 *
 * Every read here is an ordinary RLS-scoped select. Nothing uses a service-role
 * client, so a visitor who is not an active family member gets nothing.
 */
export async function loadBirthdayWorkspace(personId: string): Promise<BirthdayWorkspace | null> {
  const db = await createClient();
  const today = londonToday();
  const currentYearOf = (date: string) => Number(date.slice(0, 4));

  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;

  const [membership, personResult, eventResult] = await Promise.all([
    db.from("app_members").select("role").eq("user_id", auth.user.id).eq("active", true).maybeSingle(),
    db.from("people").select("id,name,birthday_month,birthday_day,birthday_year").eq("id", personId).maybeSingle(),
    db.from("events")
      .select("id,name,event_date,status")
      .eq("event_type", "birthday")
      .eq("celebrant_person_id", personId),
  ]);

  if (!membership.data || personResult.error || !personResult.data) return null;

  const row = personResult.data;
  const person: PersonBirthday = {
    personId: row.id as string,
    name: row.name as string,
    birthday: row.birthday_month === null || row.birthday_day === null
      ? null
      : {
        month: Number(row.birthday_month),
        day: Number(row.birthday_day),
        year: row.birthday_year === null ? null : Number(row.birthday_year),
      } satisfies Birthday,
  };

  const next = person.birthday ? nextBirthdayOccurrence(person.birthday, today) : null;
  const currentYear = next ? next.year : currentYearOf(today);

  const events = (eventResult.data ?? []) as Array<{
    id: string; name: string; event_date: string; status: string;
  }>;

  const isAdmin = membership.data.role === "admin";
  if (events.length === 0) {
    return { person, current: null, currentYear, previous: [], unused: [], isAdmin, today };
  }

  const eventIds = events.map((event) => event.id);
  const recipientResult = await db
    .from("christmas_recipients")
    .select("id,christmas_event_id,budget_pennies,active")
    .in("christmas_event_id", eventIds);
  const recipients = (recipientResult.data ?? []).filter((recipient) => recipient.active);
  const eventByRecipient = new Map(recipients.map((r) => [r.id as string, r.christmas_event_id as string]));

  const recipientIds = recipients.map((recipient) => recipient.id as string);
  const [purchaseResult, ideaResult, contributorResult] = await Promise.all([
    recipientIds.length
      ? db.from("purchases")
        .select("id,christmas_recipient_id,description,actual_price_pennies,purchase_date,checkout_payer_contributor_id")
        .in("christmas_recipient_id", recipientIds)
        .is("deleted_at", null)
        .order("purchase_date", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    recipientIds.length
      ? db.from("gift_ideas")
        .select("id,christmas_recipient_id,title,estimated_price_pennies")
        .in("christmas_recipient_id", recipientIds)
      : Promise.resolve({ data: [], error: null }),
    db.from("contributors").select("id,person_id").in("christmas_event_id", eventIds),
  ]);

  // Buyer names. `people` is already readable, and this is the only place the
  // history needs it.
  const contributorPersonIds = [...new Set(
    ((contributorResult.data ?? []) as Array<{ person_id: string }>).map((c) => c.person_id),
  )];
  const nameResult = contributorPersonIds.length
    ? await db.from("people").select("id,name").in("id", contributorPersonIds)
    : { data: [] as Array<{ id: string; name: string }>, error: null };
  const nameByPerson = new Map(
    ((nameResult.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]),
  );
  const personByContributor = new Map(
    ((contributorResult.data ?? []) as Array<{ id: string; person_id: string }>)
      .map((c) => [c.id, nameByPerson.get(c.person_id) ?? null]),
  );

  const budgetByEvent = new Map<string, number>();
  for (const recipient of recipients) {
    const eventId = recipient.christmas_event_id as string;
    budgetByEvent.set(eventId, (budgetByEvent.get(eventId) ?? 0) + Number(recipient.budget_pennies));
  }

  const giftsByEvent = new Map<string, BirthdayGift[]>();
  const spentByEvent = new Map<string, number>();
  for (const purchase of (purchaseResult.data ?? []) as Array<Record<string, unknown>>) {
    const eventId = eventByRecipient.get(purchase.christmas_recipient_id as string);
    if (!eventId) continue;
    const pricePennies = Number(purchase.actual_price_pennies);
    spentByEvent.set(eventId, (spentByEvent.get(eventId) ?? 0) + pricePennies);
    const list = giftsByEvent.get(eventId) ?? [];
    list.push({
      id: purchase.id as string,
      description: purchase.description as string,
      pricePennies,
      purchaseDate: String(purchase.purchase_date).slice(0, 10),
      buyerName: personByContributor.get(purchase.checkout_payer_contributor_id as string) ?? null,
    });
    giftsByEvent.set(eventId, list);
  }

  const ideasByEvent = new Map<string, BirthdayOccurrence["openIdeas"]>();
  for (const idea of (ideaResult.data ?? []) as Array<Record<string, unknown>>) {
    const eventId = eventByRecipient.get(idea.christmas_recipient_id as string);
    if (!eventId) continue;
    const list = ideasByEvent.get(eventId) ?? [];
    list.push({
      id: idea.id as string,
      title: idea.title as string,
      estimatedPricePennies: idea.estimated_price_pennies === null ? null : Number(idea.estimated_price_pennies),
    });
    ideasByEvent.set(eventId, list);
  }

  const occurrences: BirthdayOccurrence[] = events.map((event) => ({
    year: currentYearOf(String(event.event_date)),
    eventId: event.id,
    eventName: event.name,
    eventDate: String(event.event_date).slice(0, 10),
    status: event.status,
    budgetPennies: budgetByEvent.get(event.id) ?? 0,
    spentPennies: spentByEvent.get(event.id) ?? 0,
    gifts: giftsByEvent.get(event.id) ?? [],
    openIdeas: ideasByEvent.get(event.id) ?? [],
  }));

  const current = occurrences.find((occurrence) => occurrence.year === currentYear && occurrence.status === "active")
    ?? null;

  const hasActivity = (occurrence: BirthdayOccurrence) =>
    occurrence.gifts.length > 0 || occurrence.openIdeas.length > 0;

  const previous = occurrences
    .filter((occurrence) => occurrence !== current)
    .filter((occurrence) => occurrence.year < currentYear)
    // Only genuine activity. An empty occurrence is an accident, not history.
    .filter(hasActivity)
    .sort((left, right) => right.year - left.year);

  const unused = occurrences
    .filter((occurrence) => occurrence !== current && !hasActivity(occurrence))
    .sort((left, right) => right.year - left.year);

  return { person, current, currentYear, previous, unused, isAdmin, today };
}
