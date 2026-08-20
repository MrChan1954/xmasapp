/**
 * What a notification actually says, and where tapping it goes.
 *
 * Everything here is pure: names and pennies in, a title/body/url out. No
 * database, no secrets, no crypto. The dispatcher builds its inputs from
 * authoritative data and calls these, so the wording lives in one place and can
 * be tested without a Supabase project.
 *
 * WHAT MAY NOT APPEAR IN A NOTIFICATION
 *   These render on a locked screen, next to whoever is standing nearby. So the
 *   text is limited to a first name, a recipient's name, and a rounded money
 *   figure. Never a purchase description, a retailer, a note, an email address,
 *   a database id, a token, or anything about the reader's session. Deep-link
 *   ids live in `url`, which the operating system does not display.
 */

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { formatPennies } from "./currency.ts";

export type NotificationCategory =
  | "purchases"
  | "money_i_owe"
  | "money_owed_to_me"
  | "gift_ideas"
  | "gift_status";

export type NotificationPayload = {
  title: string;
  body: string;
  /**
   * A longer body for the Notification Centre only, when the in-app record can
   * responsibly say more than a lock screen should.
   *
   * The only current use is a rejection reason: the payer needs to read why
   * their payment was refused, but that sentence is somebody's free text and
   * has no business appearing above a locked phone in a room full of people.
   * The dispatcher writes this into the `notifications` row and strips it from
   * the payload the push service ever sees.
   */
  inAppBody?: string;
  /** In-app path opened on tap. Same-origin and always one of the real routes. */
  url: string;
  /**
   * Collapse key. Two notifications sharing a tag replace each other on the
   * device rather than stacking, so a phone that was asleep through three
   * balance changes wakes to the latest figure once, not three times.
   */
  tag: string;
  category: NotificationCategory;
};

/** Where each category sends the reader. Mirrors the real route table. */
export const OWED_URL = "/owed";

export function personUrl(christmasRecipientId: string): string {
  // `/people/[id]` redirects here, and this is the form the app's own deep
  // links already use, so a notification tap lands on the person modal.
  return `/people?person=${encodeURIComponent(christmasRecipientId)}`;
}

/**
 * "Another contributor added a purchase." Deliberately says how much was spent
 * and for whom, and nothing about what was bought — the description is exactly
 * the field most likely to spoil a present on a lock screen.
 */
export function purchaseAddedNotification(input: {
  actorName: string;
  recipientName: string;
  amountPennies: number;
  christmasRecipientId: string;
}): NotificationPayload {
  return {
    title: `🎁 New purchase for ${input.recipientName}`,
    body: `${input.actorName} added ${formatPennies(input.amountPennies)} of gifts for ${input.recipientName}.`,
    url: personUrl(input.christmasRecipientId),
    tag: `purchase:${input.christmasRecipientId}`,
    category: "purchases",
  };
}

/**
 * "You now owe someone." `amountPennies` must be the reader's CURRENT net
 * balance with that person, taken from `calculateNetOwedBalances`, not the size
 * of the allocation that triggered the event — those differ whenever there is
 * any history between the two, and showing the allocation would contradict the
 * Owed screen.
 */
export function youOweNotification(input: {
  creditorName: string;
  amountPennies: number;
}): NotificationPayload {
  return {
    title: `💷 You owe ${input.creditorName}`,
    body: `A new purchase means you now owe ${input.creditorName} ${formatPennies(input.amountPennies)}.`,
    url: OWED_URL,
    // Keyed by the person, so a burst of purchases leaves one current figure.
    tag: `owed-to:${input.creditorName}`,
    category: "money_i_owe",
  };
}

/** The mirror image, for the person who paid at the checkout. */
export function owedToYouNotification(input: {
  debtorName: string;
  amountPennies: number;
}): NotificationPayload {
  return {
    title: `💰 ${input.debtorName} owes you`,
    body: `A new purchase means ${input.debtorName} now owes you ${formatPennies(input.amountPennies)}.`,
    url: OWED_URL,
    tag: `owed-from:${input.debtorName}`,
    category: "money_owed_to_me",
  };
}

/**
 * A recorded repayment. Two readings of the same settlement, because only the
 * receiver (or an admin) can record one: the payer learns their debt was
 * acknowledged, the payee learns an admin logged something on their behalf.
 */
export function paymentRecordedNotification(input: {
  actorName: string;
  amountPennies: number;
  audience: "payer" | "payee";
  settlementId: string;
}): NotificationPayload {
  return input.audience === "payer"
    ? {
      title: "💰 Payment recorded",
      body: `${input.actorName} recorded your ${formatPennies(input.amountPennies)} payment.`,
      url: OWED_URL,
      tag: `payment:${input.settlementId}`,
      category: "money_i_owe",
    }
    : {
      title: "💰 Payment received",
      body: `${input.actorName} recorded a ${formatPennies(input.amountPennies)} payment to you.`,
      url: OWED_URL,
      tag: `payment:${input.settlementId}`,
      category: "money_owed_to_me",
    };
}

