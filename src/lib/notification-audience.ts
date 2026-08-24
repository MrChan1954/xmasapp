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
import { birthdayBudgetMonthNotification, birthdayReminderNotification, giftIdeaAddedNotification, giftStatusNotification, owedToYouNotification, paymentAdminOverrideNotification, paymentAwaitingConfirmationNotification, paymentClaimedNotification, paymentRecordedNotification, paymentReviewNotification, purchaseAddedNotification, shortName, youOweNotification, type NotificationPayload } from "./notification-content.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { formatPennies } from "./currency.ts";

/** Every switch on the Notifications screen, as stored per member. */
export type NotificationPreferences = {
  purchases: boolean;
  money_i_owe: boolean;
  money_owed_to_me: boolean;
  gift_ideas: boolean;
  gift_status: boolean;
  birthdays: boolean;
};

/** A member who could be notified: identity, money identity, and their choices. */
export type NotifiableMember = {
  appMemberId: string;
  /** Null when a member is not linked to an active contributor for this event. */
  contributorId: string | null;
  /**
   * The family person behind the account, or null for a membership with no
   * person linked. A birthday reminder needs this to leave the birthday person
   * out of their own audience.
   */
  personId: string | null;
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
  birthdays: true,
};

/**
 * One contributor's share of ONE purchase, exactly as its allocation row
 * records it.
 *
 * `responsibilityPennies` is `purchase_allocations.responsibility_pennies`,
 * read and passed through untouched. It is the SAME integer the dispatcher
 * feeds the Owed engine as a `PurchaseObligation`, which is what lets a
 * notification quote both "this purchase adds £1.66" and "you now owe £22.01"
 * without either figure being computed twice or drifting from the Owed screen.
 */
export type PurchaseShare = {
  contributorId: string;
  responsibilityPennies: number;
};

