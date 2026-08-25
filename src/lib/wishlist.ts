/**
 * THE BIRTHDAY PERSON'S OWN LIST.
 *
 * A wishlist is the one thing on somebody's birthday that they are allowed to
 * see, because they wrote every word of it. Everything else -- what was bought,
 * by whom, for how much, whether it is wrapped, who is chipping in -- stays
 * exactly as hidden as migration 031 made it.
 *
 * THIS FILE IS NOT THE LOCK. Migration 040 is: one table with no foreign key
 * into the planning, four policies, and a write that only the birthday person
 * passes. What lives here is the shape of a wish, what counts as a valid one,
 * and the words the screens use -- pinned as constants because the wording is
 * part of the requirement rather than decoration.
 *
 * THE PROJECTION IS THE POINT
 *   `toWishlistEntry` builds an entry field by field from a named list. It does
 *   not spread, and it does not copy anything it was not asked for. A row that
 *   arrived from anywhere with `purchased`, `bought_by`, `status` or a price
 *   paid on it cannot carry those through, because there is no line here that
 *   would carry them. That is a structural guarantee a test can hold, rather
 *   than a rule somebody has to remember when adding a column.
 */

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { INPUT_LIMITS, MAX_PENNIES, parseMoneyToPennies, validateHttpUrl, validateOptionalText, validateRequiredText, type ValidationResult } from "./input-validation.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { nextBirthdayOccurrence, type Birthday } from "./birthdays.ts";

/**
 * One wish, as the application knows it.
 *
 * EVERY FIELD IS SOMETHING THE BIRTHDAY PERSON TYPED. There is deliberately no
 * `purchased`, no `status`, no `boughtBy` and no `actualPricePennies` -- not
 * hidden, not optional, ABSENT. The database has no such column on this table
 * either, so there is nowhere for one to come from.
 */
export type WishlistEntry = {
  id: string;
  personId: string;
  occurrenceYear: number;
  title: string;
  /** What THEY guessed it costs. Never what anybody paid. */
  estimatedPricePennies: number | null;
  url: string | null;
  notes: string | null;
  createdAt: string;
};

/** The row shape as it comes back from `birthday_wishlist_ideas`. */
export type WishlistRow = {
  id: string;
  person_id: string;
  occurrence_year: number | string;
  title: string;
  estimated_price_pennies?: number | string | null;
  url?: string | null;
  notes?: string | null;
  created_at: string;
};

/**
 * The ONLY columns that reach a screen.
 *
 * Written out rather than spread. A spread would quietly forward whatever a
 * future join or a mistaken `select("*")` put on the row, and on this
 * particular screen the reader is the one person in the family who must not
 * see it.
 */
export function toWishlistEntry(row: WishlistRow): WishlistEntry {
  return {
    id: row.id,
    personId: row.person_id,
    occurrenceYear: Number(row.occurrence_year),
    title: row.title,
    estimatedPricePennies:
      row.estimated_price_pennies === null || row.estimated_price_pennies === undefined
        ? null
        : Number(row.estimated_price_pennies),
    url: row.url ?? null,
    notes: row.notes ?? null,
    createdAt: row.created_at,
  };
}

/** Newest first, which is the order somebody adds things in. */
export function sortWishlist(entries: readonly WishlistEntry[]): WishlistEntry[] {
  return [...entries].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    return left.title.localeCompare(right.title, "en-GB", { sensitivity: "base" });
  });
}

/** Only the wishes for the birthday being looked at. */
export function wishlistForYear(entries: readonly WishlistEntry[], year: number): WishlistEntry[] {
  return sortWishlist(entries.filter((entry) => entry.occurrenceYear === year));
}

/**
 * WHICH BIRTHDAY A WISH IS FOR.
 *
 * The one that is COMING. If somebody's birthday has already been this year,
 * a wish added today is for next year's -- the same rule the dashboard uses to
 * decide which occurrence a card is about, so a wish and the card about it can
 * never disagree.
 *
 * Null where no birthday is recorded: there is no year to file a wish under,
 * and inventing one would put it on a list nobody ever opens.
 */
export function wishlistYear(birthday: Birthday | null, today: string): number | null {
  if (!birthday) return null;
  const next = nextBirthdayOccurrence(birthday, today);
  return next ? next.year : null;
}

