import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The Notification Centre, and the delivery bugs this migration set out to fix.
 *
 * The failure that prompted all of it was not a broken algorithm — the Web Push
 * transport was verified correct against Google, Mozilla, Apple and Microsoft's
 * real push services. It was that every device registered belonged to one
 * person, actor exclusion correctly removed them from every audience, and
 * nothing anywhere said so. So these tests are mostly about the two structural
 * properties that let that hide: delivery must be observable, and a delivery
 * that reached nobody must remain retryable.
 */

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const migration = read("supabase", "migrations", "202608100019_add_notification_centre.sql");
const outboxMigration = read("supabase", "migrations", "202608100020_add_notification_outbox.sql");

/**
 * The pipeline moved out of `notifications-server.ts` into `notification-dispatch.ts`
 * so that the outbox drain and the live dispatch run the same code with a
 * different reader — and so the whole chain can be executed by
 * `notification-dispatch.test.mjs` without `server-only` or `next/headers`.
 * These assertions are about both halves, so they read both halves.
 */
const dispatcher = read("src", "lib", "notification-dispatch.ts");
const serverModule = read("src", "utils", "supabase", "notifications-server.ts");
const server = `${serverModule}\n${dispatcher}`;
const log = read("src", "lib", "notification-log.ts");
const inboxRoute = read("src", "app", "api", "notifications", "inbox", "route.ts");
const testRoute = read("src", "app", "api", "notifications", "test", "route.ts");
const bell = read("src", "app", "components", "notification-bell.tsx");
const inboxHook = read("src", "app", "components", "use-notification-inbox.ts");

test("migration 018 is left exactly as applied", () => {
  const applied = read("supabase", "migrations", "202608100018_add_push_notifications.sql");
  assert.doesNotMatch(applied, /notifications_member_created_idx|create table if not exists public\.notifications\b/);
  assert.doesNotMatch(applied, /delivered_count/);
});

test("the notifications table is additive and stores no financial rows", () => {
  for (const table of ["purchases", "purchase_allocations", "settlements", "gift_ideas", "contributors", "recipient_contributions"]) {
    assert.doesNotMatch(migration, new RegExp(`alter table public\\.${table}\\b`), `${table} must not be altered`);
  }
  // The only pre-existing table touched is 018's own dispatch ledger.
  const alters = [...migration.matchAll(/alter table public\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(alters)].sort(), ["notification_events", "notifications"]);

  const statements = migration.replace(/--[^\n]*/g, "");
  // No money columns and no foreign key into the financial tables: the centre
  // must never become a second, disagreeing view of the Owed position.
  assert.doesNotMatch(statements, /\b\w*(pennies|amount|balance|budget)\w*\s+(integer|numeric|bigint)/i);
  assert.doesNotMatch(statements, /references public\.(purchases|settlements|gift_ideas|contributors)/);
});

test("a member may read and mark only their own notifications", () => {
  assert.match(migration, /alter table public\.notifications enable row level security;/);
  assert.match(migration, /revoke all privileges on table public\.notifications from public, anon, authenticated;/);

  // No INSERT and no DELETE for a browser session: a member cannot post a
  // notification into anyone's inbox, their own included.
  assert.match(migration, /grant select, update on table public\.notifications to authenticated;/);
  assert.doesNotMatch(migration, /create policy[^;]*on public\.notifications\s+for (insert|delete)/i);

  for (const action of ["read", "update"]) {
    const policy = migration.match(new RegExp(`create policy "members ${action} their own notifications"[\\s\\S]*?;`))[0];
    assert.match(policy, /app_member_id = public\.current_app_member_id\(\)/);
  }
  const update = migration.match(/create policy "members update their own notifications"[\s\S]*?;/)[0];
  assert.match(update, /with check \(app_member_id = public\.current_app_member_id\(\)\)/);

  // The Notification Centre is personal: no admin escape hatch anywhere.
  assert.doesNotMatch(migration, /is_app_admin\(\)/);
});

