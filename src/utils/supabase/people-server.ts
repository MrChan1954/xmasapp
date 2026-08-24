import "server-only";

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { nextBirthdayOccurrence, personBirthdayFromRow } from "@/lib/birthdays.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { groupGiftHistory, type GiftHistoryRow, type PersonDirectoryEntry, type PersonEventHistory } from "@/lib/people.ts";
import { londonToday } from "./birthdays-server";
import { createClient } from "./server";

/**
 * The family directory, and one person's history, read on the server.
 *
 * EVERY READ HERE IS AN ORDINARY RLS-SCOPED SELECT. Nothing uses a service-role
 * client, so a visitor who is not an active family member gets nothing -- and,
 * just as importantly, migration 031's birthday rules apply without this file
 * knowing about them: the reader's own birthday event, its recipient row, its
 * purchases and its ideas are already gone from these queries before the
 * projection runs.
 *
 * That is why the profile is told `isSelf` separately. An absence the database
 * IMPOSED is not an absence that is TRUE, and a page that could not tell the
 * difference would say "nothing bought yet" to the one person who must not be
 * told either way -- the Phase 1 lesson, in a new screen.
 */

export type PeopleDirectory = {
  people: PersonDirectoryEntry[];
  isAdmin: boolean;
  canEditBirthdays: boolean;
  viewerPersonId: string | null;
  today: string;
};

const PERSON_COLUMNS = "id,name,birthday_month,birthday_day,birthday_year,is_family_contributor,archived_at";
const LEGACY_COLUMNS = "id,name,birthday_month,birthday_day,birthday_year,is_family_contributor";

type Db = Awaited<ReturnType<typeof createClient>>;

/**
 * `archived_at` arrives with migration 032. Until it is applied the column does
 * not exist and selecting it fails the whole query, so this asks for it and
 * falls back rather than showing the family an error during the window between
 * deploying and migrating. The fallback treats everybody as active, which is
 * exactly what they were.
 */
async function selectPeople(db: Db) {
  const withArchive = await db.from("people").select(PERSON_COLUMNS).order("name");
  if (!withArchive.error) return withArchive.data ?? [];

  const legacy = await db.from("people").select(LEGACY_COLUMNS).order("name");
  if (legacy.error) throw new Error("The family's people could not be loaded.");
  return legacy.data ?? [];
}

function toEntry(row: Record<string, unknown>): PersonDirectoryEntry {
  const person = personBirthdayFromRow(row as never);
  return {
    personId: person.personId,
    name: person.name,
    birthday: person.birthday,
    archivedAt: (row.archived_at as string | null) ?? null,
    isFamilyContributor: Boolean(row.is_family_contributor),
  };
}

async function viewerIsContributor(db: Db, viewerPersonId: string | null): Promise<boolean> {
  if (!viewerPersonId) return false;
  const result = await db.from("people").select("is_family_contributor").eq("id", viewerPersonId).maybeSingle();
  return Boolean(result.data?.is_family_contributor);
}

export async function loadPeopleDirectory(): Promise<PeopleDirectory> {
  const db = await createClient();
  const today = londonToday();

  const { data: auth } = await db.auth.getUser();
  if (!auth.user) {
    return { people: [], isAdmin: false, canEditBirthdays: false, viewerPersonId: null, today };
  }

  const membership = await db
    .from("app_members")
    .select("role,person_id")
    .eq("user_id", auth.user.id)
    .eq("active", true)
    .maybeSingle();
  if (!membership.data) {
    return { people: [], isAdmin: false, canEditBirthdays: false, viewerPersonId: null, today };
  }

  const people = (await selectPeople(db)).map((row) => toEntry(row as Record<string, unknown>));
  const viewerPersonId = (membership.data.person_id as string | null) ?? null;
  const isAdmin = membership.data.role === "admin";

  return {
    people,
    isAdmin,
    // The same rule migration 031 enforces inside `set_person_birthday`: an
    // admin always may, and a family contributor may too. Renaming is
    // admin-only and is a SEPARATE flag on purpose -- being allowed to keep the
    // calendar current is not being allowed to rename people.
    canEditBirthdays: isAdmin
      || people.some((entry) => entry.personId === viewerPersonId && entry.isFamilyContributor),
    viewerPersonId,
    today,
  };
}

export type PersonProfile = {
  person: PersonDirectoryEntry;
  /** Every event this person received something in, newest first. */
  history: PersonEventHistory[];
  /**
   * Is this the reader's own profile?
   *
   * Their own BIRTHDAY planning is already absent from `history` -- row level
   * security removed it before this ran -- and this is how the page knows to
   * say so rather than implying nothing was ever planned for them.
   */
  isSelf: boolean;
  isAdmin: boolean;
  canEditBirthdays: boolean;
  today: string;
};

/**
 * One person, and everything bought for them.
 *
 * THE JOIN IS THE PROOF OF OWNERSHIP. It starts at THIS person's recipient
 * rows, so a purchase appears only when the database says that purchase was for
 * them. Another recipient's present in the same event hangs off a different
 * recipient row and never enters the query -- which is why a multi-recipient
 * Christmas does not put everybody's gifts on everybody's profile.
 */
