import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { giftIdeaAddedNotification, giftStatusNotification, owedToYouNotification, paymentAdminOverrideNotification, paymentAwaitingConfirmationNotification, paymentClaimedNotification, paymentRecordedNotification, paymentReviewNotification, personUrl, purchaseAddedNotification, shortName, youOweNotification } from "./notification-content.ts";

/**
 * These read like copy tests, and partly they are — but the assertions that
 * matter are the negative ones. A notification is rendered on a locked screen
 * by the operating system, so anything that reaches `body` is readable by
 * whoever is standing nearby. The description, retailer, notes and url a
 * purchase carries are exactly the fields that would spoil a Christmas present
 * or leak a shopping habit, and none of them are parameters of any function
 * here — these tests are what keeps it that way.
 */

const PURCHASE = {
  actorName: "Jade",
  recipientName: "Mum",
  amountPennies: 2499,
  christmasRecipientId: "11111111-2222-3333-4444-555555555555",
};

test("a purchase notification names the recipient and the amount, and nothing else", () => {
  const payload = purchaseAddedNotification(PURCHASE);

  assert.equal(payload.title, "🎁 New purchase for Mum");
  assert.equal(payload.body, "Jade added £24.99 of gifts for Mum.");
  assert.equal(payload.category, "purchases");
  // The visible text carries no identifier. The id appears only in `url`, which
  // the operating system uses for the tap target and never displays.
  assert.doesNotMatch(`${payload.title} ${payload.body}`, /[0-9a-f]{8}-[0-9a-f]{4}/);
});

