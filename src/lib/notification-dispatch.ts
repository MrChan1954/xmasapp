/**
 * Turning one completed action into notifications: audience, in-app rows, push.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `notifications-server.ts`
 *
 * Two callers need this pipeline and they arrive with different authority:
 *
 *   1. `/api/notifications/dispatch` — the person who performed the action is
 *      signed in and calling immediately. Reads go through THEIR session, so
 *      RLS still applies, and the row's actor column must be them.
 *
 *   2. The outbox drain — nobody is "the caller". The event was recorded by a
 *      database trigger inside the same transaction as the write, so the actor
 *      is already established and reads go through the admin client.
 *
 * Both paths share every line below; only the reader client and the
 * authorization callback differ. Keeping them in one place is what stops the
 * retry path drifting from the live path — the exact class of bug that let real
 * events fail while the test button worked.
 *
 * It also makes the pipeline testable: nothing here imports `server-only`,
 * `next/headers`, or the environment. Clients and the push sender are
 * parameters, so `scripts/notification-dispatch.test.mjs` can run the real
 * audience → preferences → subscription → notification-centre → delivery chain
 * against in-memory tables.
 *
 * THIS FILE NEVER CALCULATES MONEY. Balances come from `calculateNetOwedBalances`
 * in `owed.ts`, over the same rows the Owed screen reads.
 */

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { calculateNetOwedBalances, type NetOwedBalance, type PurchaseObligation, type SettlementLedgerEntry } from "./owed.ts";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  planGiftIdeaNotifications,
  planGiftStatusNotifications,
  planPaymentNotifications,
  planPaymentReviewNotifications,
  planPurchaseNotifications,
  type NotifiableMember,
  type PlannedNotification,
  // @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
} from "./notification-audience.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { shortName, withEvent, type NotificationEvent } from "./notification-content.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { logNotification, pushServiceHost } from "./notification-log.ts";

/**
 * How old a row may be and still justify a notification RAISED BY A CLIENT.
 *
 * The dispatch endpoint takes a row id from the browser, so this window stops a
 * member who knows an old purchase id replaying it to buzz everyone's phone.
 *
 * It deliberately does NOT apply to the outbox, whose rows were written by a
 * database trigger inside the transaction that made the change. Those cannot be
 * forged or replayed, so bounding them by this window would mean an event was
 * lost simply because nobody opened the app for ten minutes — which is the
 * reliability problem the outbox exists to solve.
 */
export const EVENT_FRESHNESS_MS = 10 * 60 * 1000;

/** How long an unprocessed outbox row stays worth attempting. */
export const OUTBOX_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Give up after this many attempts, so one poisoned row cannot spin forever. */
export const MAX_OUTBOX_ATTEMPTS = 5;

/** Rows drained per request. Small: this runs alongside a user-facing fetch. */
export const OUTBOX_BATCH_SIZE = 10;

export class NotificationError extends Error {
  // Written out longhand rather than as a constructor parameter property:
  // Node's type-stripping test runner cannot erase those, and the regression
  // tests import this module directly.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "NotificationError";
    this.status = status;
  }
}

export type NotificationEventKind = "purchase" | "payment" | "gift_idea" | "gift_status" | "payment_review";

/**
 * The bit of a Supabase client this module uses.
 *
 * Left deliberately loose so both the RLS-scoped session client and the
 * secret-key admin client satisfy it, and so a test can supply in-memory
 * tables. Every query below is written the same way whichever it is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataClient = { from: (table: string) => any };

export type PushOutcome =
  | { outcome: "sent"; status: number }
  | { outcome: "expired"; status: number }
  | { outcome: "failed"; status: number; reason: string };

/**
 * Deliver one encrypted payload to one device.
 *
 * Supplied by the caller, which owns the VAPID keys. `null` means push is not
 * configured, which must degrade to "no OS alert" and never to "the event never
 * happened" — the in-app notification is the durable record.
 */
export type PushSender = (
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: string,
) => Promise<PushOutcome>;

export type CreatePushSender = () => PushSender | null;

export type DispatchOutcome =
  | "delivered"
  | "push-failed"
  | "no-subscribed-recipients"
  | "push-not-configured"
  | "no-audience"
  | "not-applicable"
  | "already-delivered";

/**
 * What actually happened, in numbers, for one event.
 *
 * Returned to the caller and written to the log as a single line. Every field
 * is a count or a first name — no endpoint, no key, no notification text, no
 * full row id. This is the diagnostic that was missing: a dispatch that reached
 * nobody used to be indistinguishable from one that reached everybody.
 */
export type DispatchReport = {
  event: NotificationEventKind;
  source: "action" | "outbox";
  /** First name of the person whose action this was. Never an id. */
  actor: string;
  /** First characters of the subject row id, enough to correlate two log lines. */
  subject: string;
  /** Which repeatable event on that row: "created", "status:wrapped", … */
  fingerprint: string | null;
  /** Active members other than the actor. */
  audience: number;
  /** Of those, how many their preferences left eligible for a message. */
  preferencesAllowed: number;
  /** Of those, how many have at least one registered device. */
  subscribedRecipients: number;
  inAppCreated: number;
  pushAttempts: number;
  delivered: number;
  failed: number;
  removedInvalid: number;
  deduplicated: boolean;
  outcome: DispatchOutcome;
};

/** A short, non-identifying handle for one event, safe for logs. */
function subjectTag(subjectId: string): string {
  return subjectId.slice(0, 8);
}

