import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { giftIdeaAddedNotification, giftStatusNotification, owedToYouNotification, paymentRecordedNotification, personUrl, purchaseAddedNotification, shortName, youOweNotification } from "./notification-content.ts";

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
    youOweNotification({ creditorName: "Taylor", amountPennies: 833 }),
    owedToYouNotification({ debtorName: "Jade", amountPennies: 833 }),
    paymentRecordedNotification({ actorName: "Paige", amountPennies: 1500, audience: "payee", settlementId: "s1" }),
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
  const owe = youOweNotification({ creditorName: "Taylor", amountPennies: 833 });
  assert.equal(owe.title, "💷 You owe Taylor");
  assert.equal(owe.body, "A new purchase means you now owe Taylor £8.33.");
  assert.equal(owe.url, "/owed");
  assert.equal(owe.category, "money_i_owe");

  const owed = owedToYouNotification({ debtorName: "Jade", amountPennies: 833 });
  assert.equal(owed.title, "💰 Jade owes you");
  assert.equal(owed.category, "money_owed_to_me");
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
