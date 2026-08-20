import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { calculateNetOwedBalances, contributorOwedSummary } from "./owed.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { DEFAULT_NOTIFICATION_PREFERENCES, planGiftIdeaNotifications, planGiftStatusNotifications, planPaymentNotifications, planPaymentReviewNotifications, planPurchaseNotifications, type NotifiableMember, type NotificationPreferences } from "./notification-audience.ts";

/**
 * The family used throughout. Contributor ids are chosen so their sort order is
 * not the same as the order they are written in — `calculateNetOwedBalances`
 * keys pairs by sorted id, and a fixture that happened to be pre-sorted could
 * hide a direction bug.
 */
const TAYLOR = { member: "m-taylor", contributor: "c-3-taylor", name: "Taylor Brooks" };
const JADE = { member: "m-jade", contributor: "c-1-jade", name: "Jade Brooks" };
const PAIGE = { member: "m-paige", contributor: "c-2-paige", name: "Paige Brooks" };
const KIRSTEN = { member: "m-kirsten", contributor: "c-4-kirsten", name: "Kirsten Brooks" };

function member(
  person: { member: string; contributor: string | null; name: string },
  preferences: Partial<NotificationPreferences> = {},
): NotifiableMember {
  return {
    appMemberId: person.member,
    contributorId: person.contributor,
    name: person.name,
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, ...preferences },
  };
}

const FAMILY = [member(TAYLOR), member(JADE), member(PAIGE), member(KIRSTEN)];

const PURCHASE = {
  actorAppMemberId: JADE.member,
  actorName: JADE.name,
  recipientName: "Mum",
  christmasRecipientId: "recipient-mum",
  amountPennies: 2499,
  checkoutPayerContributorId: JADE.contributor,
  allocatedContributorIds: [JADE.contributor, TAYLOR.contributor, PAIGE.contributor],
};

/** Jade paid £24.99 and split it three ways: Taylor and Paige owe £8.33 each. */
const PURCHASE_BALANCES = calculateNetOwedBalances(
  [
    { debtorContributorId: TAYLOR.contributor, creditorContributorId: JADE.contributor, amountPennies: 833 },
    { debtorContributorId: PAIGE.contributor, creditorContributorId: JADE.contributor, amountPennies: 833 },
  ],
  [],
);

test("the person who caused the event is never notified about it", () => {
  const planned = planPurchaseNotifications(PURCHASE, FAMILY, PURCHASE_BALANCES);

  assert.equal(planned.filter((row) => row.appMemberId === JADE.member).length, 0);
  assert.deepEqual(
    planned.map((row) => row.appMemberId).sort(),
    [KIRSTEN.member, PAIGE.member, TAYLOR.member],
  );
});

test("one purchase produces exactly one notification per person", () => {
  const planned = planPurchaseNotifications(PURCHASE, FAMILY, PURCHASE_BALANCES);

  // The saved purchase writes a purchases row plus three purchase_allocations
  // rows. Nobody may hear about it four times, and nobody who both owes money
  // and would get the generic notice may hear about it twice.
  const perMember = new Map<string, number>();
  for (const row of planned) perMember.set(row.appMemberId, (perMember.get(row.appMemberId) ?? 0) + 1);
  assert.deepEqual([...new Set(perMember.values())], [1]);
});

test("an owed notification quotes the authoritative engine, not the raw allocation", () => {
  // Taylor's £8.33 share lands on top of an existing £20 debt to Jade, so the
  // engine's answer is £28.33. Quoting the allocation would contradict Owed.
  const balances = calculateNetOwedBalances(
    [
      { debtorContributorId: TAYLOR.contributor, creditorContributorId: JADE.contributor, amountPennies: 2000 },
      { debtorContributorId: TAYLOR.contributor, creditorContributorId: JADE.contributor, amountPennies: 833 },
      { debtorContributorId: PAIGE.contributor, creditorContributorId: JADE.contributor, amountPennies: 833 },
    ],
    [],
  );
  const taylorNote = planPurchaseNotifications(PURCHASE, FAMILY, balances)
    .find((row) => row.appMemberId === TAYLOR.member)!;

  assert.equal(taylorNote.payload.category, "money_i_owe");
  assert.equal(taylorNote.payload.title, "💷 You owe Jade");
  assert.match(taylorNote.payload.body, /£28\.33/);
  assert.doesNotMatch(taylorNote.payload.body, /£8\.33/);
  assert.equal(taylorNote.payload.url, "/owed");
});