function emptyReport(
  kind: NotificationEventKind,
  subjectId: string,
  source: "action" | "outbox",
  outcome: DispatchOutcome,
  actor = "Someone",
): DispatchReport {
  return {
    event: kind,
    source,
    actor,
    subject: subjectTag(subjectId),
    fingerprint: null,
    audience: 0,
    preferencesAllowed: 0,
    subscribedRecipients: 0,
    inAppCreated: 0,
    pushAttempts: 0,
    delivered: 0,
    failed: 0,
    removedInvalid: 0,
    deduplicated: false,
    outcome,
  };
}

// ---------------------------------------------------------------------------
// Family context
// ---------------------------------------------------------------------------

export type FamilyContext = {
  eventId: string;
  /** Identity for the copy and the deep link. */
  event: NotificationEvent;
  members: NotifiableMember[];
  membersById: Map<string, NotifiableMember>;
  contributorNames: Map<string, string>;
  recipientNames: Map<string, string>;
  balances: NetOwedBalance[];
};

/**
 * WHICH EVENT IS THIS NOTIFICATION ABOUT?
 *
 * Answered by the record being notified about, never by a default. Every
 * notifiable row reaches its event through a relationship the database already
 * guarantees is immutable (migration 025's `protect_event_scope_identity`):
 *
 *   purchase / gift_status  ->  purchases -> christmas_recipients.christmas_event_id
 *   gift_idea               ->  gift_ideas -> christmas_recipients.christmas_event_id
 *   payment                 ->  settlements.christmas_event_id
 *   payment_review          ->  payment_receipts.christmas_event_id
 *
 * That is what replaced the Christmas-by-year lookup this module used to carry.
 * There is deliberately no fallback: a subject whose event cannot be resolved
 * produces no notification rather than a notification attributed to the wrong
 * event.
 */
export async function resolveSubjectEventId(
  kind: NotificationEventKind,
  subjectId: string,
  reader: DataClient,
): Promise<string | null> {
  const viaRecipient = async (recipientId: string | null | undefined) => {
    if (!recipientId) return null;
    const recipient = await reader
      .from("christmas_recipients")
      .select("christmas_event_id")
      .eq("id", recipientId)
      .maybeSingle();
    if (recipient.error || !recipient.data) return null;
    return (recipient.data.christmas_event_id as string) ?? null;
  };

  if (kind === "purchase" || kind === "gift_status") {
    const purchase = await reader
      .from("purchases")
      .select("christmas_recipient_id")
      .eq("id", subjectId)
      .maybeSingle();
    if (purchase.error || !purchase.data) return null;
    return viaRecipient(purchase.data.christmas_recipient_id as string);
  }

  if (kind === "gift_idea") {
    const idea = await reader
      .from("gift_ideas")
      .select("christmas_recipient_id")
      .eq("id", subjectId)
      .maybeSingle();
    if (idea.error || !idea.data) return null;
    return viaRecipient(idea.data.christmas_recipient_id as string);
  }

  if (kind === "payment") {
    const settlement = await reader
      .from("settlements")
      .select("christmas_event_id")
      .eq("id", subjectId)
      .maybeSingle();
    if (settlement.error || !settlement.data) return null;
    return (settlement.data.christmas_event_id as string) ?? null;
  }

  const receipt = await reader
    .from("payment_receipts")
    .select("christmas_event_id")
    .eq("id", subjectId)
    .maybeSingle();
  if (receipt.error || !receipt.data) return null;
  return (receipt.data.christmas_event_id as string) ?? null;
}

/** The event's own row, for the notification's copy and its deep link. */
export async function loadNotificationEvent(
  reader: DataClient,
  eventId: string,
): Promise<NotificationEvent> {
  const event = await reader
    .from("events")
    .select("id,name,event_type")
    .eq("id", eventId)
    .maybeSingle();
  if (event.error || !event.data) throw new NotificationError(503, "That event could not be loaded.");
  return {
    id: event.data.id as string,
    name: event.data.name as string,
    type: event.data.event_type as string,
  };
}

/**
 * Everything a plan needs, loaded once.
 *
 * `app_members` and `notification_preferences` always come from the admin
 * client, because a member is not allowed to read another member's rows and the
 * dispatcher must know the whole family to work out an audience. Christmas data
 * comes from `reader`, which is the caller's own session on the live path so
 * RLS still applies to it.
 */
