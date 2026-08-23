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

/**
 * Where each category sends the reader, as a SECTION rather than a finished
 * path.
 *
 * These two constants are an intermediate form. Every builder below emits one
 * of them, and `withEvent` — applied once, at the dispatcher's boundary — turns
 * it into the real `/events/<eventId>/...` route before anything is stored or
 * sent. No notification created from Checkpoint 3 onwards is ever persisted
 * with one of these bare paths.
 *
 * They keep the legacy shape on purpose: it is exactly what the compatibility
 * redirects still accept, so a payload that somehow escapes `withEvent` lands
 * somewhere real rather than on a 404.
 */
export const OWED_URL = "/owed";

export function personUrl(christmasRecipientId: string): string {
  // `/people/[id]` redirects here, and this is the form the app's own deep
  // links already use, so a notification tap lands on the person modal.
  return `/people?person=${encodeURIComponent(christmasRecipientId)}`;
}

/** The event a notification belongs to, as the dispatcher resolved it. */
export type NotificationEvent = {
  id: string;
  name: string;
  /** `events.event_type`. Carried for callers that present the event; the
   *  copy below deliberately names the event rather than drawing its icon. */
  type: string;
};

/** Matches the `body` CHECK on `public.notifications` (migration 019/023). */
const BODY_LIMIT = 300;

/** Separates the event from the sentence. Matches the app's own house style. */
const EVENT_SEPARATOR = " · ";

/**
 * Stamp an event onto a finished payload.
 *
 * THREE THINGS CHANGE, AND THEY ALL MATTER
 *
 *   title  is LEFT ALONE. It is the one line a phone shows before anything
 *          else, and it has to say what happened — "💷 You owe Taylor",
 *          "🎁 New gift idea for Paige". Replacing it with the event name
 *          would make every notification from one occasion look identical in
 *          the tray and bury the thing the reader actually needs to know.
 *
 *   body   gains the event at the front: "Christmas 2026 · A new purchase
 *          means you now owe Taylor £20." The occasion is context for the
 *          sentence, so it reads as context rather than as the headline.
 *
 *   url    is rewritten from the legacy section path to the event's own route,
 *          so tapping it lands inside the right event rather than inside
 *          whichever event the compatibility redirect happens to choose.
 *
 *   tag    is prefixed with the event id. This is the subtle one: `tag` is the
 *          collapse key, so without it a birthday "you owe Taylor" would
 *          REPLACE a Christmas "you owe Taylor" on the device, and the reader
 *          would silently lose one of two true statements about different
 *          money.
 *
 * A payload that is never stamped — a family-wide notification belonging to no
 * event — stays exactly as its builder wrote it, and remains valid.
 */
export function withEvent(payload: NotificationPayload, event: NotificationEvent): NotificationPayload {
  return {
    ...payload,
    body: withEventPrefix(payload.body, event.name),
    inAppBody: payload.inAppBody === undefined
      ? undefined
      : withEventPrefix(payload.inAppBody, event.name),
    url: eventUrlFor(payload.url, event.id),
    tag: `${event.id}:${payload.tag}`,
  };
}

/**
 * "Christmas 2026 · <sentence>", inside the column that has to store it.
 *
 * When there is not enough room, the EVENT NAME is what shrinks: the sentence
 * is the actionable half, and a reader who loses the end of it has lost the
 * notification. An event name so long that nothing fits is dropped entirely
 * rather than reduced to an ellipsis that says nothing.
 */
function withEventPrefix(body: string, eventName: string): string {
  const name = eventName.trim();
  if (!name) return body;
  const room = BODY_LIMIT - body.length - EVENT_SEPARATOR.length;
  // Below this there is no room for a name worth reading.
  if (room < 4) return body;
  return `${truncate(name, room)}${EVENT_SEPARATOR}${body}`;
}

/**
 * The section paths above, rewritten into the event's routes.
 *
 * Deliberately a closed translation of the two forms this module produces. An
 * unrecognised path is returned untouched rather than guessed at, so a future
 * builder that invents a third destination degrades to the legacy redirect
 * instead of producing a path that does not exist.
 */
export function eventUrlFor(url: string, eventId: string): string {
  if (!url.startsWith("/")) return url;
  const [path, query] = splitQuery(url);
  const section = path === "/owed" ? "owed" : path === "/people" ? "people" : null;
  if (!section) return url;
  return `/events/${eventId}/${section}${query}`;
}

function splitQuery(url: string): [string, string] {
  const index = url.indexOf("?");
  return index === -1 ? [url, ""] : [url.slice(0, index), url.slice(index)];
}

/*
 * There is deliberately NO event-icon table in this module.
 *
 * Notification copy names the event in words — "Christmas 2026 · …" — and each
 * builder keeps its own action emoji in the title, so nothing here needs to map
 * an event type to a glyph. `eventTypeMeta` in src/lib/events.ts remains the
 * single registry for that, used by the dashboard and the navigation rail; a
 * second copy living here would be one more place to forget when a type is
 * added.
 */

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
 * A Global Admin recorded a payment as already confirmed.
 *
 * Deliberately worded as what it is. "Jade says she paid you" would be a lie
 * here -- Jade did not say anything, an admin reconciled the ledger -- and the
 * person reading it needs to know their balance moved without either of them
 * agreeing to it in the app.
 */
export function paymentAdminOverrideNotification(input: {
  adminName: string;
  payerName: string;
  payeeName: string;
  amountPennies: number;
  audience: "payer" | "payee";
  settlementId: string;
}): NotificationPayload {
  const amount = formatPennies(input.amountPennies);
  return {
    title: "\u{1F4B7} Payment recorded by an admin",
    body: input.audience === "payer"
      ? `${input.adminName} recorded a confirmed ${amount} payment from you to ${input.payeeName}.`
      : `${input.adminName} recorded a confirmed ${amount} payment from ${input.payerName} to you.`,
    url: OWED_URL,
    tag: `payment:${input.settlementId}`,
    category: input.audience === "payer" ? "money_i_owe" : "money_owed_to_me",
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
