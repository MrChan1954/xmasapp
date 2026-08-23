import assert from "node:assert/strict";
import test from "node:test";

/**
 * Multi-event isolation, over the REAL financial engine.
 *
 * These are not tests of a reimplementation. Every balance below is produced by
 * `calculateNetOwedBalances` and `contributorOwedSummary` from src/lib/owed.ts
 * — the same functions the Owed screen, the Home page and the notification
 * dispatcher use — fed by a loader that mirrors, query for query, what
 * `src/app/owed/owed-data.ts` and `src/app/family-context.tsx` actually do:
 *
 *   recipients WHERE event  ->  purchases WHERE recipient IN (...)
 *                           ->  allocations WHERE purchase IN (...)
 *   settlements WHERE event
 *
 * WHAT THEY EXIST TO PROVE
 *   1. Christmas 2026 reads identically before and after the Event
 *      generalisation, to the penny.
 *   2. A second event can exist and Christmas does not move by a single penny.
 *   3. The birthday's own figures contain birthday data and nothing else.
 *   4. The compatibility view still resolves "the Christmas event" the two ways
 *      the existing code asks for it, and a birthday can never answer either.
 *
 * WHAT THEY DO NOT PROVE
 *   That the SQL in migration 025 parses. Nothing in this repository can run
 *   Postgres. The SQL's own end-state and no-money-moved assertions do that
 *   when it is applied; `scripts/event-model.test.mjs` checks its text.
 *
 * EVERY FIGURE BELOW IS INVENTED, NOT OBSERVED.
 *   The budgets, prices and balances in `familyFixture()` were made up for this
 *   file, chosen to exercise the engine: a soft-deleted purchase, a voided
 *   payment, a partial confirmation, a rejection. They are asserted against
 *   each other, inside this file, and they say NOTHING about what the live
 *   Christmas 2026 has actually cost — only the database knows that. Do not
 *   quote a number from here as a production figure.
 */

const {
  calculateNetOwedBalances,
  contributorOwedSummary,
} = await import("../src/lib/owed.ts");

// ---------------------------------------------------------------------------
// A two-event family
// ---------------------------------------------------------------------------
// Deliberately messy, because a clean fixture proves nothing: a soft-deleted
// purchase, a voided payment, a partial confirmation and a rejection are all
// present, so the engine is genuinely exercised on both sides.

const CHRISTMAS_EVENT = "event-christmas-2026";
const BIRTHDAY_EVENT = "event-paige-birthday-2027";