export async function loadFamilyContext(
  reader: DataClient,
  admin: DataClient,
  eventId: string,
  event?: NotificationEvent,
): Promise<FamilyContext> {
  const [contributors, recipients, memberships, preferences] = await Promise.all([
    reader.from("contributors").select("id,person_id,active").eq("christmas_event_id", eventId),
    reader.from("christmas_recipients").select("id,person_id").eq("christmas_event_id", eventId),
    admin.from("app_members").select("id,person_id,contributor_id,active").eq("active", true),
    admin.from("notification_preferences").select("*"),
  ]);
  if (contributors.error || recipients.error) throw new NotificationError(503, "Christmas contributors could not be loaded.");
  if (memberships.error) throw new NotificationError(503, "Family membership could not be loaded.");
  if (preferences.error) throw new NotificationError(503, notificationSetupError(preferences.error.code));

  const personIds = [...new Set([
    ...contributors.data.map((row: { person_id: string }) => row.person_id),
    ...recipients.data.map((row: { person_id: string }) => row.person_id),
    ...memberships.data.flatMap((row: { person_id: string | null }) => (row.person_id ? [row.person_id] : [])),
  ])];
  const people = personIds.length
    ? await reader.from("people").select("id,name").in("id", personIds)
    : { data: [] as { id: string; name: string }[], error: null };
  if (people.error) throw new NotificationError(503, "Family names could not be loaded.");

  const personNames = new Map<string, string>((people.data ?? []).map((row: { id: string; name: string }) => [row.id, row.name]));
  const contributorNames = new Map<string, string>(contributors.data.map((row: { id: string; person_id: string }) => [
    row.id,
    personNames.get(row.person_id) ?? "Someone",
  ]));
  const recipientNames = new Map<string, string>(recipients.data.map((row: { id: string; person_id: string }) => [
    row.id,
    personNames.get(row.person_id) ?? "Someone",
  ]));
  const preferencesByMember = new Map<string, Record<string, boolean>>(
    preferences.data.map((row: { app_member_id: string }) => [row.app_member_id, row as unknown as Record<string, boolean>]),
  );

  const members: NotifiableMember[] = memberships.data.map((membership: { id: string; person_id: string | null; contributor_id: string | null }) => {
    const contributor = contributors.data.find((row: { id: string; person_id: string; active: boolean }) =>
      row.active && (row.id === membership.contributor_id || row.person_id === membership.person_id),
    );
    const stored = preferencesByMember.get(membership.id);
    return {
      appMemberId: membership.id,
      contributorId: contributor?.id ?? null,
      name: membership.person_id ? personNames.get(membership.person_id) ?? "Someone" : "Someone",
      preferences: stored
        ? {
          purchases: stored.purchases,
          money_i_owe: stored.money_i_owe,
          money_owed_to_me: stored.money_owed_to_me,
          gift_ideas: stored.gift_ideas,
          gift_status: stored.gift_status,
        }
        : DEFAULT_NOTIFICATION_PREFERENCES,
    };
  });

  return {
    eventId,
    event: event ?? await loadNotificationEvent(reader, eventId),
    members,
    membersById: new Map(members.map((row) => [row.appMemberId, row])),
    contributorNames,
    recipientNames,
    balances: await loadAuthoritativeBalances(reader, eventId, [...recipientNames.keys()]),
  };
}

/**
 * The current Owed position, produced by the app's own engine.
 *
 * The query shape and the obligation filter are the same ones
 * `src/app/owed/owed-data.ts` uses to draw the Owed screen, and the arithmetic
 * is `calculateNetOwedBalances` itself, so a notification quotes the figure the
 * screen would show.
 */