/**
 * "Somebody says they have paid you." The first half of the two-sided flow.
 *
 * Named after the PAYER rather than whoever tapped Save, because an admin
 * recording a payment on Jade's behalf still means Jade is the one saying she
 * paid. Getting that wrong would put the wrong name in front of the money.
 */
export function paymentClaimedNotification(input: {
  payerName: string;
  amountPennies: number;
  settlementId: string;
}): NotificationPayload {
  return {
    title: "\u{1F4B7} Payment to confirm",
    body: `${input.payerName} says they paid you ${formatPennies(input.amountPennies)}.`,
    url: OWED_URL,
    tag: `payment:${input.settlementId}`,
    category: "money_owed_to_me",
  };
}

/** The payer's copy, when somebody else recorded the claim for them. */
export function paymentAwaitingConfirmationNotification(input: {
  payeeName: string;
  amountPennies: number;
  settlementId: string;
}): NotificationPayload {
  return {
    title: "\u{1F4B7} Payment recorded",
    body: `Your ${formatPennies(input.amountPennies)} payment is waiting for ${input.payeeName} to confirm it.`,
    url: OWED_URL,
    tag: `payment:${input.settlementId}`,
    category: "money_i_owe",
  };
}

/**
 * The receiver's verdict, told to the payer.
 *
 * Three readings of one review, and the figures are never rounded or merged:
 * "confirmed £12 of your £20" is the whole point of partial confirmation and
 * would be a lie as either "confirmed your £20" or "confirmed £12".
 *
 * A rejection reason goes in `inAppBody` only. See the note on that field.
 */
export function paymentReviewNotification(input: {
  reviewerName: string;
  claimedPennies: number;
  confirmedTotalPennies: number;
  action: "confirm" | "reject";
  reason?: string | null;
  receiptId: string;
}): NotificationPayload {
  const claimed = formatPennies(input.claimedPennies);

  if (input.action === "reject") {
    const body = `${input.reviewerName} rejected your ${claimed} payment.`;
    const reason = (input.reason ?? "").trim();
    return {
      title: "⚠️ Payment not received",
      body,
      // Trimmed so the finished sentence always fits the 300-character column
      // the Notification Centre stores it in.
      inAppBody: reason ? `${body} Reason: ${truncate(reason, 200)}` : body,
      url: OWED_URL,
      tag: `payment-review:${input.receiptId}`,
      category: "money_i_owe",
    };
  }

  const fullyConfirmed = input.confirmedTotalPennies >= input.claimedPennies;
  return {
    title: fullyConfirmed ? "✅ Payment confirmed" : "✅ Payment partly confirmed",
    body: fullyConfirmed
      ? `${input.reviewerName} confirmed your ${claimed} payment.`
      : `${input.reviewerName} confirmed ${formatPennies(input.confirmedTotalPennies)} of your ${claimed} payment.`,
    url: OWED_URL,
    tag: `payment-review:${input.receiptId}`,
    category: "money_i_owe",
  };
}

/** A new gift idea. The idea's title is withheld for the same reason as above. */
export function giftIdeaAddedNotification(input: {
  actorName: string;
  recipientName: string;
  christmasRecipientId: string;
}): NotificationPayload {
  return {
    title: `💡 New gift idea for ${input.recipientName}`,
    body: `${input.actorName} added a new gift idea.`,
    url: personUrl(input.christmasRecipientId),
    tag: `gift-idea:${input.christmasRecipientId}`,
    category: "gift_ideas",
  };
}

/** Purchased/wrapped progress on a gift somebody is jointly responsible for. */
export function giftStatusNotification(input: {
  recipientName: string;
  status: "purchased" | "wrapped";
  christmasRecipientId: string;
  purchaseId: string;
}): NotificationPayload {
  const wrapped = input.status === "wrapped";
  return {
    title: wrapped ? "🎄 Gift wrapped" : "🎁 Gift marked purchased",
    body: `A gift for ${input.recipientName} has been marked as ${wrapped ? "wrapped" : "purchased"}.`,
    url: personUrl(input.christmasRecipientId),
    tag: `gift-status:${input.purchaseId}`,
    category: "gift_status",
  };
}

/**
 * First name only. Notifications are read at a glance from a lock screen, and
 * the family all know each other — "Jade" is clearer than "Jade Smith" and
 * discloses less to anyone glancing over a shoulder.
 */
export function shortName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : "Someone";
}

/** Keep a quoted sentence inside the column that has to store it. */
function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}
