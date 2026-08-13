import "server-only";

import { createClient as createAdminSupabaseClient } from "@supabase/supabase-js";
import {
  calculateNetOwedBalances,
  type NetOwedBalance,
  type PurchaseObligation,
  type SettlementLedgerEntry,
} from "@/lib/owed";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  planGiftIdeaNotifications,
  planGiftStatusNotifications,
  planPaymentNotifications,
  planPurchaseNotifications,
  type NotifiableMember,
  type PlannedNotification,
} from "@/lib/notification-audience";
import { validateUuid } from "@/lib/input-validation";
import {
  assertValidVapidKeys,
  sendPushNotification,
  type PushSubscriptionKeys,
  type VapidKeys,
} from "@/lib/web-push";
import { createClient as createSessionClient } from "../../../utils/supabase/server";

const CHRISTMAS_YEAR = 2026;

/**
 * How old a row may be and still justify a notification.
 *
 * Dispatch is triggered by the client immediately after its write succeeds, so
 * a legitimate call is seconds old. The window exists so that a member who
 * knows a purchase id cannot replay it weeks later to buzz everyone's phone;
 * `notification_events` already stops the same event sending twice, and this
 * stops old events being introduced at all.
 */
const EVENT_FRESHNESS_MS = 10 * 60 * 1000;

export class NotificationError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "NotificationError";
  }
}

export type NotificationEventKind = "purchase" | "payment" | "gift_idea" | "gift_status";

/** Coarse platform hints, used only to label a device for its own owner. */
const DEVICE_LABELS: Record<string, string> = {
  ios: "iPhone or iPad",
  android: "Android device",
  windows: "Windows PC",
  mac: "Mac",
  other: "This device",
};

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseSecretKey) {
    throw new NotificationError(503, "Notifications are not configured on the server.");
  }
  return createAdminSupabaseClient(supabaseUrl, supabaseSecretKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * The VAPID key pair, read at call time from the server environment.
 *
 * `VAPID_PUBLIC_KEY` is safe to hand to a browser and is served by
 * `/api/notifications/key`; `VAPID_PRIVATE_KEY` is read only here and never
 * leaves this module. Neither is ever logged, and the public key is not a
 * `NEXT_PUBLIC_` variable on purpose — that would bake it into the client
 * bundle at build time and make rotating it a rebuild instead of a restart.
 */
export function readVapidKeys(): VapidKeys {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    throw new NotificationError(503, "Notifications are not configured on the server.");
  }
  const keys: VapidKeys = { publicKey, privateKey, subject };
  try {
    assertValidVapidKeys(keys);
  } catch {
    // The underlying message names which key is malformed; it is deliberately
    // not forwarded, so nothing about key material reaches a client response.
    throw new NotificationError(503, "Notifications are not configured correctly on the server.");
  }
  return keys;
}

export function readVapidPublicKey(): string {
  return readVapidKeys().publicKey;
}

/** The signed-in member, or a refusal. Every entry point starts here. */
export async function requireNotificationMember() {
  const session = await createSessionClient();
  const auth = await session.auth.getUser();
  if (auth.error || !auth.data.user) {
    throw new NotificationError(401, "You must sign in to manage notifications.");
  }

  const membership = await session
    .from("app_members")
    .select("id,person_id,contributor_id,role,active")
    .eq("user_id", auth.data.user.id)
    .eq("active", true)
    .maybeSingle();
  if (membership.error || !membership.data) {
    throw new NotificationError(403, "Your active family membership could not be verified.");
  }

  return { session, member: membership.data };
}

// ---------------------------------------------------------------------------
// Device registration
// ---------------------------------------------------------------------------

export type DeviceRegistration = {
  endpoint: string;
  p256dh: string;
  auth: string;
  platform?: string;
};

/**
 * Store, or refresh, one browser's push subscription against the caller's
 * membership.
 *
 * The member id is taken from the verified session and never from the request
 * body, so a member cannot register a device onto somebody else's account. The
 * endpoint is the conflict target: a browser that re-subscribes reuses its
 * endpoint, and if that endpoint was previously somebody else's on a shared
 * computer, the row moves to whoever is signed in now rather than continuing to
 * deliver their notifications to the previous person.
 */
