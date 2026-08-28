import "server-only";

import { createClient as createAdminSupabaseClient } from "@supabase/supabase-js";
import { validateUuid } from "@/lib/input-validation";
import { assertValidVapidKeys, sendPushNotification, type VapidKeys } from "@/lib/web-push";
import { logNotification, pushServiceHost } from "@/lib/notification-log";
import {
  alreadyEstablished,
  callerMustBeActor,
  drainNotificationOutbox,
  loadFamilyContext,
  resolveSubjectAreaId,
  resolveSubjectEventId,
  NotificationError,
  notificationSetupError,
  runNotificationEvent,
  settleOutboxRow,
  type CreatePushSender,
  type DataClient,
  type DispatchReport,
  type NotificationEventKind,
} from "@/lib/notification-dispatch";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { createClient as createSessionClient } from "@/utils/supabase/server";

export { NotificationError };
export type { NotificationEventKind, DispatchReport };

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

/**
 * The one push sender the whole app uses.
 *
 * "Send test notification" and every real event now go through this same
 * function with the same keys, so a working test genuinely proves the transport
 * a real event will take. Returns `null` when push is not configured, which
 * degrades to "no OS alert" rather than "the event never happened".
 */
const createPushSender: CreatePushSender = () => {
  let keys: VapidKeys;
  try {
    keys = readVapidKeys();
  } catch {
    return null;
  }
  return (subscription, payload) => sendPushNotification(subscription, payload, keys);
};

