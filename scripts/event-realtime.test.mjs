import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Realtime, event-scoped.
 *
 * WHAT THESE CAN AND CANNOT PROVE
 *   Supabase Realtime is a hosted service. Nothing in this repository can start
 *   one, so NO TEST HERE OBSERVES A LIVE SUBSCRIPTION. What they do prove is
 *   everything that decides whether a live subscription would be correct: which
 *   tables are watched, which of them are narrowed to the event and which
 *   deliberately are not, that the filter is built from the route's event id,
 *   that the subscription key changes when the event changes so the old channel
 *   is torn down, and that the refetch it triggers is itself event-scoped.
 *
 *   The last of those is where the real safety lives. A Realtime payload is
 *   never financial truth in this app: an event only ever says "something
 *   changed", and the loader then re-reads through its own authorized,
 *   event-filtered query. So the worst a mis-scoped subscription can cause is a
 *   wasted refetch — never a wrong figure.
 */

const root = process.cwd();
// Line endings are normalised on the way in. Git stores LF and checks files out
// as CRLF on Windows, so a multi-line pattern written with \n silently stops
// matching a file nobody has edited -- a false failure about the product,
// caused by a checkout setting.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");

const { EVENT_FILTERED_TABLES, eventRealtimeSources } = await import("../src/lib/realtime-scope.ts");

const HOOK = ["src", "app", "components", "use-realtime-refresh.ts"];
const POLICY = ["src", "lib", "realtime-scope.ts"];
const EVENT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

/**
 * Every table the `supabase_realtime` publication carries, taken from the
 * migrations rather than from memory.
 */
function publishedTables() {
  const dir = join(root, "supabase", "migrations");
  const tables = new Set();
  for (const name of readdirSync(dir).sort()) {
    const sql = readFileSync(join(dir, name), "utf8");
    for (const match of sql.matchAll(/alter publication supabase_realtime add table public\.(\w+)/gu)) {
      tables.add(match[1]);
    }
    // Migration 014 adds its list through a loop over an array literal.
    const loop = /foreach target_table in array array\[([\s\S]*?)\]/u.exec(sql);
    if (loop) for (const match of loop[1].matchAll(/'(\w+)'/gu)) tables.add(match[1]);
  }
  return [...tables].sort();
}

/**
 * How each published table reaches an event. This is the classification the
 * whole design rests on, so it is stated once and asserted against the schema.
 */
const CLASSIFICATION = {
  people: "family-global",
  christmas_recipients: "direct",
  contributors: "direct",
  settlements: "direct",
  recipient_contributions: "indirect",
  purchases: "indirect",
  purchase_allocations: "indirect",
  gift_ideas: "indirect",
  notifications: "user-specific",
};

test("every published table is classified, and the classification matches the schema", () => {
  const published = publishedTables();
  assert.deepEqual(published, Object.keys(CLASSIFICATION).sort(), "a published table is unclassified");

  // `payment_receipts` is deliberately NOT published: migration 021 explains
  // that a review updates its settlement in the same transaction, so publishing
  // both would make every open tab refetch twice for one change.
  assert.ok(!published.includes("payment_receipts"));

  // "direct" must mean the table really does carry the column the filter uses.
  const schema = readdirSync(join(root, "supabase", "migrations"))
    .map((name) => readFileSync(join(root, "supabase", "migrations", name), "utf8"))
    .join("\n");
  for (const [table, kind] of Object.entries(CLASSIFICATION)) {
    if (kind !== "direct") continue;
    assert.match(
      schema,
      new RegExp(`create table public\\.${table}[\\s\\S]*?christmas_event_id`, "u"),
      `${table} is filtered on christmas_event_id, so it must have one`,
    );
  }
});

test("only the directly-scoped tables are narrowed, and the filter names the route's event", () => {
  const tables = Object.keys(CLASSIFICATION);
  const sources = eventRealtimeSources(tables, EVENT_ID);
  const byTable = new Map(
    sources.map((source) => (typeof source === "string" ? [source, null] : [source.table, source.filter])),
  );

  for (const [table, kind] of Object.entries(CLASSIFICATION)) {
    if (kind === "direct") {
      assert.equal(
        byTable.get(table),
        `christmas_event_id=eq.${EVENT_ID}`,
        `${table} must be narrowed to the route's event`,
      );
    } else {
      assert.equal(byTable.get(table), null, `${table} (${kind}) must not be filtered`);
    }
  }

  assert.deepEqual([...EVENT_FILTERED_TABLES].sort(), ["christmas_recipients", "contributors", "settlements"]);

  // Outside an event nothing is narrowed — the dashboard and the family-level
  // screens watch whole tables, which is correct for them.
  assert.deepEqual(eventRealtimeSources(tables, null), tables);
});