function familyFixture() {
  return {
    // Renamed to `events` by migration 025. Same ids, same names, same rows.
    christmas_events: [
      { id: CHRISTMAS_EVENT, year: 2026, name: "Christmas 2026", created_at: "2026-01-01T00:00:00Z" },
    ],

    // Global. One Paige, forever.
    people: [
      { id: "person-taylor", name: "Taylor" },
      { id: "person-jade", name: "Jade" },
      { id: "person-kirsten", name: "Kirsten" },
      { id: "person-paige", name: "Paige" },
      { id: "person-mum", name: "Mum" },
      { id: "person-jaden", name: "Jaden" },
    ],

    contributors: [
      { id: "c-taylor", christmas_event_id: CHRISTMAS_EVENT, person_id: "person-taylor", active: true },
      { id: "c-jade", christmas_event_id: CHRISTMAS_EVENT, person_id: "person-jade", active: true },
      { id: "c-kirsten", christmas_event_id: CHRISTMAS_EVENT, person_id: "person-kirsten", active: true },
      { id: "c-paige", christmas_event_id: CHRISTMAS_EVENT, person_id: "person-paige", active: true },
    ],

    christmas_recipients: [
      { id: "r-mum", christmas_event_id: CHRISTMAS_EVENT, person_id: "person-mum", budget_pennies: 10_000, active: true },
      { id: "r-jaden", christmas_event_id: CHRISTMAS_EVENT, person_id: "person-jaden", budget_pennies: 6_000, active: true },
      { id: "r-paige", christmas_event_id: CHRISTMAS_EVENT, person_id: "person-paige", budget_pennies: 8_000, active: true },
    ],

    recipient_contributions: [
      { christmas_recipient_id: "r-mum", contributor_id: "c-taylor", planned_amount_pennies: 2_500 },
      { christmas_recipient_id: "r-mum", contributor_id: "c-jade", planned_amount_pennies: 2_500 },
      { christmas_recipient_id: "r-mum", contributor_id: "c-kirsten", planned_amount_pennies: 2_500 },
      { christmas_recipient_id: "r-mum", contributor_id: "c-paige", planned_amount_pennies: 2_500 },
      { christmas_recipient_id: "r-jaden", contributor_id: "c-taylor", planned_amount_pennies: 1_500 },
      { christmas_recipient_id: "r-jaden", contributor_id: "c-jade", planned_amount_pennies: 1_500 },
      { christmas_recipient_id: "r-jaden", contributor_id: "c-kirsten", planned_amount_pennies: 1_500 },
      { christmas_recipient_id: "r-jaden", contributor_id: "c-paige", planned_amount_pennies: 1_500 },
      { christmas_recipient_id: "r-paige", contributor_id: "c-taylor", planned_amount_pennies: 2_000 },
      { christmas_recipient_id: "r-paige", contributor_id: "c-jade", planned_amount_pennies: 2_000 },
      { christmas_recipient_id: "r-paige", contributor_id: "c-kirsten", planned_amount_pennies: 2_000 },
      { christmas_recipient_id: "r-paige", contributor_id: "c-paige", planned_amount_pennies: 2_000 },
    ],

    gift_ideas: [
      { id: "idea-slippers", christmas_recipient_id: "r-mum", title: "Slippers" },
      { id: "idea-lego", christmas_recipient_id: "r-jaden", title: "Lego set" },
    ],

    purchases: [
      { id: "p-perfume", christmas_recipient_id: "r-mum", description: "Perfume", actual_price_pennies: 4_500, checkout_payer_contributor_id: "c-taylor", purchase_date: "2026-11-02", deleted_at: null },
      { id: "p-lego", christmas_recipient_id: "r-jaden", description: "Lego set", actual_price_pennies: 3_000, checkout_payer_contributor_id: "c-jade", purchase_date: "2026-11-05", deleted_at: null },
      { id: "p-scarf", christmas_recipient_id: "r-paige", description: "Scarf", actual_price_pennies: 2_000, checkout_payer_contributor_id: "c-kirsten", purchase_date: "2026-11-09", deleted_at: null },
      // Voided. Must never reach a total or a balance.
      { id: "p-mistake", christmas_recipient_id: "r-mum", description: "Wrong item", actual_price_pennies: 9_999, checkout_payer_contributor_id: "c-taylor", purchase_date: "2026-11-10", deleted_at: "2026-11-11T10:00:00Z" },
    ],

    purchase_allocations: [
      { purchase_id: "p-perfume", contributor_id: "c-taylor", responsibility_pennies: 1_125 },
      { purchase_id: "p-perfume", contributor_id: "c-jade", responsibility_pennies: 1_125 },
      { purchase_id: "p-perfume", contributor_id: "c-kirsten", responsibility_pennies: 1_125 },
      { purchase_id: "p-perfume", contributor_id: "c-paige", responsibility_pennies: 1_125 },
      { purchase_id: "p-lego", contributor_id: "c-taylor", responsibility_pennies: 750 },
      { purchase_id: "p-lego", contributor_id: "c-jade", responsibility_pennies: 750 },
      { purchase_id: "p-lego", contributor_id: "c-kirsten", responsibility_pennies: 750 },
      { purchase_id: "p-lego", contributor_id: "c-paige", responsibility_pennies: 750 },
      { purchase_id: "p-scarf", contributor_id: "c-taylor", responsibility_pennies: 500 },
      { purchase_id: "p-scarf", contributor_id: "c-jade", responsibility_pennies: 500 },
      { purchase_id: "p-scarf", contributor_id: "c-kirsten", responsibility_pennies: 500 },
      { purchase_id: "p-scarf", contributor_id: "c-paige", responsibility_pennies: 500 },
      { purchase_id: "p-mistake", contributor_id: "c-jade", responsibility_pennies: 9_999 },
    ],

    settlements: [
      // Confirmed in full.
      { id: "s-jade-taylor", christmas_event_id: CHRISTMAS_EVENT, payer_contributor_id: "c-jade", payee_contributor_id: "c-taylor", amount_pennies: 1_125, confirmed_amount_pennies: 1_125, voided_at: null },
      // Part of it arrived.
      { id: "s-kirsten-taylor", christmas_event_id: CHRISTMAS_EVENT, payer_contributor_id: "c-kirsten", payee_contributor_id: "c-taylor", amount_pennies: 1_125, confirmed_amount_pennies: 500, voided_at: null },
      // Claimed, then refused.
      { id: "s-paige-taylor", christmas_event_id: CHRISTMAS_EVENT, payer_contributor_id: "c-paige", payee_contributor_id: "c-taylor", amount_pennies: 1_125, confirmed_amount_pennies: 0, voided_at: null },
      // Confirmed, then voided by an admin. Its money returns to the balance.
      { id: "s-paige-jade", christmas_event_id: CHRISTMAS_EVENT, payer_contributor_id: "c-paige", payee_contributor_id: "c-jade", amount_pennies: 750, confirmed_amount_pennies: 750, voided_at: "2026-12-01T09:00:00Z" },
    ],

    payment_receipts: [
      { id: "receipt-1", settlement_id: "s-jade-taylor", christmas_event_id: CHRISTMAS_EVENT, action: "confirm", amount_pennies: 1_125 },
      { id: "receipt-2", settlement_id: "s-kirsten-taylor", christmas_event_id: CHRISTMAS_EVENT, action: "confirm", amount_pennies: 500 },
      { id: "receipt-3", settlement_id: "s-paige-taylor", christmas_event_id: CHRISTMAS_EVENT, action: "reject", amount_pennies: 1_125 },
    ],
  };
}