/** The signed-in member, or a refusal. Every entry point starts here. */
export async function requireNotificationMember() {
  const session = await createSessionClient();
  const auth = await session.auth.getUser();
  if (auth.error || !auth.data.user) {
    throw new NotificationError(401, "You must sign in to manage notifications.");
  }

  // The membership in the family on screen. A `maybeSingle()` here would error
  // for a login that belongs to two, and their notification settings would
  // simply stop working -- in both families.
  const { member } = await getCurrentMember();
  if (!member) {
    throw new NotificationError(403, "Your active family membership could not be verified.");
  }

  return { session, member };
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

  // How many OTHER members could receive a push right now. A count only: no
  // names, no endpoints. This exists because of a real failure — every device
  // registered belonged to one person, so every notification they triggered was
  // correctly suppressed by actor exclusion and nothing was ever sent. The page
  // now says so plainly instead of looking healthy while reaching nobody.
  const others = await admin
    .from("push_subscriptions")
    .select("app_member_id")
    .neq("app_member_id", member.id);
  if (others.error) throw new NotificationError(503, notificationSetupError(others.error.code));

  const normalized = endpoint ? safeEndpoint(endpoint) : null;
  return {
    // A count, never the endpoints themselves — the page only needs to say
    // "also on 2 other devices".
    deviceCount: devices.data.length,
    thisDeviceRegistered: normalized !== null
      && devices.data.some((row) => row.endpoint === normalized),
    otherMembersWithPush: new Set(others.data.map((row) => row.app_member_id)).size,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * "Something I just did is worth telling the family about."
 *
 * The request body carries only a kind and a row id. Everything else — who is
 * notified, what the text says, which figures appear — is derived from
 * authoritative data. A member therefore cannot choose the audience, cannot
 * choose the wording, and cannot cause a send for an action they did not
 * perform: the row is re-read through their own RLS-scoped session, and the
 * actor column on it must be them.
 *
 * This is now the FAST path, not the only path. A database trigger has already
 * recorded the same event in `notification_outbox`, so if this call never
 * arrives the family is still told — see `drainNotificationOutbox`.
 */
export async function dispatchNotificationEvent(
  kind: NotificationEventKind,
  subjectId: string,
): Promise<DispatchReport> {
  const { session, member } = await requireNotificationMember();
  const id = validateUuid(subjectId, "A valid record is required.");
  if (!id.ok) throw new NotificationError(400, id.error);

  const admin = createAdminClient();
  const reader = session as unknown as DataClient;

  // The event comes from the record being notified about, never from a
  // default. A subject whose event cannot be resolved is not notifiable.
  const eventId = await resolveSubjectEventId(kind, id.value, reader);
  if (!eventId) throw new NotificationError(404, "That record could not be found.");
  /*
   * WHICH FAMILY IS TOLD. Resolved from the subject's own event, never from the
   * request, and passed on so the audience is drawn from that Area alone.
   *
   * WITHOUT IT THIS IS A CROSS-AREA BROADCAST. `loadFamilyContext` builds its
   * audience through the ADMIN client, which bypasses row level security; with
   * no Area to narrow to it returns every active membership in every family.
   * Omitting this argument sent "New gift idea for <someone>" -- another
   * family's person, by name -- to every member of every other Area, and wrote
   * those rows into their notification centres. Proven against the real
   * database before it was fixed, and pinned by a test.
   */
  const areaId = await resolveSubjectAreaId(kind, id.value, eventId, reader);
  const context = await loadFamilyContext(reader, admin as unknown as DataClient, eventId, undefined, areaId);

  const report = await runNotificationEvent({
    admin: admin as unknown as DataClient,
    reader,
    kind,
    subjectId: id.value,
    context,
    // The live path's guarantee: the caller must be the person the row records
    // as having acted, and the change must have happened moments ago.
    authorize: callerMustBeActor(member.id),
    createPushSender,
    source: "action",
  });

  // Handled here, so the drain does not repeat work that has just been done.
  // Nothing to settle when the row turned out not to be notifiable at all — the
  // drain will reach the same conclusion and retire it.
  if (report.fingerprint) {
    await settleOutboxRow(admin as unknown as DataClient, kind, id.value, report.fingerprint);
  }

  // Anything the browser failed to hand over earlier goes out now, on the back
  // of a request that is already authenticated and already warm.
  await flushNotificationOutbox();

  return report;
}

/**
 * Deliver events whose dispatch call never arrived.
 *
 * Safe to call from any authenticated request and never throws: a stuck outbox
 * must not break the page that happened to be draining it.
 */
export async function flushNotificationOutbox(): Promise<DispatchReport[]> {
  try {
    const admin = createAdminClient();
    return await drainNotificationOutbox({
      admin: admin as unknown as DataClient,
      createPushSender,
    });
  } catch (error) {
    logNotification({
      stage: "outbox-flush-failed",
      reason: error instanceof Error ? error.name : "UnknownError",
    });
    return [];
  }
}

/**
 * Deliver ONE outbox event without a session, for a server-side retry.
 *
 * Exported for completeness of the outbox story; the actor is taken from the
 * row itself, which a database trigger wrote inside the write's transaction.
 */
export async function dispatchOutboxEvent(kind: NotificationEventKind, subjectId: string) {
  const admin = createAdminClient() as unknown as DataClient;
  const eventId = await resolveSubjectEventId(kind, subjectId, admin);
  if (!eventId) throw new NotificationError(404, "That record could not be found.");
  // The retry path narrows to the subject's Area for the same reason the live
  // one does: the admin client sees every family, so an unscoped audience tells
  // all of them.
  const areaId = await resolveSubjectAreaId(kind, subjectId, eventId, admin);
  const context = await loadFamilyContext(admin, admin, eventId, undefined, areaId);
  return runNotificationEvent({
    admin,
    reader: admin,
    kind,
    subjectId,
    context,
    authorize: alreadyEstablished,
    createPushSender,
    source: "outbox",
  });
}

/**
 * "Send test notification": a real push, through the real pipeline, to the
 * devices of the person who pressed the button and nobody else.
 *
 * This is the diagnostic the system was missing. Every other notification is
 * suppressed for the person who caused it, which is correct but means a lone
 * tester can never see one — exactly how a fully working transport went
 * unnoticed while nothing appeared to arrive.
 *
 * Security: there is no generic send endpoint. The recipient is the
 * authenticated member, taken from the session and never from the request. The
 * text is the fixed constant below and cannot be supplied by the caller. So the
 * worst this can do is send a member a notification they asked for.
 */
export async function sendTestNotification() {
  const { member } = await requireNotificationMember();
  const admin = createAdminClient();

  const devices = await admin
    .from("push_subscriptions")
    .select("id,endpoint,p256dh,auth")
    .eq("app_member_id", member.id);
  if (devices.error) throw new NotificationError(503, notificationSetupError(devices.error.code));
  if (devices.data.length === 0) {
    throw new NotificationError(409, "This device is not registered for notifications yet. Turn them on first.");
  }

  let keys: VapidKeys;
  try {
    keys = readVapidKeys();
  } catch (error) {
    logNotification({ stage: "test-push-not-configured" });
    throw error;
  }

  const payload = JSON.stringify({
    title: "Christmas Budget",
    body: "Notifications are working \u{1F384}",
    url: "/more/notifications",
    tag: "test-notification",
    category: "purchases",
  });

  const results = await Promise.all(devices.data.map(async (device) => {
    const outcome = await sendPushNotification(
      { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
      payload,
      keys,
    );
    logNotification({
      stage: "test-push-response",
      pushHost: pushServiceHost(device.endpoint),
      status: outcome.status,
      outcome: outcome.outcome,
      ...(outcome.outcome === "failed" ? { reason: outcome.reason } : {}),
    });
    return { id: device.id, outcome };
  }));

  const expired = results.filter((row) => row.outcome.outcome === "expired");
  if (expired.length > 0) {
    await admin.from("push_subscriptions").delete().in("id", expired.map((row) => row.id));
  }
  const delivered = results.filter((row) => row.outcome.outcome === "sent");
  if (delivered.length > 0) {
    await admin
      .from("push_subscriptions")
      .update({ last_delivery_at: new Date().toISOString(), failure_count: 0 })
      .in("id", delivered.map((row) => row.id));
  }

  // The real HTTP status is handed back so the page can say what actually
  // happened rather than reporting success regardless.
  return {
    devices: results.length,
    delivered: delivered.length,
    removedInvalid: expired.length,
    statuses: results.map((row) => row.outcome.status),
  };
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

// ---------------------------------------------------------------------------
// Notification Centre
// ---------------------------------------------------------------------------

/**
 * The bell's contents.
 *
 * Deliberately server-side rather than a direct browser query, so the shape the
 * client sees is fixed here and the member id never has to leave the server.
 * RLS would restrict a direct query identically; this simply keeps one place
 * that decides what a notification looks like to the UI.
 */
export type InboxNotification = {
  id: string;
  category: string;
  title: string;
  body: string;
  targetUrl: string;
  readAt: string | null;
  createdAt: string;
};

/** Newest first, capped: the bell is a recent-activity view, not an archive. */
const INBOX_LIMIT = 50;

export async function readInbox(): Promise<{ notifications: InboxNotification[]; unreadCount: number }> {
  const { session } = await requireNotificationMember();

  // The caller's own session, so RLS is what scopes this to their rows — not a
  // `where` clause that could be forgotten.
  const [rows, unread] = await Promise.all([
    session
      .from("notifications")
      .select("id,category,title,body,target_url,read_at,created_at")
      .order("created_at", { ascending: false })
      .limit(INBOX_LIMIT),
    session
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),
  ]);
  if (rows.error) throw new NotificationError(503, notificationSetupError(rows.error.code));

  // The bell is the app's most frequent authenticated request, which makes it
  // the natural place to sweep up events no browser managed to hand over. It is
  // deliberately awaited: a floating promise in a serverless request is exactly
  // the kind of work that gets cancelled when the response is returned.
  await flushNotificationOutbox();

  return {
    notifications: (rows.data ?? []).map((row) => ({
      id: row.id,
      category: row.category,
      title: row.title,
      body: row.body,
      // Re-checked on the way out as well as on the way in. The column has a
      // CHECK constraint, but a link the UI is about to follow is worth being
      // certain about in more than one place.
      targetUrl: safeInternalPath(row.target_url),
      readAt: row.read_at,
      createdAt: row.created_at,
    })),
    unreadCount: unread.error ? 0 : unread.count ?? 0,
  };
}

/**
 * Mark one notification, or all of them, as read.
 *
 * Scoped by RLS to the caller's own rows, and the table's trigger allows only
 * `read_at` to change — so this cannot touch another member's inbox, and cannot
 * rewrite the text or the link of even their own.
 */
export async function markNotificationsRead(notificationId: string | null) {
  const { session } = await requireNotificationMember();
  const readAt = new Date().toISOString();

  let query = session.from("notifications").update({ read_at: readAt }).is("read_at", null);
  if (notificationId !== null) {
    const id = validateUuid(notificationId, "A valid notification is required.");
    if (!id.ok) throw new NotificationError(400, id.error);
    query = query.eq("id", id.value);
  }

  const result = await query;
  if (result.error) throw new NotificationError(503, notificationSetupError(result.error.code));
  return { ok: true as const };
}

/**
 * Reduce a stored target to a safe in-app path.
 *
 * A single leading slash and not `//host`: browsers resolve a protocol-relative
 * URL to another origin, so the naive "starts with /" test is not enough.
 */
function safeInternalPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const resolved = new URL(value, "https://internal.invalid");
    return resolved.origin === "https://internal.invalid" ? resolved.pathname + resolved.search : "/";
  } catch {
    return "/";
  }
}

// `AdminClient` is exported only so the type is nameable in tests and future
// helpers; it carries no capability by itself.
export type { AdminClient };
