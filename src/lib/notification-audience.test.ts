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
    // Derived from the membership id so every fixture member has a distinct
    // person, which is what the birthday audience filter keys on.
    personId: person.member.replace(/^m-/u, "p-"),
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
  // £24.99 split three ways: £8.33 each, and the shares are what a "you owe"
  // notification quotes as the increase. Jade's own share is present because
  // the allocation row is -- she paid, so it creates no obligation for her.
  shares: [
    { contributorId: JADE.contributor, responsibilityPennies: 833 },
    { contributorId: TAYLOR.contributor, responsibilityPennies: 833 },
    { contributorId: PAIGE.contributor, responsibilityPennies: 833 },
  ],
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

test("an owed notification carries BOTH the increase and the authoritative total", () => {
  // Taylor's £8.33 share lands on top of an existing £20 debt to Jade, so the
  // engine's answer is £28.33.
  //
  // The two figures come from two different places on purpose, and neither may
  // stand in for the other:
  //
  //   £8.33   Taylor's own allocation row for THIS purchase -- what it added.
  //   £28.33  calculateNetOwedBalances over every obligation and settlement --
  //           what he owes now. Quoting the allocation as the total would
  //           contradict the Owed screen; quoting the total as the increase
  //           would tell him one purchase cost him £28.33.
  //
  // And £24.99 -- the purchase itself -- is neither, so it must not appear.
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
  // The title still says what to do about it, and still names the creditor.
  assert.equal(taylorNote.payload.title, "💷 You owe Jade");
  assert.equal(taylorNote.payload.body, "This purchase adds £8.33. You now owe Jade £28.33 in total.");

  // The purchase-wide figure is not the reader's increase.
  assert.doesNotMatch(taylorNote.payload.body, /£24\.99/, "£24.99 is the purchase, not Taylor's share");
  assert.equal(taylorNote.payload.url, "/owed");
});

test("each contributor is told their OWN increase, from an unequal split", () => {
  // One £12 purchase, three unequal shares, Kirsten paying at the checkout.
  // £4 / £5 / £3 -- three readers, three different sentences, one purchase.
  const unequal = {
    ...PURCHASE,
    actorAppMemberId: "m-nobody",
    amountPennies: 1200,
    checkoutPayerContributorId: KIRSTEN.contributor,
    shares: [
      { contributorId: TAYLOR.contributor, responsibilityPennies: 400 },
      { contributorId: JADE.contributor, responsibilityPennies: 500 },
      { contributorId: PAIGE.contributor, responsibilityPennies: 300 },
    ],
  };
  const balances = calculateNetOwedBalances(
    [
      { debtorContributorId: TAYLOR.contributor, creditorContributorId: KIRSTEN.contributor, amountPennies: 400 },
      { debtorContributorId: JADE.contributor, creditorContributorId: KIRSTEN.contributor, amountPennies: 500 },
      { debtorContributorId: PAIGE.contributor, creditorContributorId: KIRSTEN.contributor, amountPennies: 300 },
    ],
    [],
  );
  const byMember = new Map(
    planPurchaseNotifications(unequal, FAMILY, balances).map((row) => [row.appMemberId, row.payload]),
  );

  assert.equal(byMember.get(TAYLOR.member)?.body, "This purchase adds £4. You now owe Kirsten £4 in total.");
  assert.equal(byMember.get(JADE.member)?.body, "This purchase adds £5. You now owe Kirsten £5 in total.");
  assert.equal(byMember.get(PAIGE.member)?.body, "This purchase adds £3. You now owe Kirsten £3 in total.");

  // Nobody was handed one purchase-wide delta.
  for (const payload of byMember.values()) {
    assert.doesNotMatch(payload.body, /adds £12\b/u, "£12 is the purchase, not anybody's share");
  }
});

test("the increase is this purchase's share; the total carries the history", () => {
  // The worked example from live use, in integer pennies throughout.
  // Taylor already owes Paige £20.35; this purchase adds £1.66; £22.01 total.
  const paigePaid = {
    ...PURCHASE,
    actorAppMemberId: PAIGE.member,
    actorName: PAIGE.name,
    amountPennies: 664,
    checkoutPayerContributorId: PAIGE.contributor,
    shares: [{ contributorId: TAYLOR.contributor, responsibilityPennies: 166 }],
  };
  const balances = calculateNetOwedBalances(
    [
      { debtorContributorId: TAYLOR.contributor, creditorContributorId: PAIGE.contributor, amountPennies: 2035 },
      { debtorContributorId: TAYLOR.contributor, creditorContributorId: PAIGE.contributor, amountPennies: 166 },
    ],
    [],
  );
  // Engine sanity: 2035 + 166 = 2201, in pennies, with no rounding anywhere.
  assert.equal(
    balances.find((balance) => balance.debtorContributorId === TAYLOR.contributor)?.amountPennies,
    2201,
  );

  const taylorNote = planPurchaseNotifications(paigePaid, FAMILY, balances)
    .find((row) => row.appMemberId === TAYLOR.member)!;

  assert.equal(taylorNote.payload.title, "💷 You owe Paige");
  assert.equal(taylorNote.payload.body, "This purchase adds £1.66. You now owe Paige £22.01 in total.");
});

