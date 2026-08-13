import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The properties of the notification system that cannot be checked by running a
 * function: what the migration grants, what the routes verify, and what the
 * service worker does and does not touch.
 *
 * These are static assertions over the source, in the same style as
 * `rls-security.test.mjs`. They are not a substitute for the database enforcing
 * its own policies — they are what catches a policy being loosened, a grant
 * being widened, or a caller check being deleted, none of which any unit test
 * would notice.
 */

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const migration = read("supabase", "migrations", "202608100018_add_push_notifications.sql");
const server = read("src", "utils", "supabase", "notifications-server.ts");
const dispatchRoute = read("src", "app", "api", "notifications", "dispatch", "route.ts");
const subscribeRoute = read("src", "app", "api", "notifications", "subscribe", "route.ts");
const serviceWorker = read("public", "sw.js");
const hook = read("src", "app", "components", "use-push-notifications.ts");

test("the migration is additive and touches no existing table", () => {
  // The one thing that must never happen: this migration altering the financial
  // schema. Owed, purchases, allocations and settlements are read by the
  // dispatcher and written by nothing here.
  for (const table of ["purchases", "purchase_allocations", "settlements", "gift_ideas", "contributors", "recipient_contributions", "christmas_recipients"]) {
    assert.doesNotMatch(migration, new RegExp(`alter table public\\.${table}\\b`), `${table} must not be altered`);
    assert.doesNotMatch(migration, new RegExp(`drop (table|policy|function)[^;]*${table}`), `${table} must not be dropped from`);
  }
  assert.doesNotMatch(migration, /\b(update|delete from|insert into)\s+public\.(purchases|settlements|gift_ideas|contributors)/i);

  // Existing migrations are immutable once applied.
  assert.equal(
    read("supabase", "migrations", "202608100017_add_item_photos.sql").includes("push_subscriptions"),
    false,
    "earlier migrations must not be edited",
  );
});

test("push subscriptions cannot be read or written across members", () => {
  // Start-from-zero, then grant back. Without the revoke, a default grant could
  // leave the table readable.
  assert.match(migration, /revoke all privileges on table public\.push_subscriptions from public, anon, authenticated;/);
  assert.match(migration, /grant select, delete on table public\.push_subscriptions to authenticated;/);

  // Both policies are scoped to the caller's own membership, so one member's
  // endpoint and encryption keys are unreachable from another member's session.
  const selectPolicy = migration.match(/create policy "members read their own devices"[\s\S]*?;/)[0];
  assert.match(selectPolicy, /using \(app_member_id = public\.current_app_member_id\(\)\)/);
  const deletePolicy = migration.match(/create policy "members remove their own devices"[\s\S]*?;/)[0];
  assert.match(deletePolicy, /using \(app_member_id = public\.current_app_member_id\(\)\)/);

  // No INSERT or UPDATE policy exists at all, so a browser token cannot write a
  // subscription row against somebody else's member id even with a forged body.
  assert.doesNotMatch(migration, /create policy[^;]*on public\.push_subscriptions\s*\n?\s*for (insert|update)/i);
  assert.match(migration, /alter table public\.push_subscriptions enable row level security;/);
});

test("one member can hold many devices, keyed by endpoint", () => {
  // Unique on endpoint, NOT on app_member_id: a member may have an iPhone, an
  // Android phone and a Windows PC registered at once, and removing one must
  // leave the others working.
  assert.match(migration, /endpoint text not null unique/);
  assert.doesNotMatch(migration, /app_member_id uuid not null[^,]*unique/);
  assert.match(migration, /app_member_id uuid not null\s*\n\s*references public\.app_members\(id\) on delete cascade/);

  // Removal is per endpoint and scoped to the owner, which is what makes
  // "turn off on this device" leave every other device alone.
  assert.match(server, /\.delete\(\)\s*\n\s*\.eq\("endpoint", validatePushEndpoint\(endpoint\)\)\s*\n\s*\.eq\("app_member_id", member\.id\)/);
});

test("preferences are per member, readable and writable only by that member", () => {
  assert.match(migration, /revoke all privileges on table public\.notification_preferences from public, anon, authenticated;/);
  for (const action of ["read", "create", "update"]) {
    const policy = migration.match(new RegExp(`create policy "members ${action} their own notification preferences"[\\s\\S]*?;`))[0];
    assert.match(policy, /app_member_id = public\.current_app_member_id\(\)/);
  }
  // The insert and update policies both carry a `with check`, or a member could
  // retarget a row onto another member's id.
  const update = migration.match(/create policy "members update their own notification preferences"[\s\S]*?;/)[0];
  assert.match(update, /with check \(app_member_id = public\.current_app_member_id\(\)\)/);
});