test("an indirectly-scoped table is never given an invented filter", () => {
  const hook = read(...POLICY);
  // The reason is written down, because the temptation to "filter" purchases by
  // an event id they do not have is exactly how real changes get dropped.
  assert.match(hook, /Postgres logical replication filters on the\n \* changed row's own columns/u);
  assert.match(hook, /inventing one would silently drop real changes/u);
  // And the delete caveat for the three that ARE filtered.
  assert.match(hook, /NOTE ON DELETES/u);
  assert.match(hook, /ever hard-deleted by this application/u);
  // `purchase_allocations` IS hard-deleted on every purchase edit, which is
  // exactly why it is not on the filtered list.
  assert.match(hook, /which IS hard-deleted and re-inserted/u);
  assert.ok(!EVENT_FILTERED_TABLES.includes("purchase_allocations"));
});

test("switching events tears the old subscription down", () => {
  const hook = read(...HOOK);
  // The filter is part of the key...
  assert.match(hook, /const subscriptionKey = JSON\.stringify\(/u);
  assert.match(hook, /left\.filter \?\? ""/u, "the key includes the filter, not just the table");
  // ...the effect depends on the key...
  assert.match(hook, /\}, \[enabled, subscriptionKey\]\);/u);
  // ...and the cleanup removes the channel.
  assert.match(hook, /void db\.removeChannel\(channel\);/u);
  assert.match(hook, /disposed = true;/u);
});

test("the filter is only ever sent when there is one", () => {
  const hook = read(...HOOK);
  // Passing `filter: undefined` would be serialised as the string "undefined"
  // and silently match nothing, which is worse than not filtering at all.
  assert.match(hook, /filter\s*\n\s*\?\s*\{ event: "\*", schema: "public", table, filter \}\s*\n\s*: \{ event: "\*", schema: "public", table \}/u);
});

test("every event screen subscribes through the event-scoped helper", () => {
  const SCREENS = [
    ["src", "app", "home-screen.tsx"],
    ["src", "app", "family-context.tsx"],
    ["src", "app", "owed", "owed-screen.tsx"],
    ["src", "app", "payment-log", "payment-log-screen.tsx"],
  ];
  for (const parts of SCREENS) {
    const source = read(...parts);
    assert.match(source, /eventRealtimeSources\(/u, `${parts.join("/")} must scope its subscription`);
    assert.match(source, /eventId,?\s*\n?\s*\)/u, `${parts.join("/")} must pass its event id`);
  }
});

test("the notification bell stays user-global, never event-filtered", () => {
  // A payment review for the birthday must raise the unread count while the
  // reader is looking at Christmas. Filtering the bell by the active event
  // would hide exactly the notification that needs to be seen.
  const inbox = read("src", "app", "components", "use-notification-inbox.ts");
  assert.match(inbox, /useRealtimeRefresh\(\["notifications"\]/u, "the bell watches the whole table");
  assert.doesNotMatch(inbox, /eventRealtimeSources|christmas_event_id/u, "the bell is not event-scoped");

  // And the row's own RLS is what scopes it: a member only ever receives their
  // own notifications.
  const migration = read("supabase", "migrations", "202608100023_repair_notification_centre_and_outbox.sql");
  assert.match(migration, /app_member_id = public\.current_app_member_id\(\)/u);
});

test("family-level screens are not pinned to an event", () => {
  // Family Access and Activity are family-wide by design, so they watch whole
  // tables. Narrowing them to "the current event" would hide real changes.
  for (const parts of [
    ["src", "app", "more", "family-access", "family-access-client.tsx"],
    ["src", "app", "more", "activity", "activity-client.tsx"],
  ]) {
    const source = read(...parts);
    assert.match(source, /useRealtimeRefresh\(/u);
    assert.doesNotMatch(source, /eventRealtimeSources/u, `${parts.join("/")} is family-wide`);
  }
});

test("a Realtime payload is never read as data", () => {
  const hook = read(...HOOK);
  // The callback takes no argument from the event, and the module never touches
  // `payload`, `new` or `old` — the refetch is the only thing that reads data.
  assert.match(hook, /the payload is\n \* deliberately never read/u);
  assert.doesNotMatch(hook, /payload\.|\.new\b|\.old\b/u);
  assert.match(hook, /schedule\b/u);
});
