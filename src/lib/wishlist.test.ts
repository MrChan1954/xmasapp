import assert from "node:assert/strict";
import test, { describe } from "node:test";

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { FORBIDDEN_ON_OWN_BIRTHDAY, SELF_PRIVATE_CTA, WISHLIST_EMPTY, WISHLIST_HEADLINE, WISHLIST_INTRO, WISHLIST_PLANNER_HEADING, WISHLIST_PLANNER_NOTE, canWriteWishlist, leaksPlanning, sortWishlist, toWishlistEntry, validateWish, wishlistForYear, wishlistYear, type WishlistEntry } from "./wishlist.ts";

const entry = (over: Partial<WishlistEntry> = {}): WishlistEntry => ({
  id: "wish-1",
  personId: "taylor",
  occurrenceYear: 2026,
  title: "AirPods",
  estimatedPricePennies: 12900,
  url: null,
  notes: null,
  createdAt: "2026-01-01T10:00:00.000Z",
  ...over,
});

// ---------------------------------------------------------------------------
// The projection. This is the privacy boundary in code, so it is tested as one.
// ---------------------------------------------------------------------------

describe("a wish carries nothing but what its author typed", () => {
  test("the named fields come through", () => {
    const result = toWishlistEntry({
      id: "wish-1",
      person_id: "taylor",
      occurrence_year: "2026",
      title: "AirPods",
      estimated_price_pennies: "12900",
      url: "https://example.com/airpods",
      notes: "the white ones",
      created_at: "2026-01-01T10:00:00.000Z",
    });

    assert.deepEqual(result, {
      id: "wish-1",
      personId: "taylor",
      occurrenceYear: 2026,
      title: "AirPods",
      estimatedPricePennies: 12900,
      url: "https://example.com/airpods",
      notes: "the white ones",
      createdAt: "2026-01-01T10:00:00.000Z",
    });
  });

  test("and ANYTHING about a purchase is dropped, whatever a row arrives carrying", () => {
    // The database has no such column on this table. This proves the app could
    // not forward one even if a join, a view or a mistaken select("*") produced
    // it -- the projection names its fields and copies nothing else.
    const contaminated = {
      id: "wish-1",
      person_id: "taylor",
      occurrence_year: 2026,
      title: "AirPods",
      created_at: "2026-01-01T10:00:00.000Z",
      // Every one of these is the thing the celebrant must not learn.
      purchased: true,
      status: "wrapped",
      bought_by: "Jade",
      purchaser_name: "Jade",
      actual_price_pennies: 12900,
      originating_gift_idea_id: "idea-9",
      purchase_id: "purchase-3",
      budget_pennies: 5000,
      spent_pennies: 12900,
      contributor_id: "contributor-2",
    } as unknown as Parameters<typeof toWishlistEntry>[0];

    const result = toWishlistEntry(contaminated);
    const keys = Object.keys(result).sort();

    assert.deepEqual(keys, [
      "createdAt", "estimatedPricePennies", "id", "notes", "occurrenceYear", "personId", "title", "url",
    ]);
    for (const leak of ["purchased", "status", "bought_by", "purchaser_name", "actual_price_pennies",
      "originating_gift_idea_id", "purchase_id", "budget_pennies", "spent_pennies", "contributor_id"]) {
      assert.ok(!(leak in result), `${leak} survived the projection`);
    }
    assert.equal(JSON.stringify(result).includes("Jade"), false);
    assert.equal(JSON.stringify(result).includes("wrapped"), false);
  });

  test("a missing price is null, never zero", () => {
    // Zero would render as "£0.00" and read as somebody having decided a price.
    assert.equal(
      toWishlistEntry({ id: "a", person_id: "p", occurrence_year: 2026, title: "Socks", created_at: "x" })
        .estimatedPricePennies,
      null,
    );
    assert.equal(
      toWishlistEntry({ id: "a", person_id: "p", occurrence_year: 2026, title: "Socks", estimated_price_pennies: null, created_at: "x" })
        .estimatedPricePennies,
      null,
    );
  });
});

// ---------------------------------------------------------------------------