export async function registerDevice(registration: DeviceRegistration) {
  const { member } = await requireNotificationMember();
  const admin = createAdminClient();

  const endpoint = validatePushEndpoint(registration.endpoint);
  const p256dh = validateKeyMaterial(registration.p256dh, 80, 200, "device key");
  const auth = validateKeyMaterial(registration.auth, 16, 60, "device secret");
  const deviceLabel = DEVICE_LABELS[String(registration.platform ?? "other").toLowerCase()]
    ?? DEVICE_LABELS.other;

  const result = await admin
    .from("push_subscriptions")
    .upsert({
      app_member_id: member.id,
      endpoint,
      p256dh,
      auth,
      device_label: deviceLabel,
      last_seen_at: new Date().toISOString(),
      failure_count: 0,
    }, { onConflict: "endpoint" })
    .select("id")
    .maybeSingle();

  if (result.error) {
    throw new NotificationError(503, notificationSetupError(result.error.code));
  }
  return { registered: true as const };
}

/**
 * Forget one device. Scoped to the caller's own membership, so posting somebody
 * else's endpoint deletes nothing and reports the same success — there is no
 * response difference an attacker could use to probe whether an endpoint exists.
 */
export async function removeDevice(endpoint: string) {
  const { member } = await requireNotificationMember();
  const admin = createAdminClient();

  const result = await admin
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", validatePushEndpoint(endpoint))
    .eq("app_member_id", member.id);

  if (result.error) throw new NotificationError(503, notificationSetupError(result.error.code));
  return { removed: true as const };
}

