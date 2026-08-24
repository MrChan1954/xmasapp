/**
 * People as a directory, and what has been bought for them.
 *
 * WHAT A PERSON IS
 *   A durable family record. A person exists whether or not they receive
 *   anything, whether or not they have an account, whether or not they chip in,
 *   and whether or not anybody has recorded their birthday. Those are four
 *   separate facts about them and none of them is what makes them a person.
 *
 * WHAT A RECIPIENT IS
 *   A ROLE the person holds inside ONE event. `christmas_recipients` is that
 *   role: it names a person and an event, and carries the budget for them in
 *   it. The same person holds the role again, separately, in every event they
 *   receive something in.
 *
 * WHERE GIFT HISTORY COMES FROM, AND WHY THERE IS NO TABLE FOR IT
 *   A purchase names exactly one recipient row, and that row names exactly one
 *   person and one event:
 *
 *     purchases -> christmas_recipients -> (person_id, christmas_event_id)
 *
 *   So a purchase belongs to exactly one person, in exactly one event, and the
 *   database has been able to answer "what have we bought Eden?" since
 *   migration 001. Everything below is a PROJECTION of those rows. A
 *   `person_gift_history` table would cache an answer the database already has
 *   and add a second thing that can be wrong.
 *
 * WHAT IS NOT EVIDENCE OF A GIFT
 *   `purchases.gift_location_person_id` says who is HIDING the present, not who
 *   it is for. Reading it as ownership would put Grandma's present on the
 *   profile of whoever has the spare room.
 *
 *   Being a contributor to an event is not receiving from it either. "Paige
 *   contributed to Christmas" must never become "Paige received these" -- which
 *   is exactly what deriving history from event participation would do.
 */

export type PersonDirectoryEntry = {
  personId: string;
  name: string;
  /** Month/day/year, or null when nobody has recorded it. */
  birthday: { month: number; day: number; year: number | null } | null;
  archivedAt: string | null;
  isFamilyContributor: boolean;
};

/** One thing actually bought for this person, in one event. */
export type PersonGift = {
  purchaseId: string;
  description: string;
  pricePennies: number;
  purchaseDate: string;
  /** `purchases.status` -- "purchased" or "wrapped". Carried, never inferred. */
  status: string;
};

/**
 * One thing SUGGESTED for this person, which is not the same as bought.
 *
 * Kept apart from gifts at the type level rather than by a flag, because the
 * one mistake that matters here is an idea counting as spend. A separate type
 * cannot be added into a total by accident.
 */
export type PersonIdea = {
  giftIdeaId: string;
  title: string;
  estimatedPricePennies: number | null;
};

/** One event this person received something in, or was set up to. */
export type PersonEventHistory = {
  eventId: string;
  eventName: string;
  eventType: string;
  eventDate: string;
  eventStatus: string;
  /** The budget set for THIS person in THIS event, in pennies. */
  budgetPennies: number;
  /** Sum of this person's own purchases in this event. Never the event total. */
  spentPennies: number;
  gifts: PersonGift[];
  ideas: PersonIdea[];
};

/**
 * The rows a loader hands over: one per (recipient, purchase-or-idea-or-neither).
 *
 * Deliberately flat. The shaping happens here, in a pure function that can be
 * tested against a fixture, rather than inside a query nobody can run without a
 * database.
 */
export type GiftHistoryRow = {
  eventId: string;
  eventName: string;
  eventType: string;
  eventDate: string;
  eventStatus: string;
  budgetPennies: number;
  gift?: PersonGift;
  idea?: PersonIdea;
};

/**
 * Group one person's rows into one entry per event, newest first.
 *
 * `spentPennies` sums THIS PERSON'S purchases and nothing else. The event's own
 * total includes everybody else's presents, and showing it here would tell a
 * family they spent £400 on one child.
 *
 * Ideas are collected but never added: an idea is a suggestion, and a
 * suggestion has not cost anybody anything.
 */
export function groupGiftHistory(rows: readonly GiftHistoryRow[]): PersonEventHistory[] {
  const byEvent = new Map<string, PersonEventHistory>();

  for (const row of rows) {
    let entry = byEvent.get(row.eventId);
    if (!entry) {
      entry = {
        eventId: row.eventId,
        eventName: row.eventName,
        eventType: row.eventType,
        eventDate: row.eventDate,
        eventStatus: row.eventStatus,
        budgetPennies: row.budgetPennies,
        spentPennies: 0,
        gifts: [],
        ideas: [],
      };
      byEvent.set(row.eventId, entry);
    }

    if (row.gift && !entry.gifts.some((gift) => gift.purchaseId === row.gift?.purchaseId)) {
      entry.gifts.push(row.gift);
      entry.spentPennies += row.gift.pricePennies;
    }
    if (row.idea && !entry.ideas.some((idea) => idea.giftIdeaId === row.idea?.giftIdeaId)) {
      entry.ideas.push(row.idea);
    }
  }

  for (const entry of byEvent.values()) {
    entry.gifts.sort((left, right) =>
      right.purchaseDate.localeCompare(left.purchaseDate) || left.description.localeCompare(right.description, "en-GB"));
    entry.ideas.sort((left, right) => left.title.localeCompare(right.title, "en-GB"));
  }

  // Newest event first: "what did we get them last Christmas" is the question
  // somebody opens this page to answer, and it is nearly always the recent one.
  return [...byEvent.values()].sort((left, right) =>
    right.eventDate.localeCompare(left.eventDate) || left.eventName.localeCompare(right.eventName, "en-GB"));
}

/**
 * Split history into what is still being planned and what already happened.
 *
 * By the event's DATE against the family's today, not by its status: an
 * archived Christmas that has been and gone is history, and so is an active one
 * whose date has passed. Archived events stay in the list either way -- "what
 * did we get Eden last Christmas" has to keep working after somebody tidies up.
 */
export function partitionGiftHistory(
  history: readonly PersonEventHistory[],
  today: string,
): { current: PersonEventHistory[]; previous: PersonEventHistory[] } {
  const current: PersonEventHistory[] = [];
  const previous: PersonEventHistory[] = [];
  for (const entry of history) {
    if (entry.eventStatus === "active" && entry.eventDate >= today) current.push(entry);
    else previous.push(entry);
  }
  // Soonest first among the things still coming; newest first among the past.
  current.sort((left, right) => left.eventDate.localeCompare(right.eventDate));
  return { current, previous };
}

/** Every penny actually spent on this person, across every event. */
export function totalSpentPennies(history: readonly PersonEventHistory[]): number {
  return history.reduce((total, entry) => total + entry.spentPennies, 0);
}

/** How many things were actually bought. Ideas are not gifts and are not here. */
export function totalGiftCount(history: readonly PersonEventHistory[]): number {
  return history.reduce((total, entry) => total + entry.gifts.length, 0);
}