describe("the list is ordered and filtered by the birthday it is for", () => {
  test("newest first", () => {
    const ordered = sortWishlist([
      entry({ id: "old", createdAt: "2026-01-01T09:00:00.000Z" }),
      entry({ id: "new", createdAt: "2026-01-02T09:00:00.000Z" }),
    ]);
    assert.deepEqual(ordered.map((row) => row.id), ["new", "old"]);
  });

  test("two wishes added in the same instant fall back to the title", () => {
    const ordered = sortWishlist([
      entry({ id: "b", title: "Trainers", createdAt: "2026-01-01T09:00:00.000Z" }),
      entry({ id: "a", title: "Aftershave", createdAt: "2026-01-01T09:00:00.000Z" }),
    ]);
    assert.deepEqual(ordered.map((row) => row.title), ["Aftershave", "Trainers"]);
  });

  test("sorting does not mutate the list it was given", () => {
    const original = [entry({ id: "old", createdAt: "2026-01-01T09:00:00.000Z" }), entry({ id: "new", createdAt: "2026-01-02T09:00:00.000Z" })];
    sortWishlist(original);
    assert.deepEqual(original.map((row) => row.id), ["old", "new"]);
  });

  test("last year's list is not this year's", () => {
    const all = [entry({ id: "this-year", occurrenceYear: 2026 }), entry({ id: "last-year", occurrenceYear: 2025 })];
    assert.deepEqual(wishlistForYear(all, 2026).map((row) => row.id), ["this-year"]);
    assert.deepEqual(wishlistForYear(all, 2025).map((row) => row.id), ["last-year"]);
  });
});

describe("which birthday a new wish is for", () => {
  test("the one still to come this year", () => {
    assert.equal(wishlistYear({ month: 8, day: 30, year: 1996 }, "2026-08-25"), 2026);
  });

  test("and next year's once it has been and gone", () => {
    // A wish typed the day after somebody's birthday is for the NEXT one, which
    // is the same rule the dashboard card uses. Filing it under the birthday
    // that has just happened would put it on a list nobody opens again.
    assert.equal(wishlistYear({ month: 8, day: 20, year: 1996 }, "2026-08-25"), 2027);
  });

  test("on the day itself, it is still today's", () => {
    assert.equal(wishlistYear({ month: 8, day: 25, year: 1996 }, "2026-08-25"), 2026);
  });

  test("no birthday recorded means no year to file a wish under", () => {
    assert.equal(wishlistYear(null, "2026-08-25"), null);
  });
});

// ---------------------------------------------------------------------------
// The Area rule. Every case the requirement names, as a table.
// ---------------------------------------------------------------------------

describe("only the birthday person may write their own list, and only in their own Area", () => {
  const alpha = "area-alpha";
  const bravo = "area-bravo";

  test("the birthday person, in their own family", () => {
    assert.equal(canWriteWishlist({
      viewerPersonId: "taylor-alpha", viewerAreaId: alpha,
      personId: "taylor-alpha", personAreaId: alpha,
    }), true);
  });

  test("somebody else in the same family cannot", () => {
    assert.equal(canWriteWishlist({
      viewerPersonId: "jade-alpha", viewerAreaId: alpha,
      personId: "taylor-alpha", personAreaId: alpha,
    }), false);
  });

  test("THE SAME ACCOUNT IN TWO FAMILIES RESOLVES EACH ONE SEPARATELY", () => {
    // One login, two memberships, two different person rows. Being Taylor in
    // Alpha must say nothing at all about Bravo.
    assert.equal(canWriteWishlist({
      viewerPersonId: "taylor-alpha", viewerAreaId: alpha,
      personId: "sam-bravo", personAreaId: bravo,
    }), false);

    assert.equal(canWriteWishlist({
      viewerPersonId: "sam-bravo", viewerAreaId: bravo,
      personId: "sam-bravo", personAreaId: bravo,
    }), true);
  });

  test("an identical person id in another Area is not the same person", () => {
    // The ids could never collide in practice; the point is that the Area is
    // compared at all, so a match on identity alone is never enough.
    assert.equal(canWriteWishlist({
      viewerPersonId: "same-id", viewerAreaId: alpha,
      personId: "same-id", personAreaId: bravo,
    }), false);
  });

  test("a membership with no person linked writes nothing", () => {
    assert.equal(canWriteWishlist({
      viewerPersonId: null, viewerAreaId: alpha,
      personId: "taylor-alpha", personAreaId: alpha,
    }), false);
  });

  test("and neither does a reader with no Area", () => {
    assert.equal(canWriteWishlist({
      viewerPersonId: "taylor-alpha", viewerAreaId: null,
      personId: "taylor-alpha", personAreaId: alpha,
    }), false);
    assert.equal(canWriteWishlist({
      viewerPersonId: "taylor-alpha", viewerAreaId: alpha,
      personId: "taylor-alpha", personAreaId: null,
    }), false);
  });
});