test("marking read cannot rewrite a notification", () => {
  // RLS says which rows may be updated; this trigger says what may change in
  // them. Without it "mark as read" is a general row edit and a member could
  // retarget their own notification's link.
  assert.match(migration, /create trigger protect_notification_content/);
  assert.match(migration, /before update on public\.notifications/);
  for (const column of ["title", "body", "target_url", "app_member_id", "category", "event_subject_id"]) {
    assert.match(migration, new RegExp(`new\\.${column} is distinct from old\\.${column}`), `${column} must be frozen`);
  }
  assert.match(migration, /Only the read state of a notification can be changed/);
});

test("notification links can only ever be internal", () => {
  // Enforced by the database, not just by the UI. `^/[^/]` rejects the
  // protocol-relative `//host` form, which browsers resolve to another origin.
  assert.match(migration, /target_url text not null check \(target_url ~ '\^\/\[\^\/\]' or target_url = '\/'\)/);
  // And re-checked on the way out, before the client is handed a link to follow.
  assert.match(server, /function safeInternalPath\(value: unknown\)/);
  assert.match(server, /!value\.startsWith\("\/"\) \|\| value\.startsWith\("\/\/"\)/);
  assert.match(server, /targetUrl: safeInternalPath\(row\.target_url\)/);
});