test("a purchase that creates no obligation never claims to add £0", () => {
  // Kirsten carries no share of this purchase, so she reads the ordinary
  // purchase notice. "This purchase adds £0" would assert an obligation that
  // was never created.
  const planned = planPurchaseNotifications(PURCHASE, FAMILY, PURCHASE_BALANCES);
  for (const row of planned) {
    assert.doesNotMatch(row.payload.body, /adds £0\b/u, row.appMemberId);
  }
  assert.equal(
    planned.find((row) => row.appMemberId === KIRSTEN.member)?.payload.category,
    "purchases",
  );

  // And an allocation row that exists but carries nothing is not a share.
  const zeroShare = {
    ...PURCHASE,
    shares: [
      { contributorId: JADE.contributor, responsibilityPennies: 2499 },
      { contributorId: TAYLOR.contributor, responsibilityPennies: 0 },
    ],
  };
  const taylorNote = planPurchaseNotifications(zeroShare, FAMILY, PURCHASE_BALANCES)
    .find((row) => row.appMemberId === TAYLOR.member)!;
  assert.equal(taylorNote.payload.category, "purchases", "a £0 share is not an owed alert");
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
    shares: [
      { contributorId: TAYLOR.contributor, responsibilityPennies: 1250 },
      { contributorId: PAIGE.contributor, responsibilityPennies: 1249 },
    ],
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
    shares: [{ contributorId: TAYLOR.contributor, responsibilityPennies: 2499 }],
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
  // Every category defaults ON, including the one Checkpoint 4 added. A
  // birthday reminder that arrived only for people who had already been into
  // Settings would be worse than no reminder at all: the family would believe
  // it was covered.
  assert.deepEqual(DEFAULT_NOTIFICATION_PREFERENCES, {
    purchases: true,
    money_i_owe: true,
    money_owed_to_me: true,
    gift_ideas: true,
    gift_status: true,
    birthdays: true,
  });
});

test("an admin override tells both people, and says an admin did it", () => {
  // Kirsten (Global Admin) reconciles a payment Taylor made to Paige. Neither
  // of them recorded it, so neither may be quoted as having said anything.
  const planned = planPaymentNotifications({
    ...PAYMENT,
    actorAppMemberId: KIRSTEN.member,
    actorName: KIRSTEN.name,
    settlementId: "settlement-admin",
    adminOverride: true,
  }, FAMILY);
  const byMember = new Map(planned.map((row) => [row.appMemberId, row.payload]));

  assert.deepEqual([...byMember.keys()].sort(), [PAIGE.member, TAYLOR.member]);
  assert.equal(byMember.get(TAYLOR.member)?.body, "Kirsten recorded a confirmed £15 payment from you to Paige.");
  assert.equal(byMember.get(PAIGE.member)?.body, "Kirsten recorded a confirmed £15 payment from Taylor to you.");
  assert.equal(byMember.get(TAYLOR.member)?.category, "money_i_owe");
  assert.equal(byMember.get(PAIGE.member)?.category, "money_owed_to_me");
  for (const payload of byMember.values()) {
    assert.doesNotMatch(payload.body, /says they paid/);
  }
});

test("being an admin changes nothing about an ordinary payment's notifications", () => {
  // The same event, planned twice. Nothing in the planner can tell whether the
  // actor holds the admin role, which is exactly the property being asserted:
  // the only inputs are who paid, who was paid, and how much is confirmed.
  const claim = { ...PAYMENT, actorAppMemberId: TAYLOR.member, actorName: TAYLOR.name, confirmedAmountPennies: 0 };

  assert.deepEqual(
    planPaymentNotifications(claim, FAMILY).map((row) => [row.appMemberId, row.payload.title, row.payload.body]),
    planPaymentNotifications({ ...claim, adminOverride: false }, FAMILY).map((row) => [row.appMemberId, row.payload.title, row.payload.body]),
  );
});