test("a share absorbed by an existing debt in the other direction is not an owed alert", () => {
  // Jade already owed Taylor £50. Taylor's new £8.33 share reduces that to
  // £41.67; Taylor still owes nobody, so telling him he owes Jade would be
  // false. He gets the ordinary purchase notice instead.
  const balances = calculateNetOwedBalances(
    [
      { debtorContributorId: JADE.contributor, creditorContributorId: TAYLOR.contributor, amountPennies: 5000 },
      { debtorContributorId: TAYLOR.contributor, creditorContributorId: JADE.contributor, amountPennies: 833 },
      { debtorContributorId: PAIGE.contributor, creditorContributorId: JADE.contributor, amountPennies: 833 },
    ],
    [],
  );
  const taylorNote = planPurchaseNotifications(PURCHASE, FAMILY, balances)
    .find((row) => row.appMemberId === TAYLOR.member)!;

  assert.equal(taylorNote.payload.category, "purchases");
  assert.match(taylorNote.payload.title, /New purchase for Mum/);
});

test("settled balances produce no owed alert at all", () => {
  const settled = calculateNetOwedBalances(
    [{ debtorContributorId: TAYLOR.contributor, creditorContributorId: JADE.contributor, amountPennies: 833 }],
    [{ payerContributorId: TAYLOR.contributor, payeeContributorId: JADE.contributor, amountPennies: 833, confirmedAmountPennies: 833 }],
  );
  assert.deepEqual(settled, [], "engine sanity check: the pair nets to nothing");

  const taylorNote = planPurchaseNotifications(PURCHASE, FAMILY, settled)
    .find((row) => row.appMemberId === TAYLOR.member)!;
  assert.equal(taylorNote.payload.category, "purchases");
});

test("the checkout payer hears what they are owed, summarised when several people owe", () => {
  // Kirsten paid, so Jade adding the purchase leaves Kirsten owed by two people.
  const kirstenPaid = {
    ...PURCHASE,
    checkoutPayerContributorId: KIRSTEN.contributor,
    allocatedContributorIds: [TAYLOR.contributor, PAIGE.contributor],
  };
  const balances = calculateNetOwedBalances(
    [
      { debtorContributorId: TAYLOR.contributor, creditorContributorId: KIRSTEN.contributor, amountPennies: 1250 },
      { debtorContributorId: PAIGE.contributor, creditorContributorId: KIRSTEN.contributor, amountPennies: 1249 },
    ],
    [],
  );
  const note = planPurchaseNotifications(kirstenPaid, FAMILY, balances)
    .find((row) => row.appMemberId === KIRSTEN.member)!;

  assert.equal(note.payload.category, "money_owed_to_me");
  // £24.99 total, which is exactly what contributorOwedSummary reports.
  assert.equal(contributorOwedSummary(balances, KIRSTEN.contributor).owedToYouPennies, 2499);
  assert.match(note.payload.body, /2 people now owe you £24\.99 in total/);
});

test("a single debtor is named rather than summarised", () => {
  const kirstenPaid = {
    ...PURCHASE,
    checkoutPayerContributorId: KIRSTEN.contributor,
    allocatedContributorIds: [TAYLOR.contributor],
  };
  const balances = calculateNetOwedBalances(
    [{ debtorContributorId: TAYLOR.contributor, creditorContributorId: KIRSTEN.contributor, amountPennies: 2499 }],
    [],
  );
  const note = planPurchaseNotifications(kirstenPaid, FAMILY, balances)
    .find((row) => row.appMemberId === KIRSTEN.member)!;

  assert.equal(note.payload.title, "💰 Taylor owes you");
  assert.match(note.payload.body, /£24\.99/);
});

test("each category switch silences only its own notifications", () => {
  const family = [
    member(TAYLOR, { money_i_owe: false }),
    member(JADE),
    member(PAIGE, { purchases: false }),
    member(KIRSTEN, { purchases: false }),
  ];
  const planned = planPurchaseNotifications(PURCHASE, family, PURCHASE_BALANCES);
  const byMember = new Map(planned.map((row) => [row.appMemberId, row.payload]));

  // Taylor owes money but muted that category, so he drops back to the plain
  // purchase notice he has left switched on.
  assert.equal(byMember.get(TAYLOR.member)?.category, "purchases");
  // Paige owes money and left that category on, so she gets the balance.
  assert.equal(byMember.get(PAIGE.member)?.category, "money_i_owe");
  // Kirsten is uninvolved financially and muted purchases: silence.
  assert.equal(byMember.has(KIRSTEN.member), false);
});

