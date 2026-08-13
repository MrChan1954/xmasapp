/**
 * Who gets told about an event, and which of the five messages they get.
 *
 * THIS FILE NEVER CALCULATES MONEY. Every figure it puts in a notification is
 * read out of `NetOwedBalance[]`, which the caller produces by running the
 * app's one authoritative engine — `calculateNetOwedBalances` in `owed.ts` —
 * over the same purchases, allocations and settlements the Owed screen reads.
 * A second balance calculation living here could drift from the screen and tell
 * someone they owe a figure the app does not agree with, so the balances are an
 * input, not something derived.
 *
 * TWO RULES SHAPE EVERYTHING BELOW
 *
 *  1. Never notify the person who caused the event. Taylor adding a purchase
 *     must not push "Taylor added a purchase" to Taylor's own phone.
 *
 *  2. At most one notification per person per event. A single save writes a
 *     purchase row plus one allocation row per contributor and moves several
 *     balances; that is still one thing that happened. Where somebody qualifies
 *     for two messages, the financial one wins — it already implies the
 *     purchase ("A new purchase means you now owe...") and is the part they
 *     actually need to know.
 */

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { contributorOwedSummary, pairKey, type NetOwedBalance } from "./owed.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { giftIdeaAddedNotification, giftStatusNotification, owedToYouNotification, paymentRecordedNotification, purchaseAddedNotification, shortName, youOweNotification, type NotificationPayload } from "./notification-content.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { formatPennies } from "./currency.ts";

/** Every switch on the Notifications screen, as stored per member. */
export type NotificationPreferences = {
  purchases: boolean;
  money_i_owe: boolean;
  money_owed_to_me: boolean;
  gift_ideas: boolean;
  gift_status: boolean;
};

/** A member who could be notified: identity, money identity, and their choices. */
export type NotifiableMember = {
  appMemberId: string;
  /** Null when a member is not linked to an active contributor for this event. */
  contributorId: string | null;
  name: string;
  preferences: NotificationPreferences;
};

export type PlannedNotification = {
  appMemberId: string;
  payload: NotificationPayload;
};

/** Members with no stored preferences row are fully opted in. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  purchases: true,
  money_i_owe: true,
  money_owed_to_me: true,
  gift_ideas: true,
  gift_status: true,
};

export type PurchaseEvent = {
  actorAppMemberId: string;
  actorName: string;
  recipientName: string;
  christmasRecipientId: string;
  amountPennies: number;
  checkoutPayerContributorId: string;
  /** Contributor ids carrying a share of this purchase, payer included. */
  allocatedContributorIds: string[];
};

/**
 * A saved purchase.
 *
 * Everyone else hears about it once. Contributors whose balance with the
 * checkout payer moved hear the balance instead, and the payer hears what they
 * are now owed in total.
 */
export function planPurchaseNotifications(
  event: PurchaseEvent,
  members: NotifiableMember[],
  balances: NetOwedBalance[],
): PlannedNotification[] {
  const allocated = new Set(event.allocatedContributorIds);
  const planned: PlannedNotification[] = [];

  for (const member of members) {
    if (member.appMemberId === event.actorAppMemberId) continue;

    const contributorId = member.contributorId;

    // The person who paid at the checkout: tell them what they are owed now.
    if (contributorId && contributorId === event.checkoutPayerContributorId) {
      if (!member.preferences.money_owed_to_me) continue;

      const debts = balances.filter((balance) => balance.creditorContributorId === contributorId);
      if (debts.length === 0) continue;

      // One debtor reads better named; several read better as the single total
      // the Owed screen shows, which is exactly `contributorOwedSummary`.
      if (debts.length === 1) {
        const debtorName = nameForContributor(members, debts[0].debtorContributorId);
        planned.push({
          appMemberId: member.appMemberId,
          payload: owedToYouNotification({
            debtorName: shortName(debtorName),
            amountPennies: debts[0].amountPennies,
          }),
        });
        continue;
      }

      const summary = contributorOwedSummary(balances, contributorId);
      planned.push({
        appMemberId: member.appMemberId,
        payload: {
          title: "💰 You are owed more",
          body: `A new purchase means ${debts.length} people now owe you ${formatPennies(summary.owedToYouPennies)} in total.`,
          url: "/owed",
          tag: "owed-from:summary",
          category: "money_owed_to_me",
        },
      });
      continue;
    }

    // A contributor carrying a share of this purchase: tell them the balance.
    if (contributorId && allocated.has(contributorId)) {
      const balance = findPairBalance(balances, contributorId, event.checkoutPayerContributorId);
      if (balance && balance.debtorContributorId === contributorId && member.preferences.money_i_owe) {
        planned.push({
          appMemberId: member.appMemberId,
          payload: youOweNotification({
            creditorName: shortName(nameForContributor(members, event.checkoutPayerContributorId)),
            amountPennies: balance.amountPennies,
          }),
        });
        continue;
      }
      // Their share did not leave them owing the payer — an earlier debt in the
      // other direction may have absorbed it. Fall through to the plain notice.
    }

    if (!member.preferences.purchases) continue;
    planned.push({
      appMemberId: member.appMemberId,
      payload: purchaseAddedNotification({
        actorName: shortName(event.actorName),
        recipientName: event.recipientName,
        amountPennies: event.amountPennies,
        christmasRecipientId: event.christmasRecipientId,
      }),
    });
  }

  return planned;
}