/**
 * Paige's Birthday, added to an existing family.
 *
 * Same people. New event, new participation rows, new money. Paige is the
 * recipient and is deliberately not a contributor to her own birthday.
 */
function addPaigesBirthday(db) {
  db.events.push({
    id: BIRTHDAY_EVENT,
    year: null,
    name: "Paige's Birthday",
    event_type: "birthday",
    event_date: "2027-03-14",
    status: "active",
    celebrant_person_id: "person-paige",
    description: null,
    created_at: "2027-01-04T00:00:00Z",
  });
  db.contributors.push(
    { id: "b-taylor", christmas_event_id: BIRTHDAY_EVENT, person_id: "person-taylor", active: true },
    { id: "b-jade", christmas_event_id: BIRTHDAY_EVENT, person_id: "person-jade", active: true },
    { id: "b-kirsten", christmas_event_id: BIRTHDAY_EVENT, person_id: "person-kirsten", active: true },
  );
  db.christmas_recipients.push(
    { id: "rb-paige", christmas_event_id: BIRTHDAY_EVENT, person_id: "person-paige", budget_pennies: 10_000, active: true },
  );
  db.recipient_contributions.push(
    { christmas_recipient_id: "rb-paige", contributor_id: "b-taylor", planned_amount_pennies: 4_000 },
    { christmas_recipient_id: "rb-paige", contributor_id: "b-jade", planned_amount_pennies: 3_000 },
    { christmas_recipient_id: "rb-paige", contributor_id: "b-kirsten", planned_amount_pennies: 3_000 },
  );
  db.gift_ideas.push({ id: "idea-bracelet", christmas_recipient_id: "rb-paige", title: "Pandora bracelet" });
  db.purchases.push({
    id: "b-perfume",
    christmas_recipient_id: "rb-paige",
    description: "Perfume",
    actual_price_pennies: 4_500,
    checkout_payer_contributor_id: "b-jade",
    purchase_date: "2027-03-01",
    deleted_at: null,
  });
  db.purchase_allocations.push(
    { purchase_id: "b-perfume", contributor_id: "b-taylor", responsibility_pennies: 1_500 },
    { purchase_id: "b-perfume", contributor_id: "b-jade", responsibility_pennies: 1_500 },
    { purchase_id: "b-perfume", contributor_id: "b-kirsten", responsibility_pennies: 1_500 },
  );
  db.settlements.push({
    id: "sb-taylor-jade",
    christmas_event_id: BIRTHDAY_EVENT,
    payer_contributor_id: "b-taylor",
    payee_contributor_id: "b-jade",
    amount_pennies: 1_500,
    confirmed_amount_pennies: 1_500,
    voided_at: null,
  });
  db.payment_receipts.push({
    id: "receipt-b1",
    settlement_id: "sb-taylor-jade",
    christmas_event_id: BIRTHDAY_EVENT,
    action: "confirm",
    amount_pennies: 1_500,
  });
  return db;
}