test("a member with no contributor account still hears about purchases", () => {
  // Family Access can approve someone who is not a Christmas contributor. They
  // have no balance, but the purchases category still applies to them.
  const observer = member({ member: "m-observer", contributor: null, name: "Sam Brooks" });
  const planned = planPurchaseNotifications(PURCHASE, [...FAMILY, observer], PURCHASE_BALANCES);

  assert.equal(planned.find((row) => row.appMemberId === "m-observer")?.payload.category, "purchases");
});

/** Taylor pays Paige £15. Confirmed in full unless a test says otherwise. */
const PAYMENT = {
  actorAppMemberId: PAIGE.member,
  actorName: PAIGE.name,
  settlementId: "settlement-1",
  payerContributorId: TAYLOR.contributor,
  payerName: TAYLOR.name,
  payeeContributorId: PAIGE.contributor,
  payeeName: PAIGE.name,
  amountPennies: 1500,
  confirmedAmountPennies: 1500,
};

test("a payment the receiver recorded reaches the payer, and the receiver only when someone else logs it", () => {
  // Paige is the receiver and recorded it herself, which confirms it, so only
  // Taylor hears.
  const recordedByPayee = planPaymentNotifications(PAYMENT, FAMILY);
  assert.deepEqual(recordedByPayee.map((row) => row.appMemberId), [TAYLOR.member]);
  assert.equal(recordedByPayee[0].payload.title, "💰 Payment recorded");
  // "£15", not "£15.00": the app's own `formatPennies` drops empty pence, and a
  // notification must read the same way as every figure on screen.
  assert.match(recordedByPayee[0].payload.body, /Paige recorded your £15 payment/);
  assert.equal(recordedByPayee[0].payload.url, "/owed");

  // A Global Admin logging an already-confirmed one: both sides need telling.
  const recordedByAdmin = planPaymentNotifications({ ...PAYMENT, actorAppMemberId: KIRSTEN.member, actorName: KIRSTEN.name }, FAMILY);
  assert.deepEqual(recordedByAdmin.map((row) => row.appMemberId).sort(), [PAIGE.member, TAYLOR.member]);
  assert.equal(
    recordedByAdmin.find((row) => row.appMemberId === PAIGE.member)?.payload.title,
    "💰 Payment received",
  );
});

test("a claim the payer recorded asks the receiver to confirm it, and nobody else", () => {
  const claim = {
    ...PAYMENT,
    actorAppMemberId: TAYLOR.member,
    actorName: TAYLOR.name,
    confirmedAmountPennies: 0,
  };
  const planned = planPaymentNotifications(claim, FAMILY);

  assert.deepEqual(planned.map((row) => row.appMemberId), [PAIGE.member]);
  assert.equal(planned[0].payload.title, "💷 Payment to confirm");
  assert.equal(planned[0].payload.body, "Taylor says they paid you £15.");
  assert.equal(planned[0].payload.category, "money_owed_to_me");
  assert.equal(planned[0].payload.url, "/owed");
});

test("a claim recorded by an admin is still named after the payer, not the recorder", () => {
  const claim = {
    ...PAYMENT,
    actorAppMemberId: KIRSTEN.member,
    actorName: KIRSTEN.name,
    confirmedAmountPennies: 0,
  };
  const planned = planPaymentNotifications(claim, FAMILY);
  const byMember = new Map(planned.map((row) => [row.appMemberId, row.payload]));

  assert.deepEqual([...byMember.keys()].sort(), [PAIGE.member, TAYLOR.member]);
  assert.equal(byMember.get(PAIGE.member)?.body, "Taylor says they paid you £15.");
  assert.match(byMember.get(TAYLOR.member)?.body ?? "", /waiting for Paige to confirm it/);
});

test("payment notifications respect the two money categories separately", () => {
  const event = { ...PAYMENT, actorAppMemberId: KIRSTEN.member, actorName: KIRSTEN.name, settlementId: "settlement-2" };
  const planned = planPaymentNotifications(event, [
    member(TAYLOR, { money_i_owe: false }),
    member(PAIGE),
    member(KIRSTEN),
  ]);

  assert.deepEqual(planned.map((row) => row.appMemberId), [PAIGE.member]);
});

test("a review tells the payer exactly what was confirmed, and tells nobody else", () => {
  const review = {
    actorAppMemberId: PAIGE.member,
    reviewerName: PAIGE.name,
    receiptId: "receipt-1",
    payerContributorId: TAYLOR.contributor,
    action: "confirm" as const,
    claimedPennies: 2000,
    confirmedTotalPennies: 2000,
    reason: null,
  };

  const full = planPaymentReviewNotifications(review, FAMILY);
  assert.deepEqual(full.map((row) => row.appMemberId), [TAYLOR.member], "only the payer is told");
  assert.equal(full[0].payload.title, "✅ Payment confirmed");
  assert.equal(full[0].payload.body, "Paige confirmed your £20 payment.");
  assert.equal(full[0].payload.category, "money_i_owe");

  const partial = planPaymentReviewNotifications({ ...review, confirmedTotalPennies: 1200 }, FAMILY);
  assert.equal(partial[0].payload.title, "✅ Payment partly confirmed");
  assert.equal(partial[0].payload.body, "Paige confirmed £12 of your £20 payment.");
});