test("a member cannot send notifications to anyone else at will", () => {
  // The request body is a kind and a row id. No recipients, no text, no amount:
  // there is nothing in it a caller could use to choose an audience or wording.
  assert.match(dispatchRoute, /const kind = \(body as \{ kind\?: unknown \}\)\.kind;/);
  assert.match(dispatchRoute, /const id = \(body as \{ id\?: unknown \}\)\.id;/);
  assert.doesNotMatch(dispatchRoute, /body\.(title|message|recipients|appMemberId|members|amount)/);

  // Every branch of the dispatcher proves the caller is the recorded actor.
  for (const column of ["created_by_app_member_id", "updated_by_app_member_id", "recorded_by_app_member_id", "suggested_by_app_member_id"]) {
    assert.match(
      server,
      new RegExp(`row\\.${column} !== actorAppMemberId`),
      `${column} must be checked before notifying`,
    );
  }
  assert.match(server, /Only the person who made this change can notify the family about it\./);

  // And that it happened just now, so a known id cannot be replayed later.
  assert.match(server, /requireFresh\(row\.(created_at|updated_at)\)/);
  assert.match(server, /Date\.now\(\) - at > EVENT_FRESHNESS_MS/);

  // The subject row is re-read through the caller's own RLS-scoped session, not
  // the admin client, so an id they cannot see cannot be notified about.
  assert.match(server, /session\s*\n?\s*\.from\("purchases"\)/);
  assert.match(server, /session\s*\n?\s*\.from\("settlements"\)/);
});