// ---------------------------------------------------------------------------
// The migration, as the application sees it
// ---------------------------------------------------------------------------

/**
 * `christmas_events` becomes `events`, generalised in place.
 *
 * Every id is carried across unchanged, which is the whole reason no financial
 * row moves: the `christmas_event_id` on every contributor, recipient, payment
 * and receipt still points at the same row. This models the rename and the
 * backfill and nothing else — and the assertion below is that every financial
 * table comes out the far side as the very same object.
 */
function generaliseChristmasIntoEvents(before) {
  const after = { ...before };
  after.events = before.christmas_events.map((row) => ({
    id: row.id,
    year: row.year,
    name: row.name,
    created_at: row.created_at,
    event_type: "christmas",
    event_date: `${row.year}-12-25`,
    status: "active",
    celebrant_person_id: null,
    description: null,
  }));
  delete after.christmas_events;
  return after;
}

/** The compatibility view: Christmas-type rows only. */
function christmasEventsView(db) {
  return db.events
    .filter((row) => row.event_type === "christmas")
    .map((row) => ({ id: row.id, year: row.year, name: row.name, created_at: row.created_at }));
}

// ---------------------------------------------------------------------------
// The loader, mirroring the application's own queries
// ---------------------------------------------------------------------------

function loadEventScope(db, eventId) {
  const contributors = db.contributors.filter((row) => row.christmas_event_id === eventId);
  const contributorIds = new Set(contributors.map((row) => row.id));
  const recipients = db.christmas_recipients.filter((row) => row.christmas_event_id === eventId);
  const recipientIds = new Set(recipients.map((row) => row.id));

  const purchases = db.purchases.filter(
    (row) => recipientIds.has(row.christmas_recipient_id) && row.deleted_at === null,
  );
  const purchaseIds = new Set(purchases.map((row) => row.id));
  const payerByPurchase = new Map(purchases.map((row) => [row.id, row.checkout_payer_contributor_id]));

  const allocations = db.purchase_allocations.filter((row) => purchaseIds.has(row.purchase_id));
  const settlements = db.settlements.filter((row) => row.christmas_event_id === eventId);
  const receipts = db.payment_receipts.filter((row) => row.christmas_event_id === eventId);
  const giftIdeas = db.gift_ideas.filter((row) => recipientIds.has(row.christmas_recipient_id));
  const contributions = db.recipient_contributions.filter((row) => recipientIds.has(row.christmas_recipient_id));

  const obligations = allocations.flatMap((allocation) => {
    const payer = payerByPurchase.get(allocation.purchase_id);
    if (!payer || allocation.responsibility_pennies <= 0 || allocation.contributor_id === payer) return [];
    return [{
      debtorContributorId: allocation.contributor_id,
      creditorContributorId: payer,
      amountPennies: allocation.responsibility_pennies,
    }];
  });

  const ledger = settlements.map((row) => ({
    payerContributorId: row.payer_contributor_id,
    payeeContributorId: row.payee_contributor_id,
    amountPennies: row.amount_pennies,
    confirmedAmountPennies: row.confirmed_amount_pennies,
    voidedAt: row.voided_at,
  }));

  return {
    contributorIds: [...contributorIds].sort(),
    recipientIds: [...recipientIds].sort(),
    recipientCount: recipients.length,
    contributorCount: contributors.length,
    giftIdeaCount: giftIdeas.length,
    purchaseCount: purchases.length,
    allocationCount: allocations.length,
    settlementCount: settlements.length,
    receiptCount: receipts.length,
    budgetPennies: recipients.filter((row) => row.active).reduce((sum, row) => sum + row.budget_pennies, 0),
    spentPennies: purchases.reduce((sum, row) => sum + row.actual_price_pennies, 0),
    plannedPennies: contributions.reduce((sum, row) => sum + row.planned_amount_pennies, 0),
    allocatedPennies: allocations.reduce((sum, row) => sum + row.responsibility_pennies, 0),
    confirmedPennies: settlements
      .filter((row) => row.voided_at === null)
      .reduce((sum, row) => sum + row.confirmed_amount_pennies, 0),
    balances: calculateNetOwedBalances(obligations, ledger),
  };
}