test("a rejection keeps its reason out of the lock screen and inside the app", () => {
  const planned = planPaymentReviewNotifications({
    actorAppMemberId: PAIGE.member,
    reviewerName: PAIGE.name,
    receiptId: "receipt-2",
    payerContributorId: TAYLOR.contributor,
    action: "reject",
    claimedPennies: 2000,
    confirmedTotalPennies: 0,
    reason: "Nothing has arrived in my bank yet.",
  }, FAMILY);

  assert.deepEqual(planned.map((row) => row.appMemberId), [TAYLOR.member]);
  assert.equal(planned[0].payload.title, "⚠️ Payment not received");
  assert.equal(planned[0].payload.body, "Paige rejected your £20 payment.");
  assert.equal(
    planned[0].payload.inAppBody,
    "Paige rejected your £20 payment. Reason: Nothing has arrived in my bank yet.",
  );
});

test("a review notification obeys the payer's own category switch", () => {
  const review = {
    actorAppMemberId: PAIGE.member,
    reviewerName: PAIGE.name,
    receiptId: "receipt-3",
    payerContributorId: TAYLOR.contributor,
    action: "confirm" as const,
    claimedPennies: 2000,
    confirmedTotalPennies: 2000,
    reason: null,
  };
  assert.equal(planPaymentReviewNotifications(review, [member(TAYLOR, { money_i_owe: false })]).length, 0);
  assert.equal(planPaymentReviewNotifications(review, [member(TAYLOR)]).length, 1);
  // The reviewer caused this, so they are never told about their own review.
  assert.equal(planPaymentReviewNotifications({ ...review, actorAppMemberId: TAYLOR.member }, FAMILY).length, 0);
});

test("gift ideas go to everyone else who wants them", () => {
  const event = {
    actorAppMemberId: KIRSTEN.member,
    actorName: KIRSTEN.name,
    recipientName: "Dad",
    christmasRecipientId: "recipient-dad",
  };
  const planned = planGiftIdeaNotifications(event, [
    member(KIRSTEN),
    member(TAYLOR),
    member(JADE, { gift_ideas: false }),
  ]);

  assert.deepEqual(planned.map((row) => row.appMemberId), [TAYLOR.member]);
  assert.equal(planned[0].payload.title, "💡 New gift idea for Dad");
  assert.equal(planned[0].payload.url, "/people?person=recipient-dad");
});

test("turning gift ideas off silences them for that member alone", () => {
  const event = {
    actorAppMemberId: KIRSTEN.member,
    actorName: KIRSTEN.name,
    recipientName: "Dad",
    christmasRecipientId: "recipient-dad",
  };

  assert.equal(planGiftIdeaNotifications(event, [member(TAYLOR, { gift_ideas: false })]).length, 0);
  assert.equal(planGiftIdeaNotifications(event, [member(TAYLOR)]).length, 1);
  // Muting ideas must not mute anything else.
  assert.equal(
    planPurchaseNotifications(PURCHASE, [member(TAYLOR, { gift_ideas: false })], PURCHASE_BALANCES).length,
    1,
  );
});

test("gift status reaches only the contributors carrying part of that gift", () => {
  const event = {
    actorAppMemberId: JADE.member,
    purchaseId: "purchase-1",
    recipientName: "Mum",
    christmasRecipientId: "recipient-mum",
    status: "wrapped" as const,
    relevantContributorIds: [JADE.contributor, TAYLOR.contributor],
  };
  const planned = planGiftStatusNotifications(event, FAMILY);

  // Jade acted; Paige and Kirsten have no stake in this gift.
  assert.deepEqual(planned.map((row) => row.appMemberId), [TAYLOR.member]);
  assert.equal(planned[0].payload.title, "🎄 Gift wrapped");
  assert.equal(planned[0].payload.body, "A gift for Mum has been marked as wrapped.");
  assert.equal(planned[0].payload.tag, "gift-status:purchase-1");
});

test("members with no stored preferences are treated as opted in", () => {
  assert.deepEqual(DEFAULT_NOTIFICATION_PREFERENCES, {
    purchases: true,
    money_i_owe: true,
    money_owed_to_me: true,
    gift_ideas: true,
    gift_status: true,
  });
});