export async function loadAuthoritativeBalances(
  reader: DataClient,
  eventId: string,
  recipientIds: string[],
): Promise<NetOwedBalance[]> {
  const [purchases, settlements] = await Promise.all([
    recipientIds.length
      ? reader
        .from("purchases")
        .select("id,checkout_payer_contributor_id")
        .in("christmas_recipient_id", recipientIds)
        .is("deleted_at", null)
      : Promise.resolve({ data: [] as { id: string; checkout_payer_contributor_id: string }[], error: null }),
    reader
      .from("settlements")
      .select("payer_contributor_id,payee_contributor_id,amount_pennies,confirmed_amount_pennies,voided_at")
      .eq("christmas_event_id", eventId),
  ]);
  if (purchases.error || settlements.error) throw new NotificationError(503, "Owed balances could not be loaded.");

  const purchaseRows: { id: string; checkout_payer_contributor_id: string }[] = purchases.data ?? [];
  const allocations = purchaseRows.length
    ? await reader
      .from("purchase_allocations")
      .select("purchase_id,contributor_id,responsibility_pennies")
      .in("purchase_id", purchaseRows.map((row) => row.id))
    : { data: [] as { purchase_id: string; contributor_id: string; responsibility_pennies: number }[], error: null };
  if (allocations.error) throw new NotificationError(503, "Owed balances could not be loaded.");

  const payerByPurchase = new Map(purchaseRows.map((row) => [row.id, row.checkout_payer_contributor_id]));
  const obligations: PurchaseObligation[] = (allocations.data ?? []).flatMap((allocation: { purchase_id: string; contributor_id: string; responsibility_pennies: number }) => {
    const payer = payerByPurchase.get(allocation.purchase_id);
    if (!payer || allocation.responsibility_pennies <= 0 || allocation.contributor_id === payer) return [];
    return [{
      debtorContributorId: allocation.contributor_id,
      creditorContributorId: payer,
      amountPennies: allocation.responsibility_pennies,
    }];
  });

  // `confirmed_amount_pennies` is the figure that moves a balance. A database
  // that has not had migration 021 applied yet simply omits the column, and
  // reading that absence as zero would unsettle every historical payment at
  // once. The claimed amount is the correct fallback: before confirmations
  // existed only a receiver could record a payment, so recorded meant received.
  const ledger: SettlementLedgerEntry[] = (settlements.data ?? []).map((row: { payer_contributor_id: string; payee_contributor_id: string; amount_pennies: number; confirmed_amount_pennies?: number | null; voided_at: string | null }) => ({
    payerContributorId: row.payer_contributor_id,
    payeeContributorId: row.payee_contributor_id,
    amountPennies: row.amount_pennies,
    confirmedAmountPennies: row.confirmed_amount_pennies ?? row.amount_pennies,
    voidedAt: row.voided_at,
  }));

  return calculateNetOwedBalances(obligations, ledger);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type BuiltPlan = {
  planned: PlannedNotification[];
  fingerprint: string;
  /** The actor as recorded on the row itself, never as claimed by a caller. */
  actorAppMemberId: string;
};

/**
 * Decide whether this event may be notified about at all.
 *
 * The live path passes a check that the caller is the recorded actor and that
 * the change happened moments ago. The outbox path passes a no-op, because a
 * trigger inside the write's own transaction already established both.
 */
export type Authorize = (rowActorAppMemberId: string | null, timestamp: string | null) => void;

/**
 * Re-read the subject row and turn it into a plan, or refuse.
 *
 * The actor is always taken from the row's own column, so the audience is built
 * by excluding the person the DATABASE says acted — not the person who asked.
 */
export async function buildPlan(
  kind: NotificationEventKind,
  subjectId: string,
  reader: DataClient,
  context: FamilyContext,
  authorize: Authorize,
): Promise<BuiltPlan | null> {
  if (kind === "purchase" || kind === "gift_status") {
    const purchase = await reader
      .from("purchases")
      .select("id,christmas_recipient_id,actual_price_pennies,checkout_payer_contributor_id,status,created_by_app_member_id,updated_by_app_member_id,created_at,updated_at,deleted_at")
      .eq("id", subjectId)
      .maybeSingle();
    if (purchase.error || !purchase.data || purchase.data.deleted_at) return null;
    const row = purchase.data;

    const allocations = await reader
      .from("purchase_allocations")
      .select("contributor_id,responsibility_pennies")
      .eq("purchase_id", row.id);
    if (allocations.error) return null;
    const allocatedContributorIds = (allocations.data ?? [])
      .filter((allocation: { responsibility_pennies: number }) => allocation.responsibility_pennies > 0)
      .map((allocation: { contributor_id: string }) => allocation.contributor_id);

    if (kind === "purchase") {
      authorize(row.created_by_app_member_id, row.created_at);
      const actorAppMemberId = row.created_by_app_member_id as string;
      return {
        actorAppMemberId,
        // One fingerprint per purchase creation: the several allocation rows the
        // same transaction writes all resolve to this one key.
        fingerprint: "created",
        planned: planPurchaseNotifications(
          {
            actorAppMemberId,
            actorName: nameOf(context, actorAppMemberId),
            recipientName: context.recipientNames.get(row.christmas_recipient_id) ?? "Someone",
            christmasRecipientId: row.christmas_recipient_id,
            amountPennies: row.actual_price_pennies,
            checkoutPayerContributorId: row.checkout_payer_contributor_id,
            allocatedContributorIds,
          },
          context.members,
          context.balances,
        ),
      };
    }

    authorize(row.updated_by_app_member_id, row.updated_at);
    if (row.status !== "purchased" && row.status !== "wrapped") return null;
    const actorAppMemberId = row.updated_by_app_member_id as string;
    return {
      actorAppMemberId,
      // Keyed by the status itself, so marking wrapped after purchased sends
      // once each, and marking wrapped twice sends once.
      fingerprint: `status:${row.status}`,
      planned: planGiftStatusNotifications(
        {
          actorAppMemberId,
          purchaseId: row.id,
          recipientName: context.recipientNames.get(row.christmas_recipient_id) ?? "Someone",
          christmasRecipientId: row.christmas_recipient_id,
          status: row.status,
          relevantContributorIds: [...allocatedContributorIds, row.checkout_payer_contributor_id],
        },
        context.members,
      ),
    };
  }

  if (kind === "payment") {
    const settlement = await reader
      .from("settlements")
      .select("id,payer_contributor_id,payee_contributor_id,amount_pennies,confirmed_amount_pennies,recorded_by_app_member_id,created_at,voided_at")
      .eq("id", subjectId)
      .maybeSingle();
    if (settlement.error || !settlement.data || settlement.data.voided_at) return null;
    const row = settlement.data;

    authorize(row.recorded_by_app_member_id, row.created_at);
    const actorAppMemberId = row.recorded_by_app_member_id as string;

    // A payment created by the admin override is confirmed from the start and
    // nobody agreed to it, so it must not be worded as though somebody did.
    // The receipt is where that fact lives; a database without migration 022
    // simply returns nothing here and the ordinary wording applies.
    const override = await reader
      .from("payment_receipts")
      .select("id")
      .eq("settlement_id", row.id)
      .eq("source", "admin_override")
      .limit(1);

    return {
      actorAppMemberId,
      fingerprint: "recorded",
      planned: planPaymentNotifications(
        {
          actorAppMemberId,
          actorName: nameOf(context, actorAppMemberId),
          settlementId: row.id,
          payerContributorId: row.payer_contributor_id,
          payerName: context.contributorNames.get(row.payer_contributor_id) ?? "Someone",
          payeeContributorId: row.payee_contributor_id,
          payeeName: context.contributorNames.get(row.payee_contributor_id) ?? "Someone",
          amountPennies: row.amount_pennies,
          // Same fallback as the balance loader: without migration 021 a
          // recorded payment was, by definition, one the receiver had already
          // acknowledged.
          confirmedAmountPennies: row.confirmed_amount_pennies ?? row.amount_pennies,
          adminOverride: !override.error && (override.data?.length ?? 0) > 0,
        },
        context.members,
      ),
    };
  }

  if (kind === "payment_review") {
    // The subject is the RECEIPT, not the payment. Three partial confirmations
    // of one claim are three separate events the payer needs to hear about, and
    // every notification table is unique per (kind, subject, fingerprint) — so
    // keying them on the settlement would deliver the first and silently
    // swallow the rest.
    const receipt = await reader
      .from("payment_receipts")
      .select("id,settlement_id,payer_contributor_id,action,amount_pennies,reason,source,reviewed_by_app_member_id,reviewer_contributor_id,created_at")
      .eq("id", subjectId)
      .maybeSingle();
    if (receipt.error || !receipt.data) return null;
    const row = receipt.data;
    // An auto-receipt is already covered by the payment's own notification, and
    // a migrated one describes history from before this feature existed.
    if (row.source !== "review") return null;

    const settlement = await reader
      .from("settlements")
      .select("id,amount_pennies,confirmed_amount_pennies,voided_at")
      .eq("id", row.settlement_id)
      .maybeSingle();
    if (settlement.error || !settlement.data || settlement.data.voided_at) return null;

    authorize(row.reviewed_by_app_member_id, row.created_at);
    const actorAppMemberId = row.reviewed_by_app_member_id as string;

    return {
      actorAppMemberId,
      fingerprint: "reviewed",
      planned: planPaymentReviewNotifications(
        {
          actorAppMemberId,
          reviewerName: context.contributorNames.get(row.reviewer_contributor_id) ?? nameOf(context, actorAppMemberId),
          receiptId: row.id,
          payerContributorId: row.payer_contributor_id,
          action: row.action,
          claimedPennies: settlement.data.amount_pennies,
          confirmedTotalPennies: settlement.data.confirmed_amount_pennies ?? 0,
          reason: row.reason ?? null,
        },
        context.members,
      ),
    };
  }

  const idea = await reader
    .from("gift_ideas")
    .select("id,christmas_recipient_id,suggested_by_app_member_id,created_at")
    .eq("id", subjectId)
    .maybeSingle();
  if (idea.error || !idea.data) return null;
  const row = idea.data;

  authorize(row.suggested_by_app_member_id, row.created_at);
  const actorAppMemberId = row.suggested_by_app_member_id as string;

  return {
    actorAppMemberId,
    fingerprint: "created",
    planned: planGiftIdeaNotifications(
      {
        actorAppMemberId,
        actorName: nameOf(context, actorAppMemberId),
        recipientName: context.recipientNames.get(row.christmas_recipient_id) ?? "Someone",
        christmasRecipientId: row.christmas_recipient_id,
      },
      context.members,
    ),
  };
}

function nameOf(context: FamilyContext, appMemberId: string): string {
  return context.membersById.get(appMemberId)?.name ?? "Someone";
}

/**
 * The live path's authorization: the caller must be the recorded actor, and the
 * change must have happened moments ago.
 */
export function callerMustBeActor(callerAppMemberId: string): Authorize {
  return (rowActorAppMemberId, timestamp) => {
    if (rowActorAppMemberId !== callerAppMemberId) {
      throw new NotificationError(403, "Only the person who made this change can notify the family about it.");
    }
    requireFresh(timestamp);
  };
}

/** The outbox path's: a database trigger already established both facts. */
export const alreadyEstablished: Authorize = (rowActorAppMemberId) => {
  if (!rowActorAppMemberId) {
    throw new NotificationError(409, "This change has no recorded author to notify the family about.");
  }
};

export function requireFresh(timestamp: string | null) {
  const at = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(at) || Date.now() - at > EVENT_FRESHNESS_MS) {
    throw new NotificationError(409, "This change is no longer new enough to notify the family about.");
  }
}