/**
 * MAY THIS READER WRITE THIS LIST?
 *
 * BOTH HALVES COME FROM THE SAME AREA, and that is the whole rule. The reader's
 * person is who they are in the Area the list's person belongs to; if they hold
 * no membership there, `viewerPersonId` is null and the answer is no.
 *
 * An account that is Taylor in one family and Sam in another gets true for
 * Taylor's list and false for Taylor's list read from the other family's
 * membership -- there is no arrangement of ids that makes an identity in one
 * Area answer a question about another.
 *
 * THIS IS NOT THE AUTHORIZATION. Migration 040's policies are, and they resolve
 * the same two halves in the database where a browser cannot reach them. This
 * exists so the app does not render an Add button that is going to be refused.
 */
export function canWriteWishlist(input: {
  viewerPersonId: string | null;
  viewerAreaId: string | null;
  personId: string;
  personAreaId: string | null;
}): boolean {
  if (!input.viewerPersonId || !input.viewerAreaId || !input.personAreaId) return false;
  if (input.viewerAreaId !== input.personAreaId) return false;
  return input.viewerPersonId === input.personId;
}

// ---------------------------------------------------------------------------
// What a wish has to be before it is worth sending
//
// The database has the last word -- `birthday_wishlist_ideas` carries the same
// checks as constraints. This exists so somebody typing finds out immediately
// instead of after a round trip, and it reuses the app's one validation module
// rather than growing a second set of rules that can drift from it.
// ---------------------------------------------------------------------------

export type WishlistInput = {
  title: string;
  estimatedPrice: string;
  url: string;
  notes: string;
};

export type WishlistValues = {
  title: string;
  estimatedPricePennies: number | null;
  url: string | null;
  notes: string | null;
};

export function validateWish(input: WishlistInput): ValidationResult<WishlistValues> {
  const title = validateRequiredText(input.title, { field: "what you would like", maxLength: INPUT_LIMITS.title });
  if (!title.ok) return title;

  const price = parseMoneyToPennies(input.estimatedPrice, {
    field: "roughly what it costs",
    allowEmpty: true,
    maxPennies: MAX_PENNIES,
  });
  if (!price.ok) return price;

  const url = validateHttpUrl(input.url);
  if (!url.ok) return url;

  const notes = validateOptionalText(input.notes, {
    field: "your note",
    maxLength: INPUT_LIMITS.notes,
    multiline: true,
  });
  if (!notes.ok) return notes;

  return {
    ok: true,
    value: {
      title: title.value,
      estimatedPricePennies: price.value,
      url: url.value,
      notes: notes.value,
    },
  };
}

// ---------------------------------------------------------------------------
// The words
//
// Pinned here because they ARE the requirement. The old screen said "You can't
// see what you're getting", full stop, which was true and read as a locked
// door. It has to keep saying the presents are hidden while no longer saying
// the whole birthday is.
// ---------------------------------------------------------------------------

/** The heading on the birthday person's own page. */
export const WISHLIST_HEADLINE = "Your birthday wishlist";

/** Why they can write here and still cannot see anything else. */
export const WISHLIST_INTRO =
  "Add ideas for things you would like. Your family can see your list — and what they buy, plan and spend stays hidden, so your presents remain a surprise.";

/** An empty list is a normal state, not a failure. */
export const WISHLIST_EMPTY = "Nothing on your list yet. Add the first thing you would like.";

/** The dashboard card's link. Safe: it leads only to the wishlist. */
export const SELF_PRIVATE_CTA = "Add gift ideas";

/** What a planner sees above the birthday person's own list. */
export const WISHLIST_PLANNER_HEADING = "Their wishlist";

export const WISHLIST_PLANNER_NOTE =
  "Added by the birthday person themselves. They cannot see your ideas, your purchases or your plans.";

/**
 * WORDS THAT MUST NEVER APPEAR ON THE BIRTHDAY PERSON'S OWN SCREEN.
 *
 * Held as data so a test can sweep the rendered copy for them, rather than
 * relying on review to notice that a helpful sentence has crept in. Each one is
 * a way of saying "somebody has acted on this", which is the single thing the
 * whole feature exists to keep quiet about.
 */
export const FORBIDDEN_ON_OWN_BIRTHDAY: readonly string[] = [
  "purchased",
  "bought",
  "wrapped",
  "arrived",
  "budget",
  "spent",
  "remaining",
  "contributor",
  "owed",
  "paid",
  "allocation",
  "start planning",
];

/**
 * Does this copy give anything away?
 *
 * Case-insensitive, and matched against the words above. Used by the tests over
 * the own-birthday screen's source, so a well-meant "£40 of budget remaining"
 * fails a build instead of appearing on somebody's birthday.
 */
export function leaksPlanning(copy: string): string[] {
  const haystack = copy.toLowerCase();
  return FORBIDDEN_ON_OWN_BIRTHDAY.filter((word) => haystack.includes(word));
}