/** Whether this exact browser is currently registered for the signed-in member. */
export async function readDeviceStatus(endpoint: string | null) {
  const { member } = await requireNotificationMember();
  const admin = createAdminClient();

  const devices = await admin
    .from("push_subscriptions")
    .select("endpoint")
    .eq("app_member_id", member.id);
  if (devices.error) throw new NotificationError(503, notificationSetupError(devices.error.code));

  const normalized = endpoint ? safeEndpoint(endpoint) : null;
  return {
    // A count, never the endpoints themselves — the page only needs to say
    // "also on 2 other devices".
    deviceCount: devices.data.length,
    thisDeviceRegistered: normalized !== null
      && devices.data.some((row) => row.endpoint === normalized),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Turn one completed application action into at most one notification per other
 * member.
 *
 * The request body carries only a kind and a row id. Everything else — who is
 * notified, what the text says, which figures appear — is derived here from
 * authoritative data. A member therefore cannot choose the audience, cannot
 * choose the wording, and cannot cause a send for an action they did not
 * perform: the row is re-read through their own RLS-scoped session, and the
 * actor column on it must be them.
 */
export async function dispatchNotificationEvent(kind: NotificationEventKind, subjectId: string) {
  const { session, member } = await requireNotificationMember();
  const id = validateUuid(subjectId, "A valid record is required.");
  if (!id.ok) throw new NotificationError(400, id.error);

  const keys = readVapidKeys();
  const admin = createAdminClient();

  const event = await session
    .from("christmas_events")
    .select("id")
    .eq("year", CHRISTMAS_YEAR)
    .maybeSingle();
  if (event.error || !event.data) throw new NotificationError(503, "Christmas 2026 could not be loaded.");

  const context = await loadFamilyContext(session, admin, event.data.id);
  const built = await buildPlan(kind, id.value, member.id, session, context);
  if (!built) return { sent: 0, skipped: "not-applicable" as const };

  // Claim the event before sending. A duplicate request — a retry, a
  // double-tapped Save, or the several row writes one purchase produces — loses
  // this insert and sends nothing.
  const claim = await admin
    .from("notification_events")
    .insert({
      kind,
      subject_id: id.value,
      fingerprint: built.fingerprint,
      actor_app_member_id: member.id,
      recipient_count: built.planned.length,
    })
    .select("id")
    .maybeSingle();

  if (claim.error) {
    // 23505 is the unique violation: already notified, nothing to do.
    if (claim.error.code === "23505") return { sent: 0, skipped: "already-sent" as const };
    throw new NotificationError(503, notificationSetupError(claim.error.code));
  }

  return { sent: await deliver(admin, built.planned, keys), skipped: null };
}

type FamilyContext = {
  eventId: string;
  members: NotifiableMember[];
  membersById: Map<string, NotifiableMember>;
  contributorNames: Map<string, string>;
  recipientNames: Map<string, string>;
  balances: NetOwedBalance[];
};

/**
 * Everything a plan needs, loaded once.
 *
 * Christmas data comes through the caller's own session so RLS still applies to
 * it; only `app_members` and `notification_preferences` use the admin client,
 * because a member is not allowed to read another member's row and the
 * dispatcher must know the whole family to work out an audience.
 */
async function loadFamilyContext(
  session: Awaited<ReturnType<typeof createSessionClient>>,
  admin: AdminClient,
  eventId: string,
): Promise<FamilyContext> {
  const [contributors, recipients, memberships, preferences] = await Promise.all([
    session.from("contributors").select("id,person_id,active").eq("christmas_event_id", eventId),
    session.from("christmas_recipients").select("id,person_id").eq("christmas_event_id", eventId),
    admin.from("app_members").select("id,person_id,contributor_id,active").eq("active", true),
    admin.from("notification_preferences").select("*"),
  ]);
  if (contributors.error || recipients.error) throw new NotificationError(503, "Christmas contributors could not be loaded.");
  if (memberships.error) throw new NotificationError(503, "Family membership could not be loaded.");
  if (preferences.error) throw new NotificationError(503, notificationSetupError(preferences.error.code));

  const personIds = [...new Set([
    ...contributors.data.map((row) => row.person_id),
    ...recipients.data.map((row) => row.person_id),
    ...memberships.data.flatMap((row) => (row.person_id ? [row.person_id] : [])),
  ])];
  const people = personIds.length
    ? await session.from("people").select("id,name").in("id", personIds)
    : { data: [] as { id: string; name: string }[], error: null };
  if (people.error) throw new NotificationError(503, "Family names could not be loaded.");

  const personNames = new Map((people.data ?? []).map((row) => [row.id, row.name]));
  const contributorNames = new Map(contributors.data.map((row) => [
    row.id,
    personNames.get(row.person_id) ?? "Someone",
  ]));
  const recipientNames = new Map(recipients.data.map((row) => [
    row.id,
    personNames.get(row.person_id) ?? "Someone",
  ]));
  const preferencesByMember = new Map(preferences.data.map((row) => [row.app_member_id, row]));

  const members: NotifiableMember[] = memberships.data.map((membership) => {
    const contributor = contributors.data.find((row) =>
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
    members,
    membersById: new Map(members.map((row) => [row.appMemberId, row])),
    contributorNames,
    recipientNames,
    balances: await loadAuthoritativeBalances(session, eventId, [...recipientNames.keys()]),
  };
}

/**
 * The current Owed position, produced by the app's own engine.
 *
 * The query shape and the obligation filter below are the same ones
 * `src/app/owed/owed-data.ts` uses to draw the Owed screen, and the arithmetic
 * is `calculateNetOwedBalances` itself. That is the whole point: a notification
 * quotes the figure the screen would show, because it is literally the same
 * calculation over the same rows.
 */
async function loadAuthoritativeBalances(
  session: Awaited<ReturnType<typeof createSessionClient>>,
  eventId: string,
  recipientIds: string[],
): Promise<NetOwedBalance[]> {
  const [purchases, settlements] = await Promise.all([
    recipientIds.length
      ? session
        .from("purchases")
        .select("id,checkout_payer_contributor_id")
        .in("christmas_recipient_id", recipientIds)
        .is("deleted_at", null)
      : Promise.resolve({ data: [] as { id: string; checkout_payer_contributor_id: string }[], error: null }),
    session
      .from("settlements")
      .select("payer_contributor_id,payee_contributor_id,amount_pennies,voided_at")
      .eq("christmas_event_id", eventId),
  ]);
  if (purchases.error || settlements.error) throw new NotificationError(503, "Owed balances could not be loaded.");

  const purchaseRows = purchases.data ?? [];
  const allocations = purchaseRows.length
    ? await session
      .from("purchase_allocations")
      .select("purchase_id,contributor_id,responsibility_pennies")
      .in("purchase_id", purchaseRows.map((row) => row.id))
    : { data: [] as { purchase_id: string; contributor_id: string; responsibility_pennies: number }[], error: null };
  if (allocations.error) throw new NotificationError(503, "Owed balances could not be loaded.");

  const payerByPurchase = new Map(purchaseRows.map((row) => [row.id, row.checkout_payer_contributor_id]));
  const obligations: PurchaseObligation[] = (allocations.data ?? []).flatMap((allocation) => {
    const payer = payerByPurchase.get(allocation.purchase_id);
    if (!payer || allocation.responsibility_pennies <= 0 || allocation.contributor_id === payer) return [];
    return [{
      debtorContributorId: allocation.contributor_id,
      creditorContributorId: payer,
      amountPennies: allocation.responsibility_pennies,
    }];
  });

  const ledger: SettlementLedgerEntry[] = (settlements.data ?? []).map((row) => ({
    payerContributorId: row.payer_contributor_id,
    payeeContributorId: row.payee_contributor_id,
    amountPennies: row.amount_pennies,
    voidedAt: row.voided_at,
  }));

  return calculateNetOwedBalances(obligations, ledger);
}

type BuiltPlan = { planned: PlannedNotification[]; fingerprint: string };

/**
 * Re-read the subject row and turn it into a plan, or refuse.
 *
 * Every branch checks three things before planning anything: the row is visible
 * to the caller under RLS, the caller is the person recorded as having acted on
 * it, and it happened just now.
 */
async function buildPlan(
  kind: NotificationEventKind,
  subjectId: string,
  actorAppMemberId: string,
  session: Awaited<ReturnType<typeof createSessionClient>>,
  context: FamilyContext,
): Promise<BuiltPlan | null> {
  const actorName = context.membersById.get(actorAppMemberId)?.name ?? "Someone";

  if (kind === "purchase" || kind === "gift_status") {
    const purchase = await session
      .from("purchases")
      .select("id,christmas_recipient_id,actual_price_pennies,checkout_payer_contributor_id,status,created_by_app_member_id,updated_by_app_member_id,created_at,updated_at,deleted_at")
      .eq("id", subjectId)
      .maybeSingle();
    if (purchase.error || !purchase.data || purchase.data.deleted_at) return null;
    const row = purchase.data;

    const allocations = await session
      .from("purchase_allocations")
      .select("contributor_id,responsibility_pennies")
      .eq("purchase_id", row.id);
    if (allocations.error) return null;
    const allocatedContributorIds = (allocations.data ?? [])
      .filter((allocation) => allocation.responsibility_pennies > 0)
      .map((allocation) => allocation.contributor_id);

    if (kind === "purchase") {
      if (row.created_by_app_member_id !== actorAppMemberId) {
        throw new NotificationError(403, "Only the person who made this change can notify the family about it.");
      }
      requireFresh(row.created_at);
      return {
        // One fingerprint per purchase creation: the several allocation rows the
        // same transaction writes all resolve to this one key.
        fingerprint: "created",
        planned: planPurchaseNotifications(
          {
            actorAppMemberId,
            actorName,
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

    if (row.updated_by_app_member_id !== actorAppMemberId) {
      throw new NotificationError(403, "Only the person who made this change can notify the family about it.");
    }
    requireFresh(row.updated_at);
    if (row.status !== "purchased" && row.status !== "wrapped") return null;
    return {
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
    const settlement = await session
      .from("settlements")
      .select("id,payer_contributor_id,payee_contributor_id,amount_pennies,recorded_by_app_member_id,created_at,voided_at")
      .eq("id", subjectId)
      .maybeSingle();
    if (settlement.error || !settlement.data || settlement.data.voided_at) return null;
    const row = settlement.data;

    if (row.recorded_by_app_member_id !== actorAppMemberId) {
      throw new NotificationError(403, "Only the person who made this change can notify the family about it.");
    }
    requireFresh(row.created_at);

    return {
      fingerprint: "recorded",
      planned: planPaymentNotifications(
        {
          actorAppMemberId,
          actorName,
          settlementId: row.id,
          payerContributorId: row.payer_contributor_id,
          payeeContributorId: row.payee_contributor_id,
          amountPennies: row.amount_pennies,
        },
        context.members,
      ),
    };
  }

  const idea = await session
    .from("gift_ideas")
    .select("id,christmas_recipient_id,suggested_by_app_member_id,created_at")
    .eq("id", subjectId)
    .maybeSingle();
  if (idea.error || !idea.data) return null;
  const row = idea.data;

  if (row.suggested_by_app_member_id !== actorAppMemberId) {
    throw new NotificationError(403, "Only the person who made this change can notify the family about it.");
  }
  requireFresh(row.created_at);

  return {
    fingerprint: "created",
    planned: planGiftIdeaNotifications(
      {
        actorAppMemberId,
        actorName,
        recipientName: context.recipientNames.get(row.christmas_recipient_id) ?? "Someone",
        christmasRecipientId: row.christmas_recipient_id,
      },
      context.members,
    ),
  };
}

/**
 * Fan out to every device belonging to every planned member, then retire the
 * endpoints the push services report as permanently gone.
 *
 * Failures are counted, not thrown: one dead endpoint must not stop the rest of
 * the family being told.
 */
async function deliver(
  admin: AdminClient,
  planned: PlannedNotification[],
  keys: VapidKeys,
): Promise<number> {
  if (planned.length === 0) return 0;

  const devices = await admin
    .from("push_subscriptions")
    .select("id,app_member_id,endpoint,p256dh,auth")
    .in("app_member_id", [...new Set(planned.map((row) => row.appMemberId))]);
  if (devices.error || devices.data.length === 0) return 0;

  const byMember = new Map<string, typeof devices.data>();
  for (const device of devices.data) {
    byMember.set(device.app_member_id, [...(byMember.get(device.app_member_id) ?? []), device]);
  }

  const jobs = planned.flatMap((notification) =>
    (byMember.get(notification.appMemberId) ?? []).map((device) => ({ device, notification })),
  );

  const results = await Promise.all(jobs.map(async ({ device, notification }) => {
    const subscription: PushSubscriptionKeys = {
      endpoint: device.endpoint,
      p256dh: device.p256dh,
      auth: device.auth,
    };
    const outcome = await sendPushNotification(
      subscription,
      JSON.stringify(notification.payload),
      keys,
    );
    return { id: device.id, outcome };
  }));

  const expiredIds = results.filter((row) => row.outcome.outcome === "expired").map((row) => row.id);
  if (expiredIds.length > 0) {
    // 404/410 means the browser dropped the subscription — uninstalled app,
    // cleared site data, permission revoked. The row can never work again, so
    // it goes rather than being retried forever.
    await admin.from("push_subscriptions").delete().in("id", expiredIds);
  }

  const deliveredIds = results.filter((row) => row.outcome.outcome === "sent").map((row) => row.id);
  if (deliveredIds.length > 0) {
    await admin
      .from("push_subscriptions")
      .update({ last_delivery_at: new Date().toISOString(), failure_count: 0 })
      .in("id", deliveredIds);
  }

  return deliveredIds.length;
}

function requireFresh(timestamp: string | null) {
  const at = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(at) || Date.now() - at > EVENT_FRESHNESS_MS) {
    throw new NotificationError(409, "This change is no longer new enough to notify the family about.");
  }
}

function validatePushEndpoint(value: unknown): string {
  const endpoint = safeEndpoint(value);
  if (!endpoint) throw new NotificationError(400, "A valid push endpoint is required.");
  return endpoint;
}

function safeEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  try {
    // https only: an endpoint is a URL this server will POST to, so anything
    // else would turn device registration into a request-forgery primitive.
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function validateKeyMaterial(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new NotificationError(400, `A valid ${label} is required.`);
  }
  return value;
}

function notificationSetupError(code?: string) {
  if (code === "42P01" || code === "PGRST205" || code === "42883" || code === "PGRST202") {
    return "Notifications are not ready yet. Apply the push notifications migration, then try again.";
  }
  return "Notification settings could not be saved.";
}