// ---------------------------------------------------------------------------

describe("what counts as a wish", () => {
  const base = { title: "AirPods", estimatedPrice: "", url: "", notes: "" };

  test("a title is enough", () => {
    const result = validateWish(base);
    assert.ok(result.ok);
    assert.deepEqual(result.value, { title: "AirPods", estimatedPricePennies: null, url: null, notes: null });
  });

  test("an empty title is not", () => {
    assert.equal(validateWish({ ...base, title: "   " }).ok, false);
  });

  test("a price is optional, and read in pennies", () => {
    const result = validateWish({ ...base, estimatedPrice: "129.00" });
    assert.ok(result.ok);
    assert.equal(result.value.estimatedPricePennies, 12900);
  });

  test("a nonsense price is refused rather than rounded", () => {
    assert.equal(validateWish({ ...base, estimatedPrice: "about a hundred" }).ok, false);
  });

  test("a link must be http or https", () => {
    assert.ok(validateWish({ ...base, url: "https://example.com/x" }).ok);
    assert.equal(validateWish({ ...base, url: "javascript:alert(1)" }).ok, false);
  });

  test("notes may span lines but not carry control characters", () => {
    assert.ok(validateWish({ ...base, notes: "size 9\nblack" }).ok);
    assert.equal(validateWish({ ...base, notes: "size\u00079" }).ok, false);
  });
});

// ---------------------------------------------------------------------------
// The copy. The wording IS the requirement, so it is asserted, not reviewed.
// ---------------------------------------------------------------------------

describe("what the birthday person's own screen is allowed to say", () => {
  test("it invites them to add ideas, and says the presents are still hidden", () => {
    assert.match(WISHLIST_HEADLINE, /wishlist/i);
    assert.match(WISHLIST_INTRO, /surprise/i);
    assert.match(WISHLIST_INTRO, /hidden/i);
  });

  test("it no longer implies the birthday is entirely out of reach", () => {
    for (const copy of [WISHLIST_HEADLINE, WISHLIST_INTRO, WISHLIST_EMPTY]) {
      assert.doesNotMatch(copy, /can'?t see|cannot see|not allowed|no access/i, copy);
    }
  });

  test("and it never mentions a purchase, a price paid, a plan or a budget", () => {
    // `leaksPlanning` is the sweep the screen's own test runs over its source.
    // Running it over the constants proves the constants are clean too.
    for (const copy of [WISHLIST_HEADLINE, WISHLIST_INTRO, WISHLIST_EMPTY, SELF_PRIVATE_CTA]) {
      assert.deepEqual(leaksPlanning(copy), [], copy);
    }
  });

  test("the dashboard's link says what it does without promising planning", () => {
    assert.match(SELF_PRIVATE_CTA, /idea/i);
    assert.doesNotMatch(SELF_PRIVATE_CTA, /plan|budget|purchase/i);
  });

  test("the planner's heading names whose list it is and warns it is one-way", () => {
    assert.match(WISHLIST_PLANNER_HEADING, /wishlist/i);
    assert.match(WISHLIST_PLANNER_NOTE, /cannot see/i);
  });

  test("the forbidden list covers every way of saying somebody acted on a wish", () => {
    for (const word of ["purchased", "bought", "wrapped", "budget", "spent", "contributor", "owed"]) {
      assert.ok(FORBIDDEN_ON_OWN_BIRTHDAY.includes(word), `${word} should be forbidden`);
    }
  });

  test("and the sweep catches them", () => {
    assert.deepEqual(leaksPlanning("Purchased by Jade for £129"), ["purchased"]);
    assert.deepEqual(leaksPlanning("£40 of budget remaining"), ["budget", "remaining"]);
    assert.deepEqual(leaksPlanning("A perfectly ordinary sentence."), []);
  });
});