// ---------------------------------------------------------------------------
// 1. The generalisation changes nothing
// ---------------------------------------------------------------------------

test("Christmas reads identically before and after the Event generalisation", () => {
  const before = familyFixture();
  const christmasBefore = loadEventScope(before, CHRISTMAS_EVENT);

  const after = generaliseChristmasIntoEvents(before);
  const christmasAfter = loadEventScope(after, CHRISTMAS_EVENT);

  assert.deepEqual(christmasAfter, christmasBefore);
  assert.equal(christmasAfter.spentPennies, 9_500);
  assert.equal(christmasAfter.budgetPennies, 24_000);
  assert.equal(christmasAfter.confirmedPennies, 1_625);
});

test("the generalisation touches no financial table at all", () => {
  const before = familyFixture();
  const after = generaliseChristmasIntoEvents(before);

  // Not "equal" — the SAME arrays. A migration that rebuilt any of these would
  // be doing something this one promises never to do.
  for (const table of [
    "people", "contributors", "christmas_recipients", "recipient_contributions",
    "gift_ideas", "purchases", "purchase_allocations", "settlements", "payment_receipts",
  ]) {
    assert.equal(after[table], before[table], `${table} must be carried across untouched`);
  }

  // And the event keeps its identity, which is why every christmas_event_id
  // still resolves.
  assert.equal(after.events[0].id, CHRISTMAS_EVENT);
  assert.equal(after.events[0].year, 2026);
  assert.equal(after.events[0].name, "Christmas 2026");
  assert.equal(after.events[0].event_type, "christmas");
  assert.equal(after.events[0].event_date, "2026-12-25");
});

// ---------------------------------------------------------------------------
// 2. A second event cannot reach the first
// ---------------------------------------------------------------------------

test("adding Paige's Birthday moves nothing in Christmas, to the penny", () => {
  const christmasOnly = loadEventScope(generaliseChristmasIntoEvents(familyFixture()), CHRISTMAS_EVENT);

  const twoEvents = addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture()));
  const christmasWithBirthday = loadEventScope(twoEvents, CHRISTMAS_EVENT);

  assert.deepEqual(christmasWithBirthday, christmasOnly);
});

test("the birthday's own figures contain birthday data and nothing else", () => {
  const db = addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture()));
  const birthday = loadEventScope(db, BIRTHDAY_EVENT);

  assert.equal(birthday.spentPennies, 4_500, "£45 of perfume, and no Christmas spend");
  assert.equal(birthday.budgetPennies, 10_000);
  assert.equal(birthday.recipientCount, 1, "only Paige receives at her own birthday");
  assert.equal(birthday.contributorCount, 3, "Paige does not chip in for her own present");
  assert.equal(birthday.purchaseCount, 1);
  assert.equal(birthday.giftIdeaCount, 1);
  assert.equal(birthday.settlementCount, 1);

  // Not one Christmas contributor or recipient id appears anywhere in it.
  for (const id of [...birthday.contributorIds, ...birthday.recipientIds]) {
    assert.ok(id.startsWith("b-") || id.startsWith("rb-"), `${id} is not a birthday row`);
  }
  for (const balance of birthday.balances) {
    assert.ok(balance.debtorContributorId.startsWith("b-"));
    assert.ok(balance.creditorContributorId.startsWith("b-"));
  }
});

test("a £45 birthday purchase never reaches Christmas spend, Christmas Owed or the Christmas Payment Log", () => {
  const db = addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture()));
  const christmas = loadEventScope(db, CHRISTMAS_EVENT);

  assert.equal(christmas.spentPennies, 9_500);
  assert.equal(christmas.purchaseCount, 3);
  assert.equal(christmas.settlementCount, 4);
  assert.equal(christmas.receiptCount, 3);
  assert.equal(christmas.giftIdeaCount, 2, "the Pandora bracelet belongs to the birthday");
  assert.equal(christmas.allocatedPennies, 9_500);
  assert.equal(christmas.plannedPennies, 24_000);
  assert.ok(!christmas.balances.some((balance) =>
    balance.debtorContributorId.startsWith("b-") || balance.creditorContributorId.startsWith("b-"),
  ));
});