// ---------------------------------------------------------------------------
// Running one event
// ---------------------------------------------------------------------------

export type RunEventInput = {
  admin: DataClient;
  reader: DataClient;
  kind: NotificationEventKind;
  subjectId: string;
  context: FamilyContext;
  authorize: Authorize;
  createPushSender: CreatePushSender;
  source: "action" | "outbox";
};

/**
 * One completed action becomes at most one notification per other member.
 *
 * The order is load-bearing:
 *
 *   plan → claim the ledger → write the in-app rows → attempt push → record
 *
 * The in-app rows are the durable record and are written before any push is
 * attempted, so someone with OS alerts switched off still gets their history.
 * Bookkeeping failures are logged and stepped over rather than thrown: a broken
 * ledger must never be the reason nobody was told, which is precisely the
 * failure this rewrite exists to remove.
 */
export async function runNotificationEvent(input: RunEventInput): Promise<DispatchReport> {
  const { admin, reader, kind, subjectId, context, authorize, createPushSender, source } = input;

  const unstamped = await buildPlan(kind, subjectId, reader, context, authorize);
  if (!unstamped) {
    logNotification({ stage: "not-applicable", kind, source });
    return emptyReport(kind, subjectId, source, "not-applicable");
  }

  /**
   * Stamp the event onto every payload, in ONE place.
   *
   * The builders stay pure and event-agnostic — they know about people and
   * pennies — and this is the single line that makes a notification belong to
   * an occasion: its title names the event, its link points inside the event,
   * and its collapse key is scoped to the event so two events' messages cannot
   * replace one another on the device.
   */
  const built: BuiltPlan = {
    ...unstamped,
    planned: unstamped.planned.map((notification) => ({
      ...notification,
      payload: withEvent(notification.payload, context.event),
    })),
  };

  const actor = shortName(nameOf(context, built.actorAppMemberId));
  const audience = context.members.filter((member) => member.appMemberId !== built.actorAppMemberId).length;

  const base: DispatchReport = {
    ...emptyReport(kind, subjectId, source, "no-audience", actor),
    fingerprint: built.fingerprint,
    audience,
    preferencesAllowed: built.planned.length,
  };

  /**
   * Claim the event, then read back whatever row now exists.
   *
   * `ignoreDuplicates` turns the unique key into a no-op on a repeat rather
   * than an error, so the several allocation rows one purchase writes, a retry,
   * a double-tapped Save and the outbox drain all converge on one row.
   */
  const claim = await admin
    .from("notification_events")
    .upsert({
      kind,
      subject_id: subjectId,
      fingerprint: built.fingerprint,
      actor_app_member_id: built.actorAppMemberId,
      recipient_count: built.planned.length,
    }, { onConflict: "kind,subject_id,fingerprint", ignoreDuplicates: true })
    .select("id");

  let isNewEvent = true;
  if (claim.error) {
    // A broken ledger is a reason to send WITHOUT deduplication, never a reason
    // not to send. The old code threw here and the family heard nothing.
    logNotification({ stage: "ledger-claim-failed", kind, source, reason: claim.error.code ?? "unknown" });
  } else {
    isNewEvent = (claim.data?.length ?? 0) > 0;
  }

  const existing = await admin
    .from("notification_events")
    .select("id,delivered_count,attempt_count")
    .eq("kind", kind)
    .eq("subject_id", subjectId)
    .eq("fingerprint", built.fingerprint)
    .maybeSingle();

  const ledger: { id: string | null; delivered_count: number; attempt_count: number } =
    existing.error || !existing.data
      ? { id: null, delivered_count: 0, attempt_count: 0 }
      : existing.data;
  if (existing.error) {
    // This is the exact shape of the bug that broke every real notification:
    // the ledger read failed (its columns did not exist yet), the dispatcher
    // threw a 503, and the fire-and-forget caller discarded it. Delivery now
    // continues without the bookkeeping.
    logNotification({ stage: "ledger-read-failed", kind, source, reason: existing.error.code ?? "unknown" });
  }

  // The durable half. Written for everyone the event concerns whether or not
  // they have push switched on anywhere, and idempotent in the database rather
  // than conditional on having won the claim — a first attempt that died after
  // claiming must not cost them their history.
  const inAppCreated = await createInAppNotifications(admin, built.planned, kind, subjectId, source);

  if (ledger.delivered_count > 0) {
    logNotification({ stage: "already-delivered", kind, source, deduplicated: true, recipients: built.planned.length });
    return { ...base, inAppCreated, deduplicated: true, outcome: "already-delivered" };
  }

  const delivery = await deliver(admin, built.planned, kind, createPushSender, source);

  if (ledger.id) {
    const update = await admin
      .from("notification_events")
      .update({
        delivered_count: delivery.delivered,
        attempt_count: ledger.attempt_count + 1,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", ledger.id);
    if (update?.error) {
      logNotification({ stage: "ledger-update-failed", kind, source, reason: update.error.code ?? "unknown" });
    }
  }

  const report: DispatchReport = {
    ...base,
    subscribedRecipients: delivery.subscribedRecipients,
    inAppCreated,
    pushAttempts: delivery.attempts,
    delivered: delivery.delivered,
    failed: delivery.failed,
    removedInvalid: delivery.removedInvalid,
    deduplicated: !isNewEvent,
    outcome: delivery.outcome ?? (built.planned.length === 0 ? "no-audience" : "delivered"),
  };

  // The one line that answers "did this actually reach anybody?".
  logNotification({ stage: "dispatched", ...report });
  return report;
}

/**
 * Write one Notification Centre row per planned recipient.
 *
 * Uses the same text the push carries, and relies on
 * `notifications_event_recipient_key` to discard repeats, so this can run on
 * every attempt without ever producing a duplicate entry.
 */
async function createInAppNotifications(
  admin: DataClient,
  planned: PlannedNotification[],
  kind: NotificationEventKind,
  subjectId: string,
  source: string,
): Promise<number> {
  if (planned.length === 0) return 0;

  const rows = planned.map((row) => ({
    app_member_id: row.appMemberId,
    category: row.payload.category,
    title: row.payload.title,
    // The Notification Centre is behind the reader's own sign-in, so it may
    // carry the fuller sentence where there is one. The push copy never does.
    body: row.payload.inAppBody ?? row.payload.body,
    target_url: row.payload.url,
    event_kind: kind,
    event_subject_id: subjectId,
  }));

  const result = await admin
    .from("notifications")
    .upsert(rows, {
      onConflict: "app_member_id,event_kind,event_subject_id,category",
      ignoreDuplicates: true,
    })
    .select("id");

  if (!result.error) return result.data?.length ?? 0;

  // A database that has 019 but not yet 020 has no unique key to conflict on,
  // and PostgREST rejects the conflict target outright. Falling back to a plain
  // insert keeps the Notification Centre working during a partial rollout; the
  // duplicate this could theoretically write only matters on a retry, which is
  // a far better failure than an empty inbox.
  const fallback = await admin.from("notifications").insert(rows).select("id");
  if (!fallback.error) {
    logNotification({ stage: "in-app-write-unkeyed", kind, source, reason: result.error.code ?? "unknown" });
    return fallback.data?.length ?? 0;
  }

  // The push may still be worth attempting, and the action itself is already
  // saved, so this is reported rather than thrown.
  logNotification({ stage: "in-app-write-failed", kind, source, reason: fallback.error.code ?? "unknown" });
  return 0;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

type DeliveryReport = {
  subscribedRecipients: number;
  attempts: number;
  delivered: number;
  failed: number;
  removedInvalid: number;
  outcome: DispatchOutcome | null;
};

const NO_DELIVERY: DeliveryReport = {
  subscribedRecipients: 0,
  attempts: 0,
  delivered: 0,
  failed: 0,
  removedInvalid: 0,
  outcome: null,
};

/**
 * Fan out to every device belonging to every planned member, then retire the
 * endpoints the push services report as permanently gone.
 *
 * Failures are counted, not thrown: one dead endpoint must not stop the rest of
 * the family being told.
 */
async function deliver(
  admin: DataClient,
  planned: PlannedNotification[],
  kind: string,
  createPushSender: CreatePushSender,
  source: string,
): Promise<DeliveryReport> {
  if (planned.length === 0) return { ...NO_DELIVERY, outcome: "no-audience" };

  // Resolved here rather than at the top of dispatch: a missing or malformed
  // key must not stop the in-app notifications being written, which are the
  // durable record. Push is the optional layer.
  const send = createPushSender();
  if (!send) {
    logNotification({ stage: "push-not-configured", kind, source, recipients: planned.length });
    return { ...NO_DELIVERY, outcome: "push-not-configured" };
  }

  const devices = await admin
    .from("push_subscriptions")
    .select("id,app_member_id,endpoint,p256dh,auth")
    .in("app_member_id", [...new Set(planned.map((row) => row.appMemberId))]);
  if (devices.error) {
    logNotification({ stage: "subscription-read-failed", kind, source, reason: devices.error.code ?? "unknown" });
    return { ...NO_DELIVERY, outcome: "push-failed" };
  }

  type DeviceRow = { id: string; app_member_id: string; endpoint: string; p256dh: string; auth: string };
  const deviceRows: DeviceRow[] = devices.data ?? [];
  if (deviceRows.length === 0) {
    // Not an error: the audience was correct and the in-app rows exist, but
    // nobody in it has registered a device.
    logNotification({ stage: "no-subscribed-recipients", kind, source, recipients: planned.length, subscriptions: 0 });
    return { ...NO_DELIVERY, outcome: "no-subscribed-recipients" };
  }

  const byMember = new Map<string, DeviceRow[]>();
  for (const device of deviceRows) {
    byMember.set(device.app_member_id, [...(byMember.get(device.app_member_id) ?? []), device]);
  }

  const jobs = planned.flatMap((notification) =>
    (byMember.get(notification.appMemberId) ?? []).map((device) => ({ device, notification })),
  );

  const results = await Promise.all(jobs.map(async ({ device, notification }) => {
    // `inAppBody` is stripped rather than merely unused: a lock-screen payload
    // must not carry text that was deliberately kept out of the lock screen,
    // whether or not today's service worker happens to read that field.
    const pushPayload = { ...notification.payload };
    delete pushPayload.inAppBody;
    const outcome = await send(
      { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
      JSON.stringify(pushPayload),
    );
    // Every real push service response is recorded. Hostname only — the
    // endpoint path is a per-device bearer token.
    logNotification({
      stage: "push-response",
      kind,
      source,
      pushHost: pushServiceHost(device.endpoint),
      status: outcome.status,
      outcome: outcome.outcome,
      ...(outcome.outcome === "failed" ? { reason: outcome.reason } : {}),
    });
    return { id: device.id, outcome };
  }));

  const expiredIds = results.filter((row) => row.outcome.outcome === "expired").map((row) => row.id);
  if (expiredIds.length > 0) {
    // 404/410 means the browser dropped the subscription — uninstalled app,
    // cleared site data, permission revoked. Anything else, including a 429 or
    // a 5xx, is left alone so a wobbling push service cannot unsubscribe the
    // whole family.
    await admin.from("push_subscriptions").delete().in("id", expiredIds);
  }

  const deliveredIds = results.filter((row) => row.outcome.outcome === "sent").map((row) => row.id);
  if (deliveredIds.length > 0) {
    await admin
      .from("push_subscriptions")
      .update({ last_delivery_at: new Date().toISOString(), failure_count: 0 })
      .in("id", deliveredIds);
  }

  const failed = results.filter((row) => row.outcome.outcome === "failed").length;
  return {
    subscribedRecipients: byMember.size,
    attempts: jobs.length,
    delivered: deliveredIds.length,
    failed,
    removedInvalid: expiredIds.length,
    outcome: deliveredIds.length > 0 ? "delivered" : failed > 0 ? "push-failed" : "no-subscribed-recipients",
  };
}

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

/** Outcomes that mean there is nothing left to try for this outbox row. */
const SETTLED: DispatchOutcome[] = [
  "delivered",
  "already-delivered",
  "not-applicable",
  "no-audience",
  "no-subscribed-recipients",
];

export type DrainInput = {
  admin: DataClient;
  createPushSender: CreatePushSender;
  limit?: number;
  /** Injected so a test can supply a context without a live Christmas event. */
  loadContext?: (admin: DataClient) => Promise<FamilyContext>;
};

/**
 * Deliver events the browser never managed to hand over.
 *
 * A database trigger writes an outbox row in the same transaction as the
 * purchase, gift idea or payment itself, so the event survives the tab being
 * closed, the network dropping, the request being cancelled by navigation, or
 * the dispatch call failing outright. This drains whatever is still pending.
 *
 * Reads use the admin client because there is no session here. That is safe:
 * a row can only exist if the write it describes committed, its actor comes
 * from the row's own column, and every word of every message is still derived
 * from authoritative data. Nothing a member could influence chooses a recipient
 * or a wording.
 *
 * Never throws. It runs alongside user-facing requests and must not be able to
 * break one.
 */
export async function drainNotificationOutbox(input: DrainInput): Promise<DispatchReport[]> {
  const { admin, createPushSender } = input;
  const limit = input.limit ?? OUTBOX_BATCH_SIZE;

  const pending = await admin
    .from("notification_outbox")
    .select("id,kind,subject_id,fingerprint,actor_app_member_id,attempts")
    .is("processed_at", null)
    .lt("attempts", MAX_OUTBOX_ATTEMPTS)
    .gte("created_at", new Date(Date.now() - OUTBOX_WINDOW_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);

  if (pending.error) {
    logNotification({ stage: "outbox-unavailable", reason: pending.error.code ?? "unknown" });
    return [];
  }
  type OutboxRow = { id: string; kind: NotificationEventKind; subject_id: string; attempts: number };
  const rows: OutboxRow[] = pending.data ?? [];
  if (rows.length === 0) return [];

  /**
   * One context per EVENT, not one per drain.
   *
   * A batch can hold rows from several events at once — a Christmas purchase
   * and a birthday payment can be queued seconds apart — so the context is
   * resolved from each row's own subject and cached by event id. The cache is
   * what stops a batch of ten Christmas rows loading the same family ten times;
   * it is per-drain and never outlives the call.
   */
  const contextByEvent = new Map<string, FamilyContext>();
  const contextFor = async (kind: NotificationEventKind, subjectId: string): Promise<FamilyContext | null> => {
    if (input.loadContext) return input.loadContext(admin);
    const eventId = await resolveSubjectEventId(kind, subjectId, admin);
    if (!eventId) return null;
    const cached = contextByEvent.get(eventId);
    if (cached) return cached;
    const loaded = await loadFamilyContext(admin, admin, eventId);
    contextByEvent.set(eventId, loaded);
    return loaded;
  };

  const reports: DispatchReport[] = [];
  for (const row of rows) {
    let report: DispatchReport;
    try {
      const context = await contextFor(row.kind, row.subject_id);
      if (!context) {
        // The subject is gone, or its event cannot be resolved. Retire the row
        // rather than retrying forever: there is nothing left to describe.
        logNotification({ stage: "outbox-event-unresolved", kind: row.kind, source: "outbox" });
        await settleOutboxRow(admin, row.kind, row.subject_id, null, row.id);
        continue;
      }
      report = await runNotificationEvent({
        admin,
        reader: admin,
        kind: row.kind,
        subjectId: row.subject_id,
        context,
        authorize: alreadyEstablished,
        createPushSender,
        source: "outbox",
      });
    } catch (error) {
      logNotification({ stage: "outbox-event-failed", kind: row.kind, reason: errorName(error) });
      await markOutboxAttempt(admin, row.id, row.attempts, false);
      continue;
    }
    reports.push(report);
    await markOutboxAttempt(admin, row.id, row.attempts, SETTLED.includes(report.outcome));
  }

  logNotification({ stage: "outbox-drained", recipients: reports.length });
  return reports;
}

async function markOutboxAttempt(admin: DataClient, id: string, attempts: number, settled: boolean) {
  const result = await admin
    .from("notification_outbox")
    .update({
      attempts: attempts + 1,
      last_attempt_at: new Date().toISOString(),
      ...(settled ? { processed_at: new Date().toISOString() } : {}),
    })
    .eq("id", id);
  if (result?.error) {
    logNotification({ stage: "outbox-update-failed", reason: result.error.code ?? "unknown" });
  }
}

/**
 * Mark the outbox row for an event that has just been delivered live, so the
 * drain does not pick up work that is already done.
 *
 * Keyed on the fingerprint as well as the subject, because one purchase can
 * hold several pending rows — "purchased" and then "wrapped" — and settling the
 * one that just went out must not silence the other.
 */
export async function settleOutboxRow(
  admin: DataClient,
  kind: NotificationEventKind,
  subjectId: string,
  fingerprint: string | null,
  /**
   * Retire one specific row when its fingerprint is unknown — the case where
   * the subject, and therefore its event, can no longer be resolved at all.
   */
  outboxRowId?: string,
): Promise<void> {
  const query = admin
    .from("notification_outbox")
    .update({ processed_at: new Date().toISOString() });
  const result = outboxRowId
    ? await query.eq("id", outboxRowId).is("processed_at", null)
    : await query
      .eq("kind", kind)
      .eq("subject_id", subjectId)
      .eq("fingerprint", fingerprint)
      .is("processed_at", null);
  if (result?.error) {
    logNotification({ stage: "outbox-settle-failed", kind, reason: result.error.code ?? "unknown" });
  }
}

function errorName(error: unknown): string {
  return error instanceof NotificationError
    ? `NotificationError:${error.status}`
    : error instanceof Error
      ? error.name
      : "UnknownError";
}

export function notificationSetupError(code?: string | null) {
  if (code === "42P01" || code === "PGRST205" || code === "42883" || code === "PGRST202") {
    return "Notifications are not ready yet. Apply the push notifications migration, then try again.";
  }
  return "Notification settings could not be saved.";
}
