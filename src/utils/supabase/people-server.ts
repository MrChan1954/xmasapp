import "server-only";

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { personBirthdayFromRow } from "@/lib/birthdays.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { groupGiftHistory, personAccountFrom, type GiftHistoryRow, type PersonAccount, type PersonDirectoryEntry, type PersonEventHistory } from "@/lib/people.ts";
import { londonToday } from "./birthdays-server";
import { getCurrentMember } from "./current-member";
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
  /**
   * WHO CAN SIGN IN, KEYED BY PERSON -- and empty for anybody who may not know.
   *
   * Row level security decides: a member reads only their own membership row,
   * an admin reads all of them. So for an ordinary member this map holds at
   * most themselves, and the directory shows no account badges at all rather
   * than showing everybody a status the database declined to tell them.
   */
  accounts: Record<string, PersonAccount>;
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
async function selectPeople(db: Db, areaId: string) {
  const withArchive = await db.from("people").select(PERSON_COLUMNS).eq("area_id", areaId).order("name");
  if (!withArchive.error) return withArchive.data ?? [];

  const legacy = await db.from("people").select(LEGACY_COLUMNS).eq("area_id", areaId).order("name");
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

async function viewerIsContributor(db: Db, areaId: string, viewerPersonId: string | null): Promise<boolean> {
  if (!viewerPersonId) return false;
  // Scoped like every other read of `people` here, though the id is already the
  // viewer's own person in this Area. One rule, no exceptions to remember.
  const result = await db.from("people").select("is_family_contributor").eq("id", viewerPersonId).eq("area_id", areaId).maybeSingle();
  return Boolean(result.data?.is_family_contributor);
}

export async function loadPeopleDirectory(): Promise<PeopleDirectory> {
  const db = await createClient();
  const today = londonToday();
  const nothing: PeopleDirectory = {
    people: [], isAdmin: false, canEditBirthdays: false, viewerPersonId: null, accounts: {}, today,
  };

  /**
   * THE FAMILY ON SCREEN, AND ONLY THAT ONE.
   *
   * `getCurrentMember` in place of a `maybeSingle()` that ERRORS the moment a
   * login holds two memberships -- and it supplies the Area the directory is
   * then narrowed to. Row level security returns every family the reader
   * belongs to, which is right as a permission and wrong as a screen: unscoped,
   * this page would list two families' people in one alphabetical run.
   */
  const { member } = await getCurrentMember();
  const areaId = (member?.area_id as string | null) ?? null;
  if (!member || !areaId) return nothing;

  const people = (await selectPeople(db, areaId)).map((row) => toEntry(row as Record<string, unknown>));
  const viewerPersonId = (member.person_id as string | null) ?? null;
  const isAdmin = member.role === "admin";

  /**
   * SCOPED TO THIS AREA LIKE EVERY OTHER READ HERE, and read through the
   * caller's own session so row level security is the thing deciding what comes
   * back. There is no service-role client anywhere in this file.
   */
  const memberships = await db
    .from("app_members")
    .select("person_id,user_id,active,role")
    .eq("area_id", areaId);

  const accounts: Record<string, PersonAccount> = {};
  for (const row of (memberships.data ?? []) as Array<Record<string, unknown>>) {
    const personId = (row.person_id as string | null) ?? null;
    if (!personId) continue;
    accounts[personId] = personAccountFrom({
      userId: (row.user_id as string | null) ?? null,
      active: Boolean(row.active),
      role: String(row.role),
    });
  }

  return {
    people,
    accounts,
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
  /**
   * Whether this person can sign in, and whether they administer the family.
   *
   * A SEPARATE FACT FROM EVERYTHING ELSE ON THIS TYPE. Being in the directory,
   * being able to log in, being eligible to chip in and being an administrator
   * are four different things about one person, and the profile is the screen
   * that has to show them as four.
   *
   * Only an admin is told: reading it requires `admins read all memberships`,
   * so for anybody else the query returns nothing and this reads "none" --
   * which is why the screen shows the section to an admin alone rather than
   * showing everybody a status that would be wrong.
   */
  account: PersonAccount;
  isAdmin: boolean;
  canEditBirthdays: boolean;
  /**
   * The family this person is in, by name.
   *
   * ON THE PAGE ON PURPOSE. A login in several families reads the same screen
   * layout in each, and "Jade" exists in more than one of them. Naming the
   * family is what stops somebody renaming or archiving the right name in the
   * wrong household.
   */
  areaName: string;
  /** The READER'S role in this Area -- never this person's. */
  viewerRole: "admin" | "member";
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

  const { member } = await getCurrentMember();
  const areaId = (member?.area_id as string | null) ?? null;
  if (!member || !areaId) return null;

  /**
   * Reached through the family on screen or not at all. A login in two families
   * may legitimately read a person in either, and row level security allows it
   * -- but opening one family's person from inside the other is a profile whose
   * events, purchases and history all belong to a family this screen is not
   * about.
   */
  const personResult = await db
    .from("people").select(PERSON_COLUMNS).eq("id", personId).eq("area_id", areaId).maybeSingle();

  const row = personResult.error
    ? (await db.from("people").select(LEGACY_COLUMNS).eq("id", personId).eq("area_id", areaId).maybeSingle()).data
    : personResult.data;
  // A person who does not exist and a reader who may not look are deliberately
  // the same answer.
  if (!row) return null;

  const person = toEntry(row as Record<string, unknown>);
  const viewerPersonId = (member.person_id as string | null) ?? null;
  const isAdmin = member.role === "admin";

  // The membership, if this reader may see one. Row level security decides:
  // a member reads only their own row, an admin reads all of them. An error or
  // an empty result is simply "nothing to show", never an assumption.
  const membershipRow = await db
    .from("app_members")
    .select("user_id,active,role")
    .eq("person_id", personId)
    .eq("area_id", areaId)
    .maybeSingle();
  const account = personAccountFrom(
    membershipRow.error || !membershipRow.data
      ? null
      : {
        userId: (membershipRow.data.user_id as string | null) ?? null,
        active: Boolean(membershipRow.data.active),
        role: String(membershipRow.data.role),
      },
  );

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

  // By unique id, so the Area-scoped sweep is satisfied by construction, and
  // through the reader's own session so it can only ever name a family they
  // are really in.
  const areaRow = await db.from("areas").select("name").eq("id", areaId).maybeSingle();

  return {
    person,
    history: groupGiftHistory(rows),
    isSelf: viewerPersonId !== null && viewerPersonId === person.personId,
    account,
    isAdmin,
    canEditBirthdays: isAdmin || await viewerIsContributor(db, areaId, viewerPersonId),
    areaName: (areaRow.data?.name as string | undefined)?.trim() || "this family",
    viewerRole: isAdmin ? "admin" : "member",
    today,
  };
}