test("the two events produce completely separate balances from the same real engine", () => {
  const db = addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture()));

  // Taylor paid £45 for Mum; Jade paid £30 for Jaden; Kirsten paid £20 for
  // Paige. Then Jade confirmed-paid Taylor £11.25, Kirsten £5 of her £11.25,
  // and Paige's claim to Taylor was refused. The £7.50 Paige paid Jade was
  // voided by an admin, so it is back on her balance.
  //
  // Stated one balance at a time, so a change is legible rather than a wall of
  // rearranged strings.
  const christmas = new Map(
    loadEventScope(db, CHRISTMAS_EVENT).balances.map((balance) => [
      `${balance.debtorContributorId}->${balance.creditorContributorId}`,
      balance.amountPennies,
    ]),
  );
  assert.equal(christmas.get("c-taylor->c-jade"), 750);
  assert.equal(christmas.get("c-kirsten->c-taylor"), 125);
  assert.equal(christmas.get("c-paige->c-taylor"), 1_125);
  assert.equal(christmas.get("c-kirsten->c-jade"), 250);
  assert.equal(christmas.get("c-paige->c-jade"), 750);
  assert.equal(christmas.get("c-paige->c-kirsten"), 500);
  assert.equal(christmas.size, 6);

  const birthday = new Map(
    loadEventScope(db, BIRTHDAY_EVENT).balances.map((balance) => [
      `${balance.debtorContributorId}->${balance.creditorContributorId}`,
      balance.amountPennies,
    ]),
  );
  assert.equal(birthday.get("b-kirsten->b-jade"), 1_500);
  assert.equal(birthday.size, 1, "Taylor confirmed-paid his £15, so that pair is settled");
});

test("one person's summary is per event, and the two do not add themselves together", () => {
  const db = addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture()));

  const christmasPaige = contributorOwedSummary(loadEventScope(db, CHRISTMAS_EVENT).balances, "c-paige");
  assert.deepEqual(christmasPaige, { owedToYouPennies: 0, youOwePennies: 2_375 });

  const birthdayJade = contributorOwedSummary(loadEventScope(db, BIRTHDAY_EVENT).balances, "b-jade");
  assert.deepEqual(birthdayJade, { owedToYouPennies: 1_500, youOwePennies: 0 });

  // Jade's Christmas contributor id has no standing in the birthday at all,
  // which is what stops one event's balance leaking into another's screen.
  assert.deepEqual(
    contributorOwedSummary(loadEventScope(db, BIRTHDAY_EVENT).balances, "c-jade"),
    { owedToYouPennies: 0, youOwePennies: 0 },
  );
});

test("a family-wide balance is the sum of the events, and is derived rather than stored", () => {
  // Designed for, not yet built: the eventual "Jade owes Taylor £50 overall,
  // £30 Christmas and £20 birthday" view. This asserts the shape it will take
  // — a fold over per-event balances — so nobody is tempted to add a second
  // ledger to produce it.
  const db = addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture()));
  const perEvent = [CHRISTMAS_EVENT, BIRTHDAY_EVENT].map((eventId) => loadEventScope(db, eventId));

  const totalObligations = perEvent.reduce((sum, scope) => sum + scope.allocatedPennies, 0);
  assert.equal(totalObligations, 9_500 + 4_500);

  const everyBalance = perEvent.flatMap((scope) => scope.balances);
  assert.equal(everyBalance.length, 7, "six Christmas balances and one birthday balance");
  assert.equal(
    everyBalance.reduce((sum, balance) => sum + balance.amountPennies, 0),
    750 + 125 + 1_125 + 250 + 750 + 500 + 1_500,
  );
});

// ---------------------------------------------------------------------------
// 3. The compatibility view
// ---------------------------------------------------------------------------

test("the existing lookups still find Christmas, and can never find a birthday", () => {
  const db = addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture()));
  const view = christmasEventsView(db);

  // `family-context.tsx`, `page.tsx`, `people/page.tsx`, `purchase-form.tsx`,
  // `owed-data.ts`, `payment-log-server.ts` and `notification-dispatch.ts` all
  // ask this exact question.
  const byYear = view.filter((row) => row.year === 2026);
  assert.equal(byYear.length, 1);
  assert.equal(byYear[0].id, CHRISTMAS_EVENT);

  // The Family Access route asks a different one: the latest Christmas. A null
  // year sorts FIRST under a descending order in Postgres, so a birthday inside
  // this view would have hijacked it. It is not in the view.
  const latest = [...view].sort((left, right) => right.year - left.year)[0];
  assert.equal(latest.id, CHRISTMAS_EVENT);
  assert.equal(view.some((row) => row.id === BIRTHDAY_EVENT), false);
  assert.equal(view.every((row) => typeof row.year === "number"), true);
});