export type PaymentEvent = {
  actorAppMemberId: string;
  actorName: string;
  settlementId: string;
  payerContributorId: string;
  payeeContributorId: string;
  amountPennies: number;
};

/**
 * A recorded repayment.
 *
 * `record_settlement` only lets the receiver or a Global Admin record one, so
 * normally the payer is the single person who has not yet heard. When an admin
 * records on someone's behalf, both sides are told.
 */
export function planPaymentNotifications(
  event: PaymentEvent,
  members: NotifiableMember[],
): PlannedNotification[] {
  const planned: PlannedNotification[] = [];

  for (const member of members) {
    if (member.appMemberId === event.actorAppMemberId) continue;
    if (!member.contributorId) continue;

    if (member.contributorId === event.payerContributorId && member.preferences.money_i_owe) {
      planned.push({
        appMemberId: member.appMemberId,
        payload: paymentRecordedNotification({
          actorName: shortName(event.actorName),
          amountPennies: event.amountPennies,
          audience: "payer",
          settlementId: event.settlementId,
        }),
      });
    }

    if (member.contributorId === event.payeeContributorId && member.preferences.money_owed_to_me) {
      planned.push({
        appMemberId: member.appMemberId,
        payload: paymentRecordedNotification({
          actorName: shortName(event.actorName),
          amountPennies: event.amountPennies,
          audience: "payee",
          settlementId: event.settlementId,
        }),
      });
    }
  }

  return planned;
}

export type GiftIdeaEvent = {
  actorAppMemberId: string;
  actorName: string;
  recipientName: string;
  christmasRecipientId: string;
};

export function planGiftIdeaNotifications(
  event: GiftIdeaEvent,
  members: NotifiableMember[],
): PlannedNotification[] {
  return members
    .filter((member) => member.appMemberId !== event.actorAppMemberId && member.preferences.gift_ideas)
    .map((member) => ({
      appMemberId: member.appMemberId,
      payload: giftIdeaAddedNotification({
        actorName: shortName(event.actorName),
        recipientName: event.recipientName,
        christmasRecipientId: event.christmasRecipientId,
      }),
    }));
}

export type GiftStatusEvent = {
  actorAppMemberId: string;
  purchaseId: string;
  recipientName: string;
  christmasRecipientId: string;
  status: "purchased" | "wrapped";
  /** Contributors with a share, plus the checkout payer: the "relevant" set. */
  relevantContributorIds: string[];
};

/**
 * Purchased/wrapped progress goes only to people with a stake in that gift, not
 * to the whole family — "relevant gift" in the settings copy means exactly the
 * contributors already carrying part of its cost.
 */
export function planGiftStatusNotifications(
  event: GiftStatusEvent,
  members: NotifiableMember[],
): PlannedNotification[] {
  const relevant = new Set(event.relevantContributorIds);

  return members
    .filter((member) =>
      member.appMemberId !== event.actorAppMemberId
      && member.contributorId !== null
      && relevant.has(member.contributorId)
      && member.preferences.gift_status,
    )
    .map((member) => ({
      appMemberId: member.appMemberId,
      payload: giftStatusNotification({
        recipientName: event.recipientName,
        status: event.status,
        christmasRecipientId: event.christmasRecipientId,
        purchaseId: event.purchaseId,
      }),
    }));
}

function findPairBalance(
  balances: NetOwedBalance[],
  firstContributorId: string,
  secondContributorId: string,
): NetOwedBalance | null {
  if (firstContributorId === secondContributorId) return null;
  const key = pairKey(firstContributorId, secondContributorId);
  return balances.find((balance) => balance.pairKey === key) ?? null;
}

function nameForContributor(members: NotifiableMember[], contributorId: string): string {
  return members.find((member) => member.contributorId === contributorId)?.name ?? "Someone";
}
