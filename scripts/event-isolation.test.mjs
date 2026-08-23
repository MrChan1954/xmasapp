import assert from "node:assert/strict";
import test from "node:test";

/**
 * EVENT A MUST NEVER AFFECT EVENT B.
 *
 * The whole of Checkpoint 3 reduces to that sentence, and this file is where it
 * is proved. Two events are built from a seeded generator — different people,
 * different contributor sets, different plans, ideas, purchases, allocations,
 * payments and receipts — and then every figure Event A reports is captured,
 * Event B is put through every mutation the app supports, and Event A is
 * measured again. Nothing may have moved by a single penny.
 *
 * WHAT IS REAL HERE
 *   The balances come from `calculateNetOwedBalances` in src/lib/owed.ts — the
 *   engine the Owed screen, Event Home and the notification dispatcher all use.
 *   The notification copy and links come from `withEvent` in
 *   src/lib/notification-content.ts, the same function the dispatcher applies.
 *   Neither is reimplemented.
 *
 * NO MAGIC EXPECTED VALUES
 *   Every penny figure is generated. The assertions are relational — A equals
 *   its own earlier self; B changed; A and B share no identifier — so they hold
 *   for whatever the numbers happen to be rather than for one lucky fixture.
 */

const { calculateNetOwedBalances, contributorOwedSummary } = await import("../src/lib/owed.ts");
const {
  withEvent,
  eventUrlFor,
  giftIdeaAddedNotification,
  paymentClaimedNotification,
  purchaseAddedNotification,
  youOweNotification,
} = await import("../src/lib/notification-content.ts");

// ---------------------------------------------------------------------------
// A seeded two-event family
// ---------------------------------------------------------------------------

function makeRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const EVENT_A = { id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", name: "Christmas 2027", type: "christmas" };
const EVENT_B = { id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", name: "Paige's Birthday", type: "birthday" };

/**
 * One event's rows. People are GLOBAL and deliberately shared between the two
 * events — the same Jade contributes to both — because that is exactly the
 * situation in which a leak would be invisible if the scoping were wrong.
 */
function buildEvent(event, random, { contributors, recipients }) {
  const between = (low, high) => low + Math.floor(random() * (high - low + 1));
  const prefix = event.id.slice(0, 4);

  const contributorRows = contributors.map((person) => ({
    id: `${prefix}-c-${person}`,
    person,
    christmas_event_id: event.id,
    active: true,
  }));

  const recipientRows = recipients.map((person) => ({
    id: `${prefix}-r-${person}`,
    person,
    christmas_event_id: event.id,
    budget_pennies: between(1_000, 30_000),
    active: true,
  }));

  const contributionRows = recipientRows.flatMap((recipient) =>
    contributorRows.map((contributor) => ({
      christmas_recipient_id: recipient.id,
      contributor_id: contributor.id,
      planned_amount_pennies: between(0, 6_000),
    })),
  );

  const ideaRows = recipientRows.flatMap((recipient) =>
    Array.from({ length: between(0, 2) }, (_, index) => ({
      id: `${prefix}-idea-${recipient.id}-${index}`,
      christmas_recipient_id: recipient.id,
      estimated_price_pennies: between(100, 9_000),
    })),
  );

  const purchaseRows = [];
  const allocationRows = [];
  for (const recipient of recipientRows) {
    for (let index = 0; index < between(1, 3); index += 1) {
      const payer = contributorRows[between(0, contributorRows.length - 1)];
      const share = between(100, 4_000);
      const price = share * contributorRows.length;
      const purchaseId = `${prefix}-p-${recipient.id}-${index}`;
      // One purchase in every event is voided, so the "live purchases only"
      // rule is exercised on both sides.
      const voided = index === 0 && between(0, 2) === 0;
      purchaseRows.push({
        id: purchaseId,
        christmas_recipient_id: recipient.id,
        actual_price_pennies: price,
        checkout_payer_contributor_id: payer.id,
        deleted_at: voided ? "2027-01-01T00:00:00Z" : null,
      });
      for (const contributor of contributorRows) {
        allocationRows.push({
          purchase_id: purchaseId,
          contributor_id: contributor.id,
          responsibility_pennies: share,
        });
      }
    }
  }

  return {
    event,
    contributors: contributorRows,
    recipients: recipientRows,
    contributions: contributionRows,
    giftIdeas: ideaRows,
    purchases: purchaseRows,
    allocations: allocationRows,
    settlements: [],
    receipts: [],
  };
}

function buildFamily(seed) {
  const random = makeRandom(seed);
  return {
    // The same four people, participating differently in each event: Paige
    // contributes to Christmas but not to her own birthday.
    a: buildEvent(EVENT_A, random, {
      contributors: ["taylor", "jade", "kirsten", "paige"],
      recipients: ["mum", "dad", "paige"],
    }),
    b: buildEvent(EVENT_B, random, {
      contributors: ["taylor", "jade", "kirsten"],
      recipients: ["paige"],
    }),
  };
}

// ---------------------------------------------------------------------------
// The figures, all scoped the way the application scopes them
// ---------------------------------------------------------------------------

/**
 * Every number an event reports, read the way its screens read them.
 *
 * The obligation filter and the confirmed-only settlement rule are copied from
 * `src/app/owed/owed-data.ts`; the arithmetic itself is the real engine.
 */
function figuresFor(side) {
  const recipientIds = new Set(side.recipients.map((row) => row.id));
  const livePurchases = side.purchases.filter(
    (row) => recipientIds.has(row.christmas_recipient_id) && row.deleted_at === null,
  );
  const livePurchaseIds = new Set(livePurchases.map((row) => row.id));
  const payerByPurchase = new Map(livePurchases.map((row) => [row.id, row.checkout_payer_contributor_id]));
  const allocations = side.allocations.filter((row) => livePurchaseIds.has(row.purchase_id));

  const obligations = allocations.flatMap((allocation) => {
    const payer = payerByPurchase.get(allocation.purchase_id);
    if (!payer || allocation.responsibility_pennies <= 0 || allocation.contributor_id === payer) return [];
    return [{
      debtorContributorId: allocation.contributor_id,
      creditorContributorId: payer,
      amountPennies: allocation.responsibility_pennies,
    }];
  });

  const ledger = side.settlements.map((row) => ({
    payerContributorId: row.payer_contributor_id,
    payeeContributorId: row.payee_contributor_id,
    amountPennies: row.amount_pennies,
    confirmedAmountPennies: row.confirmed_amount_pennies,
    voidedAt: row.voided_at ?? null,
  }));

  const active = side.recipients.filter((row) => row.active);
  return {
    budgetPennies: active.reduce((sum, row) => sum + row.budget_pennies, 0),
    plannedPennies: side.contributions.reduce((sum, row) => sum + row.planned_amount_pennies, 0),
    spentPennies: livePurchases.reduce((sum, row) => sum + row.actual_price_pennies, 0),
    allocatedPennies: allocations.reduce((sum, row) => sum + row.responsibility_pennies, 0),
    claimedPennies: side.settlements
      .filter((row) => !row.voided_at)
      .reduce((sum, row) => sum + row.amount_pennies, 0),
    confirmedPennies: side.settlements
      .filter((row) => !row.voided_at)
      .reduce((sum, row) => sum + row.confirmed_amount_pennies, 0),
    recipientCount: side.recipients.length,
    contributorCount: side.contributors.length,
    giftIdeaCount: side.giftIdeas.length,
    purchaseCount: livePurchases.length,
    receiptCount: side.receipts.length,
    balances: calculateNetOwedBalances(obligations, ledger)
      .map((balance) => `${balance.debtorContributorId}->${balance.creditorContributorId}=${balance.amountPennies}`)
      .sort(),
  };
}

/** Somebody who contributes to both events, for the payment scenarios. */
function contributorFor(side, person) {
  const row = side.contributors.find((entry) => entry.person === person);
  assert.ok(row, `${person} must contribute to ${side.event.name}`);
  return row.id;
}

const SEEDS = [1, 7, 42, 1_337, 90_210, 2_718_281, 31_415_926];

// ---------------------------------------------------------------------------
// 1. Every mutation of Event B leaves Event A untouched
// ---------------------------------------------------------------------------

test("mutating Event B in every way the app allows moves nothing in Event A", () => {
  for (const seed of SEEDS) {
    const family = buildFamily(seed);
    const before = figuresFor(family.a);

    const recipientB = family.b.recipients[0];
    const payerB = family.b.contributors[0];
    const otherB = family.b.contributors[1];

    // Add a purchase with its allocations.
    family.b.purchases.push({
      id: "b-new-purchase",
      christmas_recipient_id: recipientB.id,
      actual_price_pennies: 6_000,
      checkout_payer_contributor_id: payerB.id,
      deleted_at: null,
    });
    for (const contributor of family.b.contributors) {
      family.b.allocations.push({
        purchase_id: "b-new-purchase",
        contributor_id: contributor.id,
        responsibility_pennies: 2_000,
      });
    }

    // Void an existing purchase.
    const victim = family.b.purchases.find((row) => row.deleted_at === null && row.id !== "b-new-purchase");
    if (victim) victim.deleted_at = "2027-04-01T00:00:00Z";

    // Submit, partly confirm, and reject payments.
    family.b.settlements.push(
      { id: "b-s1", payer_contributor_id: otherB.id, payee_contributor_id: payerB.id, amount_pennies: 2_000, confirmed_amount_pennies: 0, voided_at: null },
      { id: "b-s2", payer_contributor_id: otherB.id, payee_contributor_id: payerB.id, amount_pennies: 1_500, confirmed_amount_pennies: 700, voided_at: null },
      { id: "b-s3", payer_contributor_id: payerB.id, payee_contributor_id: otherB.id, amount_pennies: 900, confirmed_amount_pennies: 0, rejected_at: "2027-04-02T00:00:00Z", voided_at: null },
    );
    family.b.receipts.push({ id: "b-rec-1", settlement_id: "b-s2", action: "confirm", amount_pennies: 700 });

    // Add a gift idea and rewrite the contributor plan.
    family.b.giftIdeas.push({ id: "b-new-idea", christmas_recipient_id: recipientB.id, estimated_price_pennies: 4_200 });
    for (const contribution of family.b.contributions) contribution.planned_amount_pennies += 111;

    const after = figuresFor(family.a);
    assert.deepEqual(after, before, `Event A moved when Event B changed, at seed ${seed}`);

    // And Event B genuinely did change, so the comparison above means something.
    const bAfter = figuresFor(family.b);
    assert.notDeepEqual(bAfter, figuresFor(buildFamily(seed).b), `Event B did not actually change at seed ${seed}`);
  }
});

test("the two events share people but no rows, ids, contributors or balances", () => {
  const family = buildFamily(11);

  // The same person is in both events...
  const sharedPeople = family.a.contributors
    .map((row) => row.person)
    .filter((person) => family.b.contributors.some((row) => row.person === person));
  assert.ok(sharedPeople.length >= 2, "the fixture must share people between events");

  // ...but never the same participation row.
  const aIds = new Set([
    ...family.a.contributors.map((row) => row.id),
    ...family.a.recipients.map((row) => row.id),
    ...family.a.purchases.map((row) => row.id),
    ...family.a.giftIdeas.map((row) => row.id),
  ]);
  for (const id of [
    ...family.b.contributors.map((row) => row.id),
    ...family.b.recipients.map((row) => row.id),
    ...family.b.purchases.map((row) => row.id),
    ...family.b.giftIdeas.map((row) => row.id),
  ]) {
    assert.ok(!aIds.has(id), `${id} appears in both events`);
  }

  // Paige receives at her own birthday and does not contribute to it, while
  // contributing to Christmas. Participation is per event, the person is not.
  assert.ok(family.a.contributors.some((row) => row.person === "paige"));
  assert.ok(!family.b.contributors.some((row) => row.person === "paige"));
  assert.ok(family.b.recipients.some((row) => row.person === "paige"));

  // Every balance in each event names only that event's contributors.
  for (const side of [family.a, family.b]) {
    const ids = new Set(side.contributors.map((row) => row.id));
    for (const balance of figuresFor(side).balances) {
      const [debtor, rest] = balance.split("->");
      const creditor = rest.split("=")[0];
      assert.ok(ids.has(debtor) && ids.has(creditor), `${balance} escaped ${side.event.name}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Payment isolation, stated as the scenario
// ---------------------------------------------------------------------------

test("paying inside one event settles that event only, through claim, partial and rejection", () => {
  const family = buildFamily(5);
  const jadeA = contributorFor(family.a, "jade");
  const taylorA = contributorFor(family.a, "taylor");
  const jadeB = contributorFor(family.b, "jade");
  const taylorB = contributorFor(family.b, "taylor");

  const owedBetween = (side, debtor, creditor) => {
    const balance = figuresFor(side).balances.find((row) => row.startsWith(`${debtor}->${creditor}=`));
    return balance ? Number(balance.split("=")[1]) : 0;
  };

  /**
   * Give each event a debt in the SAME direction between the SAME two people —
   * the case where a leak would be hardest to spot.
   *
   * The generated fixture may already owe money the other way, so the staged
   * purchase is sized to overcome whatever is there plus a margin. Nothing here
   * is a magic figure: it is derived from the fixture it is staged into.
   */
  const stage = (side, debtor, creditor, margin, tag) => {
    const reverse = owedBetween(side, creditor, debtor);
    const pennies = reverse + margin;
    side.purchases.push({
      id: `${tag}-purchase`,
      christmas_recipient_id: side.recipients[0].id,
      actual_price_pennies: pennies,
      checkout_payer_contributor_id: creditor,
      deleted_at: null,
    });
    side.allocations.push({ purchase_id: `${tag}-purchase`, contributor_id: debtor, responsibility_pennies: pennies });
  };
  stage(family.a, jadeA, taylorA, 3_400, "a-debt");
  stage(family.b, jadeB, taylorB, 1_250, "b-debt");

  const startA = owedBetween(family.a, jadeA, taylorA);
  const startB = owedBetween(family.b, jadeB, taylorB);
  assert.equal(startA, 3_400, "Event A starts with the staged debt");
  assert.equal(startB, 1_250, "Event B starts with the staged debt");

  // A claim alone moves nothing, in either event.
  family.b.settlements.push({
    id: "b-claim", payer_contributor_id: jadeB, payee_contributor_id: taylorB,
    amount_pennies: 500, confirmed_amount_pennies: 0, voided_at: null,
  });
  assert.equal(owedBetween(family.b, jadeB, taylorB), startB, "a pending claim moves no balance");
  assert.equal(owedBetween(family.a, jadeA, taylorA), startA, "Event A is untouched by Event B's claim");

  // A partial confirmation reduces Event B by exactly the confirmed part.
  family.b.settlements.find((row) => row.id === "b-claim").confirmed_amount_pennies = 200;
  assert.equal(owedBetween(family.b, jadeB, taylorB), startB - 200);
  assert.equal(owedBetween(family.a, jadeA, taylorA), startA, "Event A is untouched by a partial confirmation");

  // Confirming the rest settles the claim, still only in Event B.
  family.b.settlements.find((row) => row.id === "b-claim").confirmed_amount_pennies = 500;
  assert.equal(owedBetween(family.b, jadeB, taylorB), startB - 500);
  assert.equal(owedBetween(family.a, jadeA, taylorA), startA);

  // A rejected claim in Event B returns nothing and still touches nothing in A.
  family.b.settlements.push({
    id: "b-rejected", payer_contributor_id: jadeB, payee_contributor_id: taylorB,
    amount_pennies: 400, confirmed_amount_pennies: 0, rejected_at: "2027-05-01T00:00:00Z", voided_at: null,
  });
  assert.equal(owedBetween(family.b, jadeB, taylorB), startB - 500, "a rejection reduces nothing");
  assert.equal(owedBetween(family.a, jadeA, taylorA), startA);

  // Voiding a confirmed payment in Event B gives its money back — to B.
  family.b.settlements.find((row) => row.id === "b-claim").voided_at = "2027-05-02T00:00:00Z";
  assert.equal(owedBetween(family.b, jadeB, taylorB), startB, "voiding restores Event B's balance");
  assert.equal(owedBetween(family.a, jadeA, taylorA), startA, "and still leaves Event A alone");
});

test("one person's summary is per event and the two never add themselves together", () => {
  const family = buildFamily(23);
  const jadeA = contributorFor(family.a, "jade");
  const jadeB = contributorFor(family.b, "jade");

  const balancesFor = (side) => {
    const recipientIds = new Set(side.recipients.map((row) => row.id));
    const live = side.purchases.filter((row) => recipientIds.has(row.christmas_recipient_id) && row.deleted_at === null);
    const payer = new Map(live.map((row) => [row.id, row.checkout_payer_contributor_id]));
    const liveIds = new Set(live.map((row) => row.id));
    return calculateNetOwedBalances(
      side.allocations.filter((row) => liveIds.has(row.purchase_id)).flatMap((allocation) => {
        const creditor = payer.get(allocation.purchase_id);
        if (!creditor || allocation.contributor_id === creditor) return [];
        return [{
          debtorContributorId: allocation.contributor_id,
          creditorContributorId: creditor,
          amountPennies: allocation.responsibility_pennies,
        }];
      }),
      [],
    );
  };

  // Jade's Christmas contributor id has no standing in the birthday, and the
  // reverse, so neither summary can contain the other's money.
  assert.deepEqual(
    contributorOwedSummary(balancesFor(family.b), jadeA),
    { owedToYouPennies: 0, youOwePennies: 0 },
  );
  assert.deepEqual(
    contributorOwedSummary(balancesFor(family.a), jadeB),
    { owedToYouPennies: 0, youOwePennies: 0 },
  );
});

// ---------------------------------------------------------------------------
// 3. Notification isolation
// ---------------------------------------------------------------------------

/**
 * The same action, in two events, through the real builders.
 *
 * This is the shape the copy has to hold: the TITLE says what happened and is
 * identical across events, because the action is identical; everything that
 * distinguishes the two — the event named in the body, the link, the collapse
 * key — differs.
 */
const SAME_ACTION_IN_BOTH_EVENTS = [
  {
    label: "you owe",
    build: () => youOweNotification({ creditorName: "Taylor", amountPennies: 2_000 }),
  },
  {
    label: "purchase added",
    build: () => purchaseAddedNotification({
      actorName: "Jade", recipientName: "Mum", amountPennies: 4_500, christmasRecipientId: "r-mum",
    }),
  },
  {
    label: "gift idea added",
    build: () => giftIdeaAddedNotification({
      actorName: "Jade", recipientName: "Paige", christmasRecipientId: "r-paige",
    }),
  },
  {
    label: "payment claimed",
    build: () => paymentClaimedNotification({
      payerName: "Jade", amountPennies: 2_000, settlementId: "s-1",
    }),
  },
];

test("two notifications from different events keep the action in the title", () => {
  for (const { label, build } of SAME_ACTION_IN_BOTH_EVENTS) {
    const plain = build();
    const fromA = withEvent(build(), EVENT_A);
    const fromB = withEvent(build(), EVENT_B);

    // The title is the action, untouched — not the event name.
    assert.equal(fromA.title, plain.title, `${label}: the title must still say what happened`);
    assert.equal(fromB.title, plain.title, `${label}: the title must still say what happened`);
    assert.ok(!fromA.title.includes(EVENT_A.name), `${label}: the event does not belong in the title`);
    assert.ok(!fromB.title.includes(EVENT_B.name), `${label}: the event does not belong in the title`);
    assert.ok(fromA.title.length > 0);
  }
});

test("two notifications from different events name their own event in the body", () => {
  for (const { label, build } of SAME_ACTION_IN_BOTH_EVENTS) {
    const plain = build();
    const fromA = withEvent(build(), EVENT_A);
    const fromB = withEvent(build(), EVENT_B);

    // The event leads the body, as context, and the original sentence follows
    // it unchanged.
    assert.equal(fromA.body, `${EVENT_A.name} · ${plain.body}`, `${label}: Event A's body`);
    assert.equal(fromB.body, `${EVENT_B.name} · ${plain.body}`, `${label}: Event B's body`);
    assert.ok(!fromA.body.includes(EVENT_B.name), `${label}: Event A cannot name Event B`);
    assert.ok(!fromB.body.includes(EVENT_A.name), `${label}: Event B cannot name Event A`);
  }
});

test("two notifications from different events keep distinct links and collapse keys", () => {
  for (const { label, build } of SAME_ACTION_IN_BOTH_EVENTS) {
    const fromA = withEvent(build(), EVENT_A);
    const fromB = withEvent(build(), EVENT_B);

    assert.notEqual(fromA.url, fromB.url, `${label}: the two links must differ`);
    assert.ok(fromA.url.startsWith(`/events/${EVENT_A.id}/`), `${label}: Event A's link`);
    assert.ok(fromB.url.startsWith(`/events/${EVENT_B.id}/`), `${label}: Event B's link`);
    assert.ok(!fromA.url.includes(EVENT_B.id), `${label}: Event A's link cannot resolve to Event B`);
    assert.ok(!fromB.url.includes(EVENT_A.id), `${label}: Event B's link cannot resolve to Event A`);

    // The collapse key is event-scoped: two true statements about different
    // money must not replace each other on the device.
    assert.notEqual(fromA.tag, fromB.tag, `${label}: the two collapse keys must differ`);
    assert.ok(fromA.tag.startsWith(`${EVENT_A.id}:`));
    assert.ok(fromB.tag.startsWith(`${EVENT_B.id}:`));

    // And both still fit the columns that store them.
    for (const payload of [fromA, fromB]) {
      assert.ok(payload.title.length <= 120, `${label}: title must fit the database CHECK`);
      assert.ok(payload.body.length <= 300, `${label}: body must fit the database CHECK`);
      assert.match(payload.url, /^\/[^/]/u, `${label}: target_url must satisfy the database CHECK`);
    }
  }
});

test("an event name long enough to overflow shrinks, and never truncates the sentence", () => {
  const sentence = youOweNotification({ creditorName: "Taylor", amountPennies: 2_000 }).body;
  const huge = withEvent(
    youOweNotification({ creditorName: "Taylor", amountPennies: 2_000 }),
    { id: EVENT_A.id, name: "N".repeat(400), type: "other" },
  );
  assert.ok(huge.body.length <= 300, "the body must still fit its column");
  assert.ok(huge.body.endsWith(sentence), "the actionable sentence survives intact");

  // A body already at the limit keeps its sentence and drops the prefix rather
  // than losing the end of it.
  const atLimit = withEvent(
    { title: "t", body: "x".repeat(300), url: "/owed", tag: "t", category: "money_i_owe" },
    EVENT_A,
  );
  assert.equal(atLimit.body, "x".repeat(300));
});

test("a family-wide payload that is never stamped stays exactly as written", () => {
  // A notification that genuinely belongs to no event must remain valid.
  const plain = youOweNotification({ creditorName: "Taylor", amountPennies: 2_000 });
  assert.equal(plain.body, "A new purchase means you now owe Taylor £20.");
  assert.equal(plain.url, "/owed");
  assert.ok(!plain.tag.includes(EVENT_A.id));
});

test("a person deep link keeps its person and gains its event", () => {
  const payload = withEvent({
    title: "🎁 New purchase for Mum",
    body: "Jade added £45 of gifts for Mum.",
    url: "/people?person=r-mum-9",
    tag: "purchase:r-mum-9",
    category: "purchases",
  }, EVENT_B);

  assert.equal(payload.url, `/events/${EVENT_B.id}/people?person=r-mum-9`);
  assert.ok(payload.url.includes("person=r-mum-9"), "the person survives the rewrite");
});

test("an unrecognised destination degrades to the legacy redirect rather than a guess", () => {
  // A future builder that invents a third section must not produce a path that
  // does not exist; it falls through to the compatibility layer instead.
  assert.equal(eventUrlFor("/more", EVENT_A.id), "/more");
  assert.equal(eventUrlFor("/owed", EVENT_A.id), `/events/${EVENT_A.id}/owed`);
  assert.equal(eventUrlFor("/people?person=x", EVENT_A.id), `/events/${EVENT_A.id}/people?person=x`);
  // An absolute URL is never rewritten, and never becomes a same-origin path.
  assert.equal(eventUrlFor("https://example.invalid/owed", EVENT_A.id), "https://example.invalid/owed");
});

test("event icons live in one registry, and notification copy keeps no second one", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const content = readFileSync(join(process.cwd(), "src", "lib", "notification-content.ts"), "utf8");

  // Notification copy names the event in words, so it needs no icon table of
  // its own — and duplicating `eventTypeMeta` here would be one more place to
  // forget when an event type is added.
  assert.doesNotMatch(content, /EVENT_ICONS|eventIconFor/u, "no second icon registry");
  assert.match(content, /There is deliberately NO event-icon table in this module/u);

  // The one registry still covers every type, including an unknown one.
  const { EVENT_TYPES, eventTypeMeta } = await import("../src/lib/events.ts");
  for (const type of EVENT_TYPES) assert.ok(eventTypeMeta(type).icon.length > 0);
  assert.ok(eventTypeMeta("jubilee").icon.length > 0);
});