test("one action sends one notification however many rows it wrote", () => {
  // The ledger's unique key is what makes dispatch idempotent.
  assert.match(migration, /unique \(kind, subject_id, fingerprint\)/);

  // The event is claimed before anything is created or sent, so the several
  // allocation rows one purchase writes, a retry, and a double-tapped Save all
  // converge on one ledger row.
  const claimIndex = server.indexOf('.from("notification_events")');
  const createIndex = server.indexOf("await createInAppNotifications");
  const deliverIndex = server.indexOf("const delivery = await deliver(");
  assert.ok(claimIndex > 0 && claimIndex < createIndex, "the event must be claimed before notifications are created");
  assert.ok(createIndex < deliverIndex, "the durable record is written before the optional push");

  // Claiming no longer suppresses a RETRY, only a repeat of what already
  // worked. The original code treated the claim as proof of delivery, so a send
  // that reached nobody blocked every later attempt for good; the two are now
  // tracked separately and only a delivery that actually landed stops a resend.
  assert.match(server, /ignoreDuplicates: true/);
  assert.match(server, /if \(existing\.data\.delivered_count > 0\) \{/);
  assert.doesNotMatch(server, /claim\.error\.code === "23505"/, "a duplicate claim must not be read as delivered");

  // No grants at all: only the server's secret-key client writes this ledger.
  assert.match(migration, /revoke all privileges on table public\.notification_events from public, anon, authenticated;/);
  assert.doesNotMatch(migration, /grant [a-z, ]+ on table public\.notification_events/);
});

test("owed figures come from the existing engine, never recalculated here", () => {
  assert.match(server, /import \{\s*calculateNetOwedBalances/s);
  assert.match(server, /return calculateNetOwedBalances\(obligations, ledger\);/);

  // No second implementation. If a balance were ever summed locally these would
  // be the shapes it took.
  const audience = read("src", "lib", "notification-audience.ts");
  for (const source of [server, audience]) {
    assert.doesNotMatch(source, /responsibility_pennies\s*[-+]/);
    assert.doesNotMatch(source, /amountPennies\s*\+=|amount_pennies\s*\+/);
  }
  // The audience module takes balances as an argument rather than deriving them.
  assert.match(audience, /balances: NetOwedBalance\[\],/);
});

test("dead subscriptions are removed, and live failures are not", () => {
  // 404/410 mean the browser dropped the subscription for good.
  assert.match(server, /row\.outcome\.outcome === "expired"/);
  assert.match(server, /from\("push_subscriptions"\)\.delete\(\)\.in\("id", expiredIds\)/);
  // A rate limit or an outage must never unsubscribe anyone.
  const webPush = read("src", "lib", "web-push.ts");
  assert.match(webPush, /status === 404 \|\| response\.status === 410/);
  assert.match(webPush, /outcome: "failed", status: response\.status/);
});

test("no secret can reach the browser", () => {
  // The private key is read in one server-only module and never exported.
  assert.match(server, /^import "server-only";/m);
  assert.match(server, /process\.env\.VAPID_PRIVATE_KEY/);
  assert.doesNotMatch(server, /NEXT_PUBLIC_VAPID/);
  assert.doesNotMatch(server, /console\.(log|error|warn)\([^)]*(privateKey|VAPID_PRIVATE|p256dh|auth)/);

  // Client code never names a secret, and reads the public key from a route
  // rather than an inlined build variable.
  for (const client of [hook, read("src", "app", "more", "notifications", "page.tsx")]) {
    assert.doesNotMatch(client, /VAPID_PRIVATE_KEY|SUPABASE_SECRET_KEY|process\.env\.VAPID/);
  }
  assert.match(hook, /fetch\("\/api\/notifications\/key"/);

  // Errors returned to a client are fixed strings; only an error's class name
  // is ever logged, so an endpoint or key cannot ride out in a message.
  for (const route of [dispatchRoute, subscribeRoute]) {
    assert.match(route, /type: error instanceof Error \? error\.name : "UnknownError"/);
  }
});

test("permission is never requested without a deliberate press", () => {
  // The only call site is inside `enable`, which the page wires to a button.
  assert.equal(hook.match(/Notification\.requestPermission\(\)/g).length, 1);
  const enableIndex = hook.indexOf("const enable = useCallback");
  const requestIndex = hook.indexOf("Notification.requestPermission()");
  assert.ok(enableIndex > 0 && requestIndex > enableIndex, "the request must live inside enable()");

  // The passive state check reads permission but never asks for it. Sliced to
  // the function body, not up to `enable` — the doc comment in between
  // discusses requestPermission and would match on prose alone.
  const refresh = hook.slice(
    hook.indexOf("const refresh = useCallback"),
    hook.indexOf("useEffect(() => {"),
  );
  assert.match(refresh, /Notification\.permission === "denied"/);
  assert.doesNotMatch(refresh, /requestPermission/);

  // The page renders a button that calls it; nothing runs it on mount.
  const page = read("src", "app", "more", "notifications", "page.tsx");
  assert.match(page, /onEnable=\{\(\) => void enable\(\)\}/);
  assert.doesNotMatch(page, /useEffect\([^}]*enable\(\)/s);
});

test("iPhone users are told to install rather than shown a failure", () => {
  // The iOS check must come BEFORE feature detection, or a Safari version that
  // exposes the Push API in a normal tab without it working would fall through
  // to the generic "not supported" message instead of the install guidance.
  assert.match(hook, /if \(isIosSafari && !isInstalled\) \{[\s\S]*?state: "needs-install"/);
  assert.ok(
    hook.indexOf('if (isIosSafari && !isInstalled)') < hook.indexOf('!("serviceWorker" in navigator)'),
    "the install check must precede feature detection",
  );
  const page = read("src", "app", "more", "notifications", "page.tsx");
  assert.match(page, /Add to your Home Screen first/);
  assert.match(page, /Add to Home Screen/);
});

test("the service worker gains push handling without losing its caching", () => {
  // The new handlers.
  assert.match(serviceWorker, /self\.addEventListener\("push"/);
  assert.match(serviceWorker, /self\.addEventListener\("notificationclick"/);
  assert.match(serviceWorker, /self\.registration\.showNotification\(/);

  // A tap focuses an open window before opening a new one.
  assert.match(serviceWorker, /matchAll\(\{ type: "window", includeUncontrolled: true \}\)/);
  assert.match(serviceWorker, /client\s*\n?\s*\.focus\(\)/);
  assert.match(serviceWorker, /self\.clients\.openWindow\(target\.href\)/);
  // Only same-origin, in-app routes are ever opened. The resolved origin is
  // what gets compared, because "//host" starts with a slash and still escapes.
  assert.match(serviceWorker, /function sameOriginPath\(value\)/);
  assert.match(serviceWorker, /resolved\.origin === self\.location\.origin/);
  assert.match(serviceWorker, /const url = sameOriginPath\(payload\.url\);/);
  assert.match(serviceWorker, /sameOriginPath\(event\.notification\.data && event\.notification\.data\.url\)/);
  assert.match(serviceWorker, /new URL\(client\.url\)\.origin !== self\.location\.origin/);

  // And the existing behaviour is untouched: documents still go to the network,
  // only hashed assets are cached, and the push path writes no cache at all.
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/_next\/static\/"\)/);
  const pushSection = serviceWorker.slice(
    serviceWorker.indexOf('addEventListener("push"'),
    serviceWorker.indexOf('addEventListener("fetch"'),
  );
  assert.doesNotMatch(pushSection, /caches\.(open|match|delete)/, "push handling must not touch Cache Storage");
});

test("push is an alert, not a data channel, and does not displace Realtime", () => {
  // The payload delivers display text and a route. Nothing reads it as state.
  assert.match(serviceWorker, /data: \{ url \}/);
  // Scoped to the push handlers and to real calls, not the word "Supabase"
  // where the file's header comment explains the division of labour.
  const pushHandlers = serviceWorker.slice(
    serviceWorker.indexOf('addEventListener("push"'),
    serviceWorker.indexOf('addEventListener("fetch"'),
  );
  assert.doesNotMatch(pushHandlers, /postMessage\(|indexedDB\.|createClient\(/);

  // The dispatch call happens after the write, and never replaces it.
  const notify = read("src", "app", "components", "notify-family.ts");
  assert.match(notify, /kind, id/);
  assert.doesNotMatch(notify, /supabase|from\(|rpc\(/);

  // Realtime is still wired to the same tables it was.
  const realtime = read("src", "app", "components", "use-realtime-refresh.ts");
  assert.match(realtime, /postgres_changes/);
  const owedPage = read("src", "app", "owed", "page.tsx");
  assert.match(owedPage, /useRealtimeRefresh\(/);

  // Push tables are deliberately absent from the Realtime publication, which
  // would otherwise stream endpoints and device keys to every subscriber.
  assert.doesNotMatch(migration, /alter publication supabase_realtime add table/);
});