export async function loadPersonProfile(personId: string): Promise<PersonProfile | null> {
  const db = await createClient();
  const today = londonToday();

  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;

  const [membership, personResult] = await Promise.all([
    db.from("app_members").select("role,person_id").eq("user_id", auth.user.id).eq("active", true).maybeSingle(),
    db.from("people").select(PERSON_COLUMNS).eq("id", personId).maybeSingle(),
  ]);
  if (!membership.data) return null;

  const row = personResult.error
    ? (await db.from("people").select(LEGACY_COLUMNS).eq("id", personId).maybeSingle()).data
    : personResult.data;
  // A person who does not exist and a reader who may not look are deliberately
  // the same answer.
  if (!row) return null;

  const person = toEntry(row as Record<string, unknown>);
  const viewerPersonId = (membership.data.person_id as string | null) ?? null;
  const isAdmin = membership.data.role === "admin";

  const recipients = await db
    .from("christmas_recipients")
    .select("id,christmas_event_id,budget_pennies,active")
    .eq("person_id", personId);
  if (recipients.error) throw new Error("This person's gift history could not be loaded.");

  const recipientRows = (recipients.data ?? []) as Array<{
    id: string; christmas_event_id: string; budget_pennies: number; active: boolean;
  }>;
  const recipientIds = recipientRows.map((entry) => entry.id);
  const eventIds = [...new Set(recipientRows.map((entry) => entry.christmas_event_id))];
  const none = { data: [] as Array<Record<string, unknown>>, error: null };

  const [events, purchases, ideas] = await Promise.all([
    eventIds.length
      ? db.from("events").select("id,name,event_type,event_date,status").in("id", eventIds)
      : Promise.resolve(none),
    recipientIds.length
      ? db.from("purchases")
        .select("id,christmas_recipient_id,description,actual_price_pennies,purchase_date,status")
        .in("christmas_recipient_id", recipientIds)
        .is("deleted_at", null)
      : Promise.resolve(none),
    recipientIds.length
      ? db.from("gift_ideas")
        .select("id,christmas_recipient_id,title,estimated_price_pennies")
        .in("christmas_recipient_id", recipientIds)
      : Promise.resolve(none),
  ]);

  const eventById = new Map(
    ((events.data ?? []) as Array<Record<string, unknown>>).map((event) => [event.id as string, event]),
  );
  const recipientById = new Map(recipientRows.map((entry) => [entry.id, entry]));

  /** The event shell for a recipient row, or null if the reader may not see it. */
  const shellFor = (recipientId: string) => {
    const recipient = recipientById.get(recipientId);
    const event = recipient ? eventById.get(recipient.christmas_event_id) : undefined;
    // An event row that row level security removed -- the reader's own birthday
    // -- takes its purchases with it rather than appearing here unnamed.
    if (!recipient || !event) return null;
    return {
      eventId: event.id as string,
      eventName: event.name as string,
      eventType: String(event.event_type),
      eventDate: String(event.event_date).slice(0, 10),
      eventStatus: String(event.status),
      budgetPennies: Number(recipient.budget_pennies),
    };
  };

  const rows: GiftHistoryRow[] = [];
  // An event they are a recipient in but nothing has been bought for yet is
  // still part of the answer: "Halloween, nothing yet" is worth saying.
  for (const recipient of recipientRows) {
    const shell = shellFor(recipient.id);
    if (shell) rows.push(shell);
  }
  for (const purchase of (purchases.data ?? []) as Array<Record<string, unknown>>) {
    const shell = shellFor(purchase.christmas_recipient_id as string);
    if (!shell) continue;
    rows.push({
      ...shell,
      gift: {
        purchaseId: purchase.id as string,
        description: purchase.description as string,
        pricePennies: Number(purchase.actual_price_pennies),
        purchaseDate: String(purchase.purchase_date).slice(0, 10),
        status: String(purchase.status),
      },
    });
  }
  for (const idea of (ideas.data ?? []) as Array<Record<string, unknown>>) {
    const shell = shellFor(idea.christmas_recipient_id as string);
    if (!shell) continue;
    rows.push({
      ...shell,
      idea: {
        giftIdeaId: idea.id as string,
        title: idea.title as string,
        estimatedPricePennies: idea.estimated_price_pennies === null ? null : Number(idea.estimated_price_pennies),
      },
    });
  }

  return {
    person,
    history: groupGiftHistory(rows),
    isSelf: viewerPersonId !== null && viewerPersonId === person.personId,
    isAdmin,
    canEditBirthdays: isAdmin || await viewerIsContributor(db, viewerPersonId),
    today,
  };
}

/** The age this person turns next, for the profile header. */
export function nextBirthdayFor(entry: PersonDirectoryEntry, today: string) {
  return entry.birthday ? nextBirthdayOccurrence(entry.birthday, today) : null;
}