test("every notification opens a real in-app route", () => {
  const payloads = [
    purchaseAddedNotification(PURCHASE),
    youOweNotification({ creditorName: "Taylor", amountPennies: 833, increasePennies: 166 }),
    owedToYouNotification({ debtorName: "Jade", amountPennies: 833 }),
    paymentRecordedNotification({ actorName: "Paige", amountPennies: 1500, audience: "payee", settlementId: "s1" }),
    paymentClaimedNotification({ payerName: "Jade", amountPennies: 2000, settlementId: "s1" }),
    paymentAwaitingConfirmationNotification({ payeeName: "Taylor", amountPennies: 2000, settlementId: "s1" }),
    paymentReviewNotification({ reviewerName: "Taylor", claimedPennies: 2000, confirmedTotalPennies: 1200, action: "confirm", receiptId: "r1" }),
    paymentReviewNotification({ reviewerName: "Taylor", claimedPennies: 2000, confirmedTotalPennies: 0, action: "reject", reason: "Nothing yet.", receiptId: "r2" }),
    giftIdeaAddedNotification({ actorName: "Kirsten", recipientName: "Dad", christmasRecipientId: "r1" }),
    giftStatusNotification({ recipientName: "Mum", status: "wrapped", christmasRecipientId: "r1", purchaseId: "p1" }),
  ];

  for (const payload of payloads) {
    // Same-origin relative paths only. An absolute or protocol-relative url
    // here would let a notification open somewhere outside the app.
    assert.match(payload.url, /^\/(owed|people)/, payload.title);
    assert.doesNotMatch(payload.url, /^\/\//);
    assert.ok(payload.tag.length > 0, "a collapse tag is what stops repeats stacking up");
    assert.ok(payload.title.length <= 60 && payload.body.length <= 120, "must fit a lock screen");
  }
});

test("money notifications point at Owed and money categories", () => {
  const owe = youOweNotification({ creditorName: "Taylor", amountPennies: 833, increasePennies: 166 });
  assert.equal(owe.title, "💷 You owe Taylor");
  assert.equal(owe.body, "This purchase adds £1.66. You now owe Taylor £8.33 in total.");
  assert.equal(owe.url, "/owed");
  assert.equal(owe.category, "money_i_owe");

  const owed = owedToYouNotification({ debtorName: "Jade", amountPennies: 833 });
  assert.equal(owed.title, "💰 Jade owes you");
  assert.equal(owed.category, "money_owed_to_me");
});

/**
 * The two figures in a "you owe" notification, and what each of them is for.
 *
 * A reader watching their balance move needs to know BOTH what just happened
 * and where they now stand. The old copy gave only the second, so a figure that
 * jumped by £1.66 and one that jumped by £16.60 read identically.
 */
test("a you-owe notification names the increase and the running total, in that order", () => {
  const payload = youOweNotification({
    creditorName: "Ash",
    amountPennies: 2201,
    increasePennies: 166,
  });

  assert.equal(payload.body, "This purchase adds £1.66. You now owe Ash £22.01 in total.");

  // What just happened comes first; the standing figure is the second half.
  assert.ok(
    payload.body.indexOf("£1.66") < payload.body.indexOf("£22.01"),
    "the new information leads",
  );

  // The title still says what to do about it. Replacing it with the occasion
  // would make every notification from one event identical in the tray.
  assert.equal(payload.title, "💷 You owe Ash");
  assert.doesNotMatch(payload.title, /£/u, "money belongs in the body");
});

test("the increase and the total are independent; neither stands in for the other", () => {
  // First purchase against a clean slate: the two figures agree, and they agree
  // because both are correct, not because one is derived from the other.
  const first = youOweNotification({ creditorName: "Ash", amountPennies: 166, increasePennies: 166 });
  assert.equal(first.body, "This purchase adds £1.66. You now owe Ash £1.66 in total.");

  // A large purchase on top of a small debt, and the other way round. If either
  // figure were computed from the other, one of these would be wrong.
  const bigOnSmall = youOweNotification({ creditorName: "Ash", amountPennies: 5100, increasePennies: 5000 });
  assert.equal(bigOnSmall.body, "This purchase adds £50. You now owe Ash £51 in total.");

  const smallOnBig = youOweNotification({ creditorName: "Ash", amountPennies: 5100, increasePennies: 100 });
  assert.equal(smallOnBig.body, "This purchase adds £1. You now owe Ash £51 in total.");
});

test("a non-positive increase is not announced as £0", () => {
  // The audience layer never builds one of these -- somebody with no share
  // reads the ordinary purchase notice instead. This is the second lock: even
  // if it were built, it must not assert an obligation that does not exist.
  for (const increasePennies of [0, -1]) {
    const payload = youOweNotification({ creditorName: "Ash", amountPennies: 2201, increasePennies });
    assert.equal(payload.body, "You now owe Ash £22.01 in total.");
    assert.doesNotMatch(payload.body, /adds/u, `increase of ${increasePennies}`);
    assert.doesNotMatch(payload.body, /£0/u, `increase of ${increasePennies}`);
  }
});

test("both figures are integer pennies, formatted once, never rounded twice", () => {
  // A penny that cannot divide evenly must survive to the screen intact.
  const payload = youOweNotification({ creditorName: "Ash", amountPennies: 1, increasePennies: 1 });
  assert.equal(payload.body, "This purchase adds £0.01. You now owe Ash £0.01 in total.");

  // No floating point anywhere: 0.1 + 0.2 pounds would print £0.30000000000000004.
  const awkward = youOweNotification({ creditorName: "Ash", amountPennies: 30, increasePennies: 10 });
  assert.equal(awkward.body, "This purchase adds £0.10. You now owe Ash £0.30 in total.");
  assert.doesNotMatch(awkward.body, /\.\d{3}/u, "no fractional pennies reach the copy");
});

test("the two readings of a payment are addressed to the right side", () => {
  const toPayer = paymentRecordedNotification({ actorName: "Paige", amountPennies: 1500, audience: "payer", settlementId: "s1" });
  const toPayee = paymentRecordedNotification({ actorName: "Kirsten", amountPennies: 1500, audience: "payee", settlementId: "s1" });

  assert.equal(toPayer.body, "Paige recorded your £15 payment.");
  assert.equal(toPayer.category, "money_i_owe");
  assert.equal(toPayee.body, "Kirsten recorded a £15 payment to you.");
  assert.equal(toPayee.category, "money_owed_to_me");
});

test("a gift idea says who and for whom, never what the idea is", () => {
  const payload = giftIdeaAddedNotification({ actorName: "Kirsten", recipientName: "Dad", christmasRecipientId: "r1" });

  assert.equal(payload.title, "💡 New gift idea for Dad");
  assert.equal(payload.body, "Kirsten added a new gift idea.");
});

test("gift status distinguishes wrapped from purchased", () => {
  const wrapped = giftStatusNotification({ recipientName: "Mum", status: "wrapped", christmasRecipientId: "r1", purchaseId: "p1" });
  const purchased = giftStatusNotification({ recipientName: "Mum", status: "purchased", christmasRecipientId: "r1", purchaseId: "p1" });

  assert.equal(wrapped.title, "🎄 Gift wrapped");
  assert.equal(wrapped.body, "A gift for Mum has been marked as wrapped.");
  assert.equal(purchased.body, "A gift for Mum has been marked as purchased.");
  // Same purchase, different status: distinct enough to be worth both, but
  // sharing a tag so the later one replaces the earlier on the lock screen.
  assert.equal(wrapped.tag, purchased.tag);
});

test("deep links are encoded, so an id can never break out of the query string", () => {
  assert.equal(personUrl("abc-123"), "/people?person=abc-123");
  assert.equal(personUrl("a&b=c"), "/people?person=a%26b%3Dc");
});

test("only a first name is ever shown", () => {
  assert.equal(shortName("Jade Brooks"), "Jade");
  assert.equal(shortName("  Taylor   Brooks "), "Taylor");
  assert.equal(shortName(""), "Someone");
  assert.equal(shortName("   "), "Someone");
});

test("a claim says who says they paid, not who typed it in", () => {
  const payload = paymentClaimedNotification({ payerName: "Jade", amountPennies: 2000, settlementId: "s9" });

  assert.equal(payload.title, "\u{1F4B7} Payment to confirm");
  assert.equal(payload.body, "Jade says they paid you £20.");
  assert.equal(payload.category, "money_owed_to_me");
  assert.equal(payload.url, "/owed");

  const waiting = paymentAwaitingConfirmationNotification({ payeeName: "Taylor", amountPennies: 2000, settlementId: "s9" });
  assert.equal(waiting.body, "Your £20 payment is waiting for Taylor to confirm it.");
  assert.equal(waiting.category, "money_i_owe");
});

test("a review never merges the claim with what was confirmed", () => {
  const full = paymentReviewNotification({ reviewerName: "Taylor", claimedPennies: 2000, confirmedTotalPennies: 2000, action: "confirm", receiptId: "r1" });
  assert.equal(full.title, "✅ Payment confirmed");
  assert.equal(full.body, "Taylor confirmed your £20 payment.");
  assert.equal(full.inAppBody, undefined, "nothing extra to say in the app");

  const partial = paymentReviewNotification({ reviewerName: "Taylor", claimedPennies: 2000, confirmedTotalPennies: 1200, action: "confirm", receiptId: "r1" });
  assert.equal(partial.title, "✅ Payment partly confirmed");
  assert.equal(partial.body, "Taylor confirmed £12 of your £20 payment.");
  // Both figures survive: neither "£20" nor "£12" alone is the truth.
  assert.match(partial.body, /£12 of your £20/);
});

test("a rejection reason is kept off the lock screen and inside the app", () => {
  const payload = paymentReviewNotification({
    reviewerName: "Taylor",
    claimedPennies: 2000,
    confirmedTotalPennies: 0,
    action: "reject",
    reason: "Nothing has arrived in my bank yet.",
    receiptId: "r2",
  });

  assert.equal(payload.title, "⚠️ Payment not received");
  assert.equal(payload.body, "Taylor rejected your £20 payment.");
  assert.doesNotMatch(payload.body, /bank/, "the reason is somebody's free text and stays out of the push");
  assert.equal(payload.inAppBody, "Taylor rejected your £20 payment. Reason: Nothing has arrived in my bank yet.");

  // A long reason is trimmed rather than overflowing the column that stores it.
  const long = paymentReviewNotification({
    reviewerName: "Taylor",
    claimedPennies: 2000,
    confirmedTotalPennies: 0,
    action: "reject",
    reason: "x".repeat(500),
    receiptId: "r3",
  });
  assert.ok((long.inAppBody ?? "").length <= 300, "the notifications table caps a body at 300 characters");
});

test("an admin override says who did it, and does not put words in anybody's mouth", () => {
  const toPayer = paymentAdminOverrideNotification({
    adminName: "Taylor", payerName: "Jade", payeeName: "Paige",
    amountPennies: 2000, audience: "payer", settlementId: "s1",
  });
  const toPayee = paymentAdminOverrideNotification({
    adminName: "Taylor", payerName: "Jade", payeeName: "Paige",
    amountPennies: 2000, audience: "payee", settlementId: "s1",
  });

  assert.equal(toPayer.title, "\u{1F4B7} Payment recorded by an admin");
  assert.equal(toPayer.body, "Taylor recorded a confirmed £20 payment from you to Paige.");
  assert.equal(toPayer.category, "money_i_owe");
  assert.equal(toPayee.body, "Taylor recorded a confirmed £20 payment from Jade to you.");
  assert.equal(toPayee.category, "money_owed_to_me");

  // The reason an admin gave is never part of the message: it is free text,
  // and this renders on a lock screen.
  for (const payload of [toPayer, toPayee]) {
    assert.doesNotMatch(payload.body, /says they paid/);
    assert.equal(payload.inAppBody, undefined);
    assert.equal(payload.url, "/owed");
    assert.ok(payload.title.length <= 60 && payload.body.length <= 120);
  }
});