test("the bell is driven by Realtime, never by push", () => {
  // Streaming this table is safe precisely because Realtime applies each
  // subscriber's SELECT policy per row before delivering it.
  assert.match(migration, /alter publication supabase_realtime add table public\.notifications/);
  assert.match(inboxHook, /useRealtimeRefresh\(\["notifications"\], refresh/);
  // Push is an OS alert, not a data channel: the inbox must not read from it.
  assert.doesNotMatch(inboxHook, /pushManager|showNotification|serviceWorker/);

  // One provider in the persistent frame, so navigation does not churn channels.
  const frame = read("src", "app", "components", "app-frame.tsx");
  assert.match(frame, /<NotificationInboxProvider>/);
  assert.match(inboxHook, /export function NotificationInboxProvider/);
});

test("in-app notifications are created even when push is switched off", () => {
  // The order is load-bearing: the durable record is written first and is not
  // conditional on any push outcome, so turning off OS alerts cannot cost
  // someone their history.
  const createIndex = server.indexOf("const inAppCreated = await createInAppNotifications");
  const deliverIndex = server.indexOf("const delivery = await deliver(");
  assert.ok(createIndex > 0 && createIndex < deliverIndex, "in-app rows must be written before push is attempted");

  // And no longer conditional on having won the race to claim the event. With
  // the outbox a first attempt can claim and then die before writing anything,
  // and the retry would have skipped these rows forever. The database key
  // discards repeats instead, which is idempotence rather than a guess.
  assert.match(dispatcher, /onConflict: "app_member_id,event_kind,event_subject_id,category"/);
  assert.match(outboxMigration, /create unique index if not exists notifications_event_recipient_key/);

  // A missing or malformed VAPID key degrades to "no OS alert", not "the event
  // never happened" — the sender is resolved inside deliver(), not at the top.
  assert.match(server, /stage: "push-not-configured"/);
  const deliverBody = dispatcher.slice(dispatcher.indexOf("async function deliver("), dispatcher.indexOf("// The outbox"));
  assert.match(deliverBody, /const send = createPushSender\(\);/);
  assert.match(deliverBody, /if \(!send\) \{/);
  assert.match(serverModule, /const createPushSender: CreatePushSender = \(\) => \{/);
});

test("a delivery that reached nobody can be retried, a delivered one cannot repeat", () => {
  // The original trap: the event was claimed BEFORE sending, so a send that
  // reached nobody marked it handled forever.
  assert.match(migration, /add column if not exists delivered_count integer not null default 0/);
  assert.match(server, /if \(ledger\.delivered_count > 0\) \{/);
  assert.match(server, /outcome: "already-delivered"/);

  // The in-app half stays exactly-once regardless, now enforced by the database.
  assert.match(server, /ignoreDuplicates: true/);
  assert.match(server, /isNewEvent = \(claim\.data\?\.length \?\? 0\) > 0;/);

  // And the attempt is recorded, so a retry is visible rather than silent.
  assert.match(server, /attempt_count: ledger\.attempt_count \+ 1/);
  assert.match(server, /last_attempt_at: new Date\(\)\.toISOString\(\)/);
});

test("a ledger that cannot be read does not silence the notification", () => {
  // THE BUG THIS RELEASE FIXES. `notification_events.delivered_count` did not
  // exist in the deployed database, because this migration had never been
  // applied. The dispatcher read it, threw a 503, and the fire-and-forget
  // caller discarded the failure — so every real event claimed a ledger row and
  // then sent nothing, while "Send test notification" kept working perfectly.
  //
  // Bookkeeping is now stepped over and reported, never thrown.
  const runBody = dispatcher.slice(
    dispatcher.indexOf("const claim = await admin"),
    dispatcher.indexOf("const delivery = await deliver("),
  );
  assert.doesNotMatch(runBody, /throw new NotificationError/, "no bookkeeping failure may abort delivery");
  for (const stage of ["ledger-claim-failed", "ledger-read-failed", "in-app-write-failed"]) {
    assert.ok(dispatcher.includes(`stage: "${stage}"`), `${stage} must be reported`);
  }
});

test("every push service response is logged, and no secret ever is", () => {
  assert.match(server, /stage: "push-response"/);
  assert.match(server, /status: outcome\.status/);
  assert.match(server, /pushHost: pushServiceHost\(device\.endpoint\)/);

  // Hostname only. A push endpoint's PATH is a per-device bearer token and must
  // never reach a log that a third party retains.
  assert.match(log, /return new URL\(endpoint\)\.host;/);
  assert.doesNotMatch(log, /\.pathname|href/);

  // Nothing that could carry key material is loggable.
  for (const source of [server, log]) {
    assert.doesNotMatch(source, /console\.\w+\([^)]*(privateKey|VAPID_PRIVATE|p256dh|\bauth\b|SUPABASE_SECRET)/);
  }
  // Field NAMES only: the doc comments inside the type necessarily discuss
  // endpoints and keys while explaining why none of them are loggable.
  const fields = log
    .match(/export type NotificationLogFields = \{[\s\S]*?\n\};/)[0]
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(fields, /endpoint|p256dh|auth|token|title|body/i);

  // The conditions that were previously invisible now each have a name.
  for (const stage of ["no-subscribed-recipients", "push-not-configured", "already-delivered", "dispatched"]) {
    assert.ok(server.includes(`stage: "${stage}"`), `${stage} must be logged`);
  }
});

test("expired subscriptions are removed and transient failures are not", () => {
  assert.match(server, /const expiredIds = results\.filter\(\(row\) => row\.outcome\.outcome === "expired"\)/);
  assert.match(server, /from\("push_subscriptions"\)\.delete\(\)\.in\("id", expiredIds\)/);
  // A 429 or a 5xx must never unsubscribe anyone.
  const webPush = read("src", "lib", "web-push.ts");
  assert.match(webPush, /status === 404 \|\| response\.status === 410/);
  assert.doesNotMatch(server, /outcome === "failed"[\s\S]{0,120}delete\(\)/);
});

test("the test notification cannot be aimed at anyone else", () => {
  // No body at all: nothing to tamper with. The recipient comes from the
  // session and the wording is a server-side constant.
  assert.match(testRoute, /export async function POST\(\)/);
  assert.doesNotMatch(testRoute, /request\.json\(\)/);
  assert.match(server, /const \{ member \} = await requireNotificationMember\(\);/);

  // Bounded to this function: the inbox mapper further down legitimately reads
  // `row.title` and `row.body`, which would otherwise trip the check below.
  const testBody = server.slice(
    server.indexOf("export async function sendTestNotification"),
    server.indexOf("// Notification Centre"),
  );
  assert.match(testBody, /\.eq\("app_member_id", member\.id\)/, "only the caller's own devices");
  assert.match(testBody, /body: "Notifications are working/);
  // No parameter reaches the payload.
  assert.doesNotMatch(testBody, /title: \w+\.|body: \w+\./);

  // The real HTTP status decides what the user is told.
  assert.match(testRoute, /const accepted = result\.delivered > 0;/);
  assert.match(testRoute, /describePushStatus\(result\.statuses\[0\] \?\? 0\)/);
  assert.match(log, /VAPID keys on the server may not match/);
});

test("the inbox routes carry no member identifier to tamper with", () => {
  // Scoping is RLS on the caller's own session, so there is no id in either
  // request that could be swapped for somebody else's.
  assert.doesNotMatch(inboxRoute, /app_member_id|appMemberId/);
  assert.match(serverModule, /export async function readInbox/);
  const readBody = serverModule.slice(
    serverModule.indexOf("export async function readInbox"),
    serverModule.indexOf("export async function markNotificationsRead"),
  );
  assert.match(readBody, /session\s*\n?\s*\.from\("notifications"\)/);
  // The one non-session call here is the outbox flush, which reads nobody's
  // inbox: it delivers events the browser failed to hand over. Every row this
  // function returns still comes from the caller's own RLS-scoped session.
  assert.doesNotMatch(readBody, /admin\.from\(/);
  assert.match(readBody, /await flushNotificationOutbox\(\);/);

  // Mark-read likewise, and it only ever writes read_at.
  const markBody = serverModule.slice(
    serverModule.indexOf("export async function markNotificationsRead"),
    serverModule.indexOf("function safeInternalPath"),
  );
  assert.match(markBody, /\.update\(\{ read_at: readAt \}\)/);
  assert.doesNotMatch(markBody, /admin\./);
});

test("unread state and mark-all are supported end to end", () => {
  assert.match(server, /\.select\("id", \{ count: "exact", head: true \}\)\s*\n?\s*\.is\("read_at", null\)/);
  assert.match(server, /if \(notificationId !== null\)/, "one notification or all of them");
  assert.match(inboxHook, /const markAllRead = useCallback/);
  assert.match(inboxHook, /const markRead = useCallback/);
  assert.match(bell, /Mark all read/);
  // Opening one marks it read and navigates.
  assert.match(bell, /if \(!notification\.readAt\) void markRead\(notification\.id\);/);
  assert.match(bell, /router\.push\(notification\.targetUrl\)/);
});

test("the bell renders an unread badge and both panel shapes", () => {
  assert.match(bell, /unreadCount > 9 \? "9\+" : unreadCount/);
  assert.match(bell, /aria-label=\{unreadCount > 0 \? `Notifications, \$\{unreadCount\} unread` : "Notifications"\}/);
  // Bottom sheet on a phone, anchored dropdown from `sm:` up.
  assert.match(bell, /fixed inset-x-0 bottom-0/);
  assert.match(bell, /sm:absolute/);
  // Safe-area padding so the sheet clears a home indicator in an installed app.
  assert.match(bell, /env\(safe-area-inset-bottom\)/);
});

test("the bell never appears on the sign-in screens", () => {
  // It is rendered from TopBar, which only exists inside AppShell; AppFrame
  // hands auth routes their children bare, so neither can reach a login page.
  const topBar = read("src", "app", "components", "top-bar.tsx");
  assert.match(topBar, /<NotificationBell \/>/);
  const frame = read("src", "app", "components", "app-frame.tsx");
  assert.match(frame, /if \(isAuthRoute\(pathname\)\) return <>\{children\}<\/>;/);
  const shell = read("src", "app", "components", "app-shell.tsx");
  assert.match(shell, /<TopBar/);
});