test("a second Christmas is still one per year, and does not disturb the first", () => {
  const db = addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture()));
  db.events.push({
    id: "event-christmas-2027",
    year: 2027,
    name: "Christmas 2027",
    event_type: "christmas",
    event_date: "2027-12-25",
    status: "active",
    celebrant_person_id: null,
    description: null,
    created_at: "2027-01-01T00:00:00Z",
  });

  const view = christmasEventsView(db);
  assert.equal(view.filter((row) => row.year === 2026).length, 1);
  assert.equal(view.filter((row) => row.year === 2027).length, 1);
  assert.deepEqual(
    loadEventScope(db, CHRISTMAS_EVENT),
    loadEventScope(addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture())), CHRISTMAS_EVENT),
  );
  // A brand new Christmas has nothing in it, which is the correct starting
  // point rather than an inherited copy of last year's money.
  const next = loadEventScope(db, "event-christmas-2027");
  assert.equal(next.spentPennies, 0);
  assert.equal(next.balances.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Ownership survives
// ---------------------------------------------------------------------------

test("every row still belongs to the event it belonged to before", () => {
  const before = familyFixture();
  const ownershipBefore = ownership(before, CHRISTMAS_EVENT);

  const db = addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture()));
  const ownershipAfter = ownership(db, CHRISTMAS_EVENT);

  assert.deepEqual(ownershipAfter, ownershipBefore);
  assert.deepEqual(ownershipAfter.giftIdeaIds, ["idea-lego", "idea-slippers"]);
  assert.deepEqual(ownershipAfter.purchaseIds, ["p-lego", "p-mistake", "p-perfume", "p-scarf"]);
});

test("people are global: the same Paige is a Christmas recipient and the birthday celebrant", () => {
  const db = addPaigesBirthday(generaliseChristmasIntoEvents(familyFixture()));

  const paigeRows = db.christmas_recipients.filter((row) => row.person_id === "person-paige");
  assert.equal(paigeRows.length, 2, "two participations");
  assert.equal(new Set(paigeRows.map((row) => row.person_id)).size, 1, "one person");
  assert.equal(db.people.filter((row) => row.name === "Paige").length, 1, "never a second Paige row");

  // And her participation differs per event, which is the point of keeping the
  // budget on the participation rather than on the person.
  assert.deepEqual(
    paigeRows.map((row) => [row.christmas_event_id, row.budget_pennies]).sort(),
    [[BIRTHDAY_EVENT, 10_000], [CHRISTMAS_EVENT, 8_000]].sort(),
  );

  assert.equal(
    db.events.find((row) => row.id === BIRTHDAY_EVENT).celebrant_person_id,
    db.people.find((row) => row.name === "Paige").id,
  );
});

function ownership(db, eventId) {
  const recipientIds = new Set(
    db.christmas_recipients.filter((row) => row.christmas_event_id === eventId).map((row) => row.id),
  );
  const purchaseIds = db.purchases
    .filter((row) => recipientIds.has(row.christmas_recipient_id))
    .map((row) => row.id)
    .sort();
  return {
    recipientIds: [...recipientIds].sort(),
    contributorIds: db.contributors
      .filter((row) => row.christmas_event_id === eventId)
      .map((row) => row.id)
      .sort(),
    giftIdeaIds: db.gift_ideas
      .filter((row) => recipientIds.has(row.christmas_recipient_id))
      .map((row) => row.id)
      .sort(),
    purchaseIds,
    allocationKeys: db.purchase_allocations
      .filter((row) => purchaseIds.includes(row.purchase_id))
      .map((row) => `${row.purchase_id}:${row.contributor_id}:${row.responsibility_pennies}`)
      .sort(),
    settlementIds: db.settlements
      .filter((row) => row.christmas_event_id === eventId)
      .map((row) => row.id)
      .sort(),
  };
}