export type PurchaseEvent = {
  actorAppMemberId: string;
  actorName: string;
  recipientName: string;
  christmasRecipientId: string;
  /** The whole purchase. Never any one person's share of it. */
  amountPennies: number;
  checkoutPayerContributorId: string;
  /**
   * Every contributor carrying a share of this purchase, payer included, with
   * the amount each carries.
   *
   * The amounts matter as much as the membership: a £12 purchase split £4/£5/£3
   * moves three balances by three different figures, and one purchase-wide
   * number would be wrong for all three readers.
   */
  shares: PurchaseShare[];
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
  // Zero-share rows are excluded here, exactly as they were when this arrived
  // pre-filtered as a list of ids: somebody allocated nothing carries no share
  // of this purchase and reads the ordinary purchase notice, not a balance.
  const shareByContributor = new Map(
    event.shares
      .filter((share) => share.responsibilityPennies > 0)
      .map((share) => [share.contributorId, share.responsibilityPennies]),
  );
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

    // A contributor carrying a share of this purchase: tell them the balance,
    // and tell them what this purchase added to it.
    const share = contributorId ? shareByContributor.get(contributorId) ?? 0 : 0;
    if (contributorId && share > 0) {
      const balance = findPairBalance(balances, contributorId, event.checkoutPayerContributorId);
      if (balance && balance.debtorContributorId === contributorId && member.preferences.money_i_owe) {
        planned.push({
          appMemberId: member.appMemberId,
          payload: youOweNotification({
            creditorName: shortName(nameForContributor(members, event.checkoutPayerContributorId)),
            // The running total, from the engine.
            amountPennies: balance.amountPennies,
            // What THIS purchase added, from this purchase's own allocation
            // row. Never the purchase total, and never a share of it worked out
            // here -- two contributors on one purchase get two figures.
            increasePennies: share,
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
  payerName: string;
  payeeContributorId: string;
  payeeName: string;
  amountPennies: number;
  /**
   * How much of the claim the receiver has already acknowledged. Zero for the
   * ordinary case — the payer recording that they have sent something — and the
   * full amount when the receiver recorded it themselves, which is an
   * acknowledgement in one step.
   */
  confirmedAmountPennies: number;
  /**
   * True when a Global Admin created this already confirmed through the
   * override, rather than either side recording it. Both people are told, in
   * wording that does not put words in anybody's mouth.
   */
  adminOverride?: boolean;
};

/**
 * A newly recorded payment.
 *
 * Two different things wear this event, and the wording has to tell them apart:
 *
 *   AWAITING CONFIRMATION  the payer (or an admin) recorded a claim. The
 *                          receiver is the person who must act, so they are
 *                          told what was claimed and by whom. Nothing has moved
 *                          in anyone's balance yet, and the message must not
 *                          imply otherwise.
 *   ALREADY CONFIRMED      the receiver recorded it themselves, so the payer is
 *                          the one who has not heard. Unchanged from before.
 *   ADMIN OVERRIDE         a Global Admin put money in the ledger that moved
 *                          outside the app. Both people are told, and told that
 *                          is what happened.
 *
 * The claim is always named after the PAYER, never after whoever pressed Save.
 */
export function planPaymentNotifications(
  event: PaymentEvent,
  members: NotifiableMember[],
): PlannedNotification[] {
  const planned: PlannedNotification[] = [];
  const awaitingConfirmation = event.confirmedAmountPennies < event.amountPennies;

  const overridePayload = (audience: "payer" | "payee") => paymentAdminOverrideNotification({
    adminName: shortName(event.actorName),
    payerName: shortName(event.payerName),
    payeeName: shortName(event.payeeName),
    amountPennies: event.amountPennies,
    audience,
    settlementId: event.settlementId,
  });

  for (const member of members) {
    if (member.appMemberId === event.actorAppMemberId) continue;
    if (!member.contributorId) continue;

    if (member.contributorId === event.payerContributorId && member.preferences.money_i_owe) {
      planned.push({
        appMemberId: member.appMemberId,
        payload: event.adminOverride
          ? overridePayload("payer")
          : awaitingConfirmation
            // Reachable only if the rules ever widen again: today the database
            // lets nobody but the payer or the payee record a payment, so a
            // pending claim always has the payer as its actor. Kept because the
            // sentence is the correct one for any claim the payer did not
            // record, and losing it would leave them silently uninformed.
            ? paymentAwaitingConfirmationNotification({
              payeeName: shortName(event.payeeName),
              amountPennies: event.amountPennies,
              settlementId: event.settlementId,
            })
            : paymentRecordedNotification({
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
        payload: event.adminOverride
          ? overridePayload("payee")
          : awaitingConfirmation
            ? paymentClaimedNotification({
              payerName: shortName(event.payerName),
              amountPennies: event.amountPennies,
              settlementId: event.settlementId,
            })
            : paymentRecordedNotification({
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

export type PaymentReviewEvent = {
  actorAppMemberId: string;
  reviewerName: string;
  receiptId: string;
  payerContributorId: string;
  action: "confirm" | "reject";
  /** The original claim. Never the amount of this one review action. */
  claimedPennies: number;
  /** The running total confirmed after this review, which is what the payer reads. */
  confirmedTotalPennies: number;
  reason: string | null;
};

/**
 * The receiver's verdict on a claim.
 *
 * Exactly one person hears about it: the payer. The reviewer is the receiver,
 * so actor exclusion already covers them, and nobody else in the family has any
 * business being told that Jade's payment to Taylor was short.
 *
 * It uses the existing `money_i_owe` switch rather than introducing a sixth
 * category — a message about a debt the reader is trying to clear is precisely
 * what that switch already describes.
 */
export function planPaymentReviewNotifications(
  event: PaymentReviewEvent,
  members: NotifiableMember[],
): PlannedNotification[] {
  return members
    .filter((member) =>
      member.appMemberId !== event.actorAppMemberId
      && member.contributorId === event.payerContributorId
      && member.preferences.money_i_owe,
    )
    .map((member) => ({
      appMemberId: member.appMemberId,
      payload: paymentReviewNotification({
        reviewerName: shortName(event.reviewerName),
        claimedPennies: event.claimedPennies,
        confirmedTotalPennies: event.confirmedTotalPennies,
        action: event.action,
        reason: event.reason,
        receiptId: event.receiptId,
      }),
    }));
}

export type GiftIdeaEvent = {
  actorAppMemberId: string;
  actorName: string;
  recipientName: string;
  christmasRecipientId: string;
};

export type BirthdayReminderEvent = {
  /** The birthday person. They are the one member who must NOT be told. */
  celebrantAppMemberId: string | null;
  personId: string;
  personName: string;
  whenLabel: string;
  birthdayLabel: string;
  advice: string;
  occurrenceYear: number;
  stage: string;
  eventId: string | null;
};

export type BirthdayBudgetEvent = {
  /** The one member this summary belongs to. */
  appMemberId: string;
  lines: Array<{ celebrantName: string; dateLabel: string; plannedPennies: number }>;
  totalPennies: number;
  monthLabel: string;
};

/**
 * One person, and one person only.
 *
 * Unlike every other planner here, the audience is not derived by excluding an
 * actor: a budget summary is about ONE contributor's own money, and the amount
 * in it is theirs. Sending it to anybody else would be telling one family
 * member what another has put aside.
 *
 * The `birthdays` preference still applies. Somebody who has turned birthday
 * notifications off has turned this off too.
 */
export function planBirthdayBudgetNotifications(
  event: BirthdayBudgetEvent,
  members: NotifiableMember[],
): PlannedNotification[] {
  const member = members.find((candidate) => candidate.appMemberId === event.appMemberId);
  if (!member || !member.preferences.birthdays) return [];
  if (event.lines.length === 0 || event.totalPennies <= 0) return [];

  return [{
    appMemberId: member.appMemberId,
    payload: birthdayBudgetMonthNotification({
      lines: event.lines,
      totalPennies: event.totalPennies,
      monthLabel: event.monthLabel,
    }),
  }];
}

/**
 * Everyone active except the birthday person.
 *
 * Nobody should be reminded to buy their own present, and a member who has
 * turned birthday reminders off is left out like any other preference. Global
 * Admin is treated as an ordinary family member here: they get reminded because
 * they also buy presents, not because of their role.
 */
export function planBirthdayReminderNotifications(
  event: BirthdayReminderEvent,
  members: NotifiableMember[],
): PlannedNotification[] {
  return members
    .filter((member) => member.appMemberId !== event.celebrantAppMemberId && member.preferences.birthdays)
    .map((member) => ({
      appMemberId: member.appMemberId,
      payload: birthdayReminderNotification({
        personName: shortName(event.personName),
        whenLabel: event.whenLabel,
        birthdayLabel: event.birthdayLabel,
        advice: event.advice,
        personId: event.personId,
        occurrenceYear: event.occurrenceYear,
        stage: event.stage,
        eventId: event.eventId,
      }),
    }));
}

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
