import assert from "node:assert/strict";
import test from "node:test";

/**
 * The real dispatch pipeline, end to end, over in-memory tables.
 *
 * These are NOT "was notifyFamily called" tests. Every one of them runs the
 * actual code a saved purchase runs — subject row → actor → audience →
 * preferences → notification-centre rows → subscription lookup → the delivery
 * function — and asserts on what came out the other end.
 *
 * THE BUG THEY EXIST TO CATCH
 *
 * Push worked. The test button worked on every device. Real events reached
 * nobody, because `notification_events` was missing the two columns migration
 * 019 adds: the dispatcher read them, got `42703`, threw a 503, and the
 * fire-and-forget caller discarded it. Every symptom was invisible — the row
 * saved, the ledger entry was even claimed, and nothing was ever sent.
 *
 * So the load-bearing tests here are the ones that break a piece of BOOKKEEPING
 * and assert the family is still told. A notification must never be lost
 * because a table used to record it was unavailable.
 */

const {
  alreadyEstablished,
  callerMustBeActor,
  drainNotificationOutbox,
  loadFamilyContext,
  NotificationError,
  runNotificationEvent,
  settleOutboxRow,
} = await import("../src/lib/notification-dispatch.ts");

// ---------------------------------------------------------------------------
// A very small Supabase stand-in
// ---------------------------------------------------------------------------
// Enough of PostgREST's shape for the queries this pipeline actually makes,
// plus the ability to make any one of them fail with a real error code — which
// is how the production failure is reproduced below.

function createClient(store, faults = {}) {
  return {
    from(table) {
      return {
        select: (columns = "*") => new Query(store, faults, table, "select", { columns }),
        insert: (values) => new Query(store, faults, table, "insert", { values }),
        upsert: (values, options = {}) => new Query(store, faults, table, "upsert", { values, options }),
        update: (values) => new Query(store, faults, table, "update", { values }),
        delete: () => new Query(store, faults, table, "delete", {}),
      };
    },
  };
}

class Query {
  constructor(store, faults, table, op, payload) {
    this.store = store;
    this.faults = faults;
    this.table = table;
    this.op = op;
    this.payload = payload;
    this.filters = [];
    this.single = false;
    this.sort = null;
    this.max = null;
    this.selected = op === "select";
  }

  select(columns) { this.selected = true; this.payload.columns = columns; return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  neq(column, value) { this.filters.push((row) => row[column] !== value); return this; }
  is(column, value) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
  lt(column, value) { this.filters.push((row) => row[column] < value); return this; }
  gte(column, value) { this.filters.push((row) => row[column] >= value); return this; }
  order(column, options = {}) { this.sort = { column, ascending: options.ascending !== false }; return this; }
  limit(count) { this.max = count; return this; }
  maybeSingle() { this.single = true; return this; }

  then(resolve) { resolve(this.run()); }

  rows() { return (this.store[this.table] ??= []); }

  matching() {
    let rows = this.rows().filter((row) => this.filters.every((keep) => keep(row)));
    if (this.sort) {
      const { column, ascending } = this.sort;
      rows = [...rows].sort((left, right) =>
        (left[column] < right[column] ? -1 : left[column] > right[column] ? 1 : 0) * (ascending ? 1 : -1));
    }
    return this.max === null ? rows : rows.slice(0, this.max);
  }

  run() {
    const fault = this.faults[`${this.table}.${this.op}`];
    if (fault) return { data: null, error: fault, count: null };
    if (!(this.table in this.store)) {
      // What a missing table really looks like coming back from PostgREST.
      return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.table}'` }, count: null };
    }

    if (this.op === "select") {
      const rows = this.matching();
      return this.single
        ? { data: rows[0] ?? null, error: null }
        : { data: rows, error: null, count: rows.length };
    }

    if (this.op === "insert" || this.op === "upsert") {
      const incoming = Array.isArray(this.payload.values) ? this.payload.values : [this.payload.values];
      const key = this.payload.options?.onConflict?.split(",").map((column) => column.trim()) ?? null;
      const ignore = this.payload.options?.ignoreDuplicates === true;
      const written = [];
      for (const row of incoming) {
        const clash = key
          ? this.rows().find((existing) => key.every((column) => existing[column] === row[column]))
          : null;
        if (clash) {
          if (ignore) continue;
          Object.assign(clash, row);
          written.push(clash);
          continue;
        }
        const stored = { id: `${this.table}-${this.rows().length + 1}`, created_at: new Date().toISOString(), ...row };
        this.rows().push(stored);
        written.push(stored);
      }
      return { data: this.selected ? written : null, error: null };
    }

    if (this.op === "update") {
      const updated = this.matching();
      for (const row of updated) Object.assign(row, this.payload.values);
      return { data: this.selected ? updated : null, error: null };
    }

    const doomed = new Set(this.matching());
    this.store[this.table] = this.rows().filter((row) => !doomed.has(row));
    return { data: null, error: null };
  }
}

// ---------------------------------------------------------------------------
// The family, as it really is: four members, four contributors, one Christmas
// ---------------------------------------------------------------------------

const NOW = () => new Date().toISOString();
const AGES_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const MEMBERS = [
  { key: "taylor", name: "Taylor" },
  { key: "paige", name: "Paige" },
  { key: "jade", name: "Jade" },
  { key: "kirsten", name: "Kirsten" },
];

function familyStore(overrides = {}) {
  const store = {
    // The generalised event table from migration 025. The dispatcher reads it
    // to name the event in the copy and to build the deep link.
    events: [{ id: "evt", name: "Christmas 2026", event_type: "christmas", year: 2026 }],
    people: [
      ...MEMBERS.map((member) => ({ id: `p-${member.key}`, name: member.name })),
      { id: "p-mum", name: "Mum" },
    ],
    contributors: MEMBERS.map((member) => ({
      id: `c-${member.key}`, person_id: `p-${member.key}`, active: true, christmas_event_id: "evt",
    })),
    christmas_recipients: [{ id: "r-mum", person_id: "p-mum", christmas_event_id: "evt" }],
    app_members: MEMBERS.map((member) => ({
      id: `m-${member.key}`, person_id: `p-${member.key}`, contributor_id: `c-${member.key}`, active: true,
    })),
    notification_preferences: [],
    purchases: [{
      id: "pur-1",
      christmas_recipient_id: "r-mum",
      actual_price_pennies: 4000,
      checkout_payer_contributor_id: "c-taylor",
      status: "purchased",
      created_by_app_member_id: "m-taylor",
      updated_by_app_member_id: "m-taylor",
      created_at: NOW(),
      updated_at: NOW(),
      deleted_at: null,
    }],
    purchase_allocations: MEMBERS.map((member) => ({
      purchase_id: "pur-1", contributor_id: `c-${member.key}`, responsibility_pennies: 1000,
    })),
    gift_ideas: [{
      id: "idea-1",
      christmas_recipient_id: "r-mum",
      suggested_by_app_member_id: "m-taylor",
      created_at: NOW(),
    }],
    settlements: [],
    payment_receipts: [],
    // Everybody has exactly one device registered, which is the state the
    // family is actually in: the test button works for all four of them.
    push_subscriptions: MEMBERS.map((member) => ({
      id: `sub-${member.key}`,
      app_member_id: `m-${member.key}`,
      endpoint: `https://push.example/${member.key}`,
      p256dh: "key",
      auth: "secret",
    })),
    notifications: [],
    notification_events: [],
    notification_outbox: [],
  };
  return { ...store, ...overrides };
}

/** A push sender that always succeeds, and records who it reached. */
function recordingSender() {
  const sent = [];
  const create = () => async (subscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
    return { outcome: "sent", status: 201 };
  };
  return { sent, create };
}

async function run(store, { kind = "purchase", subjectId = "pur-1", caller = "m-taylor", faults = {}, sender } = {}) {
  const admin = createClient(store, faults);
  const context = await loadFamilyContext(admin, admin, "evt");
  return runNotificationEvent({
    admin,
    reader: admin,
    kind,
    subjectId,
    context,
    authorize: caller === null ? alreadyEstablished : callerMustBeActor(caller),
    createPushSender: sender.create,
    source: caller === null ? "outbox" : "action",
  });
}

// Keep the pipeline's own structured log out of the test output, but keep it
// readable so the summary line can be asserted on.
const logged = [];
const realLog = console.log;
console.log = (line) => { logged.push(String(line)); };
test.after(() => { console.log = realLog; });

// ---------------------------------------------------------------------------

test("a real purchase reaches every other member, and only them", async () => {
  const store = familyStore();
  const sender = recordingSender();
  const report = await run(store, { sender });

  assert.equal(report.audience, 3, "three other members exist");
  assert.equal(report.preferencesAllowed, 3, "none of them have opted out");
  assert.equal(report.subscribedRecipients, 3);
  assert.equal(report.inAppCreated, 3);
  assert.equal(report.delivered, 3);
  assert.equal(report.failed, 0);
  assert.equal(report.outcome, "delivered");

  // Actor exclusion removes exactly one person.
  const reached = sender.sent.map((row) => row.endpoint).sort();
  assert.deepEqual(reached, [
    "https://push.example/jade",
    "https://push.example/kirsten",
    "https://push.example/paige",
  ]);

  // And the durable record matches, one row each, none for the actor.
  assert.equal(store.notifications.length, 3);
  assert.deepEqual(
    [...new Set(store.notifications.map((row) => row.app_member_id))].sort(),
    ["m-jade", "m-kirsten", "m-paige"],
  );
  assert.ok(store.notifications.every((row) => row.event_kind === "purchase" && row.event_subject_id === "pur-1"));
});

/**
 * The whole path, end to end: allocation row -> Owed engine -> copy ->
 * notifications row -> Web Push body.
 *
 * Three things are proven here that no unit test can prove on its own:
 *
 *   1. Each contributor is told THEIR OWN increase. The shares below are
 *      deliberately unequal, so a purchase-wide figure would be wrong for two
 *      of the three readers and right for one -- the exact bug that would slip
 *      past a fixture where everybody pays the same.
 *   2. The in-app record and the push carry the SAME sentence. They are built
 *      once and consumed twice; if that ever forks, the Notification Centre and
 *      the lock screen start quoting different money.
 *   3. The event stays in the body as context. The title still says what to do.
 */
test("each contributor's own increase reaches both the inbox and the push, identically", async () => {
  const store = familyStore({
    // £40, paid by Taylor at the checkout, split unequally. Taylor's own £10
    // creates no obligation for Taylor -- he paid it.
    purchase_allocations: [
      { purchase_id: "pur-1", contributor_id: "c-taylor", responsibility_pennies: 1000 },
      { purchase_id: "pur-1", contributor_id: "c-paige", responsibility_pennies: 1500 },
      { purchase_id: "pur-1", contributor_id: "c-jade", responsibility_pennies: 1000 },
      { purchase_id: "pur-1", contributor_id: "c-kirsten", responsibility_pennies: 500 },
    ],
  });
  const sender = recordingSender();
  await run(store, { sender });

  const expected = new Map([
    ["paige", "Christmas 2026 · This purchase adds £15. You now owe Taylor £15 in total."],
    ["jade", "Christmas 2026 · This purchase adds £10. You now owe Taylor £10 in total."],
    ["kirsten", "Christmas 2026 · This purchase adds £5. You now owe Taylor £5 in total."],
  ]);

  for (const [key, body] of expected) {
    const push = sender.sent.find((row) => row.endpoint.endsWith(`/${key}`));
    const inApp = store.notifications.find((row) => row.app_member_id === `m-${key}`);

    assert.ok(push, `${key} was pushed to`);
    assert.ok(inApp, `${key} has a Notification Centre row`);

    // 1. Their own delta, and the authoritative total.
    assert.equal(push.payload.body, body, key);

    // 2. One set of figures, two consumers.
    assert.equal(inApp.body, push.payload.body, `${key}: inbox and push must agree`);
    assert.equal(inApp.title, push.payload.title, `${key}: inbox and push must agree`);

    // 3. The action survives in the title; the event is context in the body.
    assert.equal(push.payload.title, "💷 You owe Taylor");
    assert.doesNotMatch(push.payload.title, /Christmas/u, "the event must not replace the title");
    assert.ok(push.payload.body.startsWith("Christmas 2026 · "), "the event stays a body prefix");

    // Nobody is handed the £40 purchase total as their own increase.
    assert.doesNotMatch(push.payload.body, /adds £40\b/u, key);
  }

  // Three different deltas from one purchase, which is the point.
  assert.equal(new Set([...expected.values()]).size, 3);
});

test("a share that creates no obligation is never announced as an increase", async () => {
  // Kirsten is allocated nothing, so she reads the ordinary purchase notice.
  const store = familyStore({
    purchase_allocations: [
      { purchase_id: "pur-1", contributor_id: "c-taylor", responsibility_pennies: 2000 },
      { purchase_id: "pur-1", contributor_id: "c-paige", responsibility_pennies: 2000 },
      { purchase_id: "pur-1", contributor_id: "c-kirsten", responsibility_pennies: 0 },
    ],
  });
  const sender = recordingSender();
  await run(store, { sender });

  for (const row of store.notifications) {
    assert.doesNotMatch(row.body, /adds £0\b/u, row.app_member_id);
  }

  const kirsten = store.notifications.find((row) => row.app_member_id === "m-kirsten");
  assert.equal(kirsten?.category, "purchases", "no allocation means no owed alert");
  assert.doesNotMatch(kirsten?.body ?? "", /This purchase adds/u);

  // And the person who does carry a share still gets theirs.
  const paige = store.notifications.find((row) => row.app_member_id === "m-paige");
  assert.equal(paige?.category, "money_i_owe");
  assert.match(paige?.body ?? "", /This purchase adds £20\. You now owe Taylor £20 in total\./u);
});

test("a ledger whose columns do not exist still delivers to the family", async () => {
  // THE ACTUAL BUG. `notification_events.delivered_count` did not exist,
  // because migration 019 was never applied. The dispatcher read it, threw a
  // 503, and the browser discarded the failure. Nothing was ever sent, and the
  // ledger row it had already claimed made the event look handled.
  const store = familyStore();
  const sender = recordingSender();
  const report = await run(store, {
    sender,
    faults: { "notification_events.select": { code: "42703", message: "column notification_events.delivered_count does not exist" } },
  });

  assert.equal(report.delivered, 3, "a bookkeeping failure must not cost the family its notifications");
  assert.equal(report.inAppCreated, 3);
  assert.equal(report.outcome, "delivered");
  assert.equal(sender.sent.length, 3);
});

test("a missing notifications table still delivers push", async () => {
  const store = familyStore();
  delete store.notifications;
  const sender = recordingSender();
  const report = await run(store, { sender });

  assert.equal(report.inAppCreated, 0);
  assert.equal(report.delivered, 3, "the optional record failing must not stop the alert");
});

test("a half-applied schema still fills the notification centre", async () => {
  // 019 applied but not 020: the unique key the idempotent write conflicts on
  // does not exist yet, and PostgREST rejects the conflict target. A partial
  // rollout must not empty everybody's bell.
  const store = familyStore();
  const sender = recordingSender();
  const report = await run(store, {
    sender,
    faults: { "notifications.upsert": { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" } },
  });

  assert.equal(report.inAppCreated, 3);
  assert.equal(report.delivered, 3);
  assert.equal(store.notifications.length, 3);
});

test("a missing ledger table still delivers push and writes the inbox", async () => {
  const store = familyStore();
  delete store.notification_events;
  const sender = recordingSender();
  const report = await run(store, { sender });

  assert.equal(report.delivered, 3);
  assert.equal(report.inAppCreated, 3);
});

test("someone with no device still gets a notification-centre entry", async () => {
  const store = familyStore();
  store.push_subscriptions = store.push_subscriptions.filter((row) => row.app_member_id !== "m-kirsten");
  const sender = recordingSender();
  const report = await run(store, { sender });

  assert.equal(report.preferencesAllowed, 3);
  assert.equal(report.subscribedRecipients, 2);
  assert.equal(report.delivered, 2);
  assert.equal(report.inAppCreated, 3, "the in-app record does not depend on push");
  assert.ok(store.notifications.some((row) => row.app_member_id === "m-kirsten"));
});

test("nobody subscribed is reported as such, not as success", async () => {
  const store = familyStore();
  store.push_subscriptions = [];
  const sender = recordingSender();
  const report = await run(store, { sender });

  assert.equal(report.outcome, "no-subscribed-recipients");
  assert.equal(report.delivered, 0);
  assert.equal(report.inAppCreated, 3);
});

test("push being unconfigured degrades to no alert, never to no event", async () => {
  const store = familyStore();
  const report = await run(store, { sender: { sent: [], create: () => null } });

  assert.equal(report.outcome, "push-not-configured");
  assert.equal(report.inAppCreated, 3);
});

test("a switched-off preference removes that member and nobody else", async () => {
  const store = familyStore();
  store.notification_preferences = [{
    app_member_id: "m-jade",
    purchases: true, money_i_owe: true, money_owed_to_me: true,
    gift_ideas: false, gift_status: true,
  }];
  const sender = recordingSender();
  const report = await run(store, { sender, kind: "gift_idea", subjectId: "idea-1" });

  assert.equal(report.audience, 3);
  assert.equal(report.preferencesAllowed, 2, "Jade opted out of gift ideas");
  assert.equal(report.delivered, 2);
  assert.ok(!sender.sent.some((row) => row.endpoint.includes("jade")));
  assert.ok(!store.notifications.some((row) => row.app_member_id === "m-jade"));
});

test("the same event delivered twice sends once", async () => {
  const store = familyStore();
  const first = recordingSender();
  await run(store, { sender: first });
  const second = recordingSender();
  const repeat = await run(store, { sender: second });

  assert.equal(repeat.outcome, "already-delivered");
  assert.equal(second.sent.length, 0);
  assert.equal(store.notifications.length, 3, "and writes no duplicate inbox rows");
});

test("a member cannot notify the family about somebody else's action", async () => {
  const store = familyStore();
  await assert.rejects(
    () => run(store, { sender: recordingSender(), caller: "m-jade" }),
    (error) => error instanceof NotificationError && error.status === 403,
  );
  assert.equal(store.notifications.length, 0);
});

test("a client cannot replay an old row, but the outbox can still deliver it", async () => {
  const store = familyStore();
  store.purchases[0].created_at = AGES_AGO;

  await assert.rejects(
    () => run(store, { sender: recordingSender() }),
    (error) => error instanceof NotificationError && error.status === 409,
  );

  // The outbox row was written by a trigger inside the write's own
  // transaction, so it cannot be forged and must not expire with the window
  // that exists to stop forgeries.
  const sender = recordingSender();
  const report = await run(store, { sender, caller: null });
  assert.equal(report.delivered, 3);
});

test("an event the browser never dispatched is delivered by the outbox", async () => {
  const store = familyStore();
  store.notification_outbox = [{
    id: "out-1",
    kind: "purchase",
    subject_id: "pur-1",
    fingerprint: "created",
    actor_app_member_id: "m-taylor",
    created_at: NOW(),
    attempts: 0,
    processed_at: null,
  }];
  const admin = createClient(store);
  const sender = recordingSender();

  const reports = await drainNotificationOutbox({
    admin,
    createPushSender: sender.create,
    loadContext: (client) => loadFamilyContext(client, client, "evt"),
  });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].source, "outbox");
  assert.equal(reports[0].delivered, 3);
  assert.equal(reports[0].inAppCreated, 3);
  assert.equal(store.notification_outbox[0].processed_at !== null, true, "a delivered row is not attempted again");
  assert.equal(store.notification_outbox[0].attempts, 1);
});

test("the outbox does not repeat what the live dispatch already sent", async () => {
  const store = familyStore();
  store.notification_outbox = [{
    id: "out-1", kind: "purchase", subject_id: "pur-1", fingerprint: "created",
    actor_app_member_id: "m-taylor", created_at: NOW(), attempts: 0, processed_at: null,
  }];

  const live = recordingSender();
  await run(store, { sender: live });
  assert.equal(live.sent.length, 3);

  const admin = createClient(store);
  await settleOutboxRow(admin, "purchase", "pur-1", "created");

  const later = recordingSender();
  const reports = await drainNotificationOutbox({
    admin,
    createPushSender: later.create,
    loadContext: (client) => loadFamilyContext(client, client, "evt"),
  });
  assert.equal(reports.length, 0);
  assert.equal(later.sent.length, 0);
  assert.equal(store.notifications.length, 3);
});

test("an outbox row is retried while delivery keeps failing, then abandoned", async () => {
  const store = familyStore();
  store.notification_outbox = [{
    id: "out-1", kind: "purchase", subject_id: "pur-1", fingerprint: "created",
    actor_app_member_id: "m-taylor", created_at: NOW(), attempts: 0, processed_at: null,
  }];
  const admin = createClient(store);
  const failing = () => async () => ({ outcome: "failed", status: 503, reason: "push service down" });

  const first = await drainNotificationOutbox({
    admin, createPushSender: failing,
    loadContext: (client) => loadFamilyContext(client, client, "evt"),
  });
  assert.equal(first[0].outcome, "push-failed");
  assert.equal(store.notification_outbox[0].processed_at ?? null, null, "a transient failure stays retryable");

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await drainNotificationOutbox({
      admin, createPushSender: failing,
      loadContext: (client) => loadFamilyContext(client, client, "evt"),
    });
  }
  assert.ok(store.notification_outbox[0].attempts <= 5, "and cannot spin forever");
});

test("a purchased-to-wrapped change tells the contributors carrying that gift", async () => {
  const store = familyStore();
  store.purchases[0].status = "wrapped";
  store.purchases[0].updated_at = NOW();
  store.purchases[0].updated_by_app_member_id = "m-jade";
  const sender = recordingSender();

  const report = await run(store, { sender, kind: "gift_status", caller: "m-jade" });
  assert.equal(report.audience, 3);
  assert.equal(report.delivered, 3);
  assert.ok(!sender.sent.some((row) => row.endpoint.includes("jade")), "the person who wrapped it is not told");
  assert.ok(sender.sent.every((row) => row.payload.category === "gift_status"));
});

test("a recorded payment tells the payer, not the person who recorded it", async () => {
  const store = familyStore();
  store.settlements = [{
    id: "set-1",
    christmas_event_id: "evt",
    payer_contributor_id: "c-jade",
    payee_contributor_id: "c-taylor",
    amount_pennies: 1000,
    recorded_by_app_member_id: "m-taylor",
    created_at: NOW(),
    voided_at: null,
  }];
  const sender = recordingSender();

  const report = await run(store, { sender, kind: "payment", subjectId: "set-1" });
  assert.equal(report.preferencesAllowed, 1);
  assert.equal(report.delivered, 1);
  assert.deepEqual(sender.sent.map((row) => row.endpoint), ["https://push.example/jade"]);
  assert.equal(sender.sent[0].payload.category, "money_i_owe");
});

test("a deleted purchase notifies nobody", async () => {
  const store = familyStore();
  store.purchases[0].deleted_at = NOW();
  const sender = recordingSender();

  const report = await run(store, { sender });
  assert.equal(report.outcome, "not-applicable");
  assert.equal(sender.sent.length, 0);
  assert.equal(store.notifications.length, 0);
});

test("the summary line says what happened and leaks nothing", async () => {
  logged.length = 0;
  const store = familyStore();
  await run(store, { sender: recordingSender() });

  const summary = logged.find((line) => line.includes('"stage":"dispatched"'));
  assert.ok(summary, "every dispatch reports itself in one line");
  const report = JSON.parse(summary.replace("[notifications] ", ""));
  assert.equal(report.event, "purchase");
  assert.equal(report.actor, "Taylor");
  assert.equal(report.audience, 3);
  assert.equal(report.preferencesAllowed, 3);
  assert.equal(report.subscribedRecipients, 3);
  assert.equal(report.inAppCreated, 3);
  assert.equal(report.pushAttempts, 3);
  assert.equal(report.delivered, 3);
  assert.equal(report.failed, 0);

  // A push endpoint's path is a per-device bearer token, and the body quotes
  // real money and real names. Neither may reach a log a third party retains.
  for (const line of logged) {
    assert.doesNotMatch(line, /push\.example\/\w/, "no endpoint path");
    assert.doesNotMatch(line, /You owe|New purchase for|secret/, "no notification text and no key material");
  }
});

// ---------------------------------------------------------------------------
// Two-sided payment confirmation
// ---------------------------------------------------------------------------
// Jade owes Taylor. Every test below runs the real pipeline over the real
// tables, so what they assert is what a phone would actually receive.

/** A claim: Jade recorded it, Taylor has confirmed none of it. */
function claim(store, overrides = {}) {
  store.settlements = [{
    id: "set-1",
    christmas_event_id: "evt",
    payer_contributor_id: "c-jade",
    payee_contributor_id: "c-taylor",
    amount_pennies: 2000,
    confirmed_amount_pennies: 0,
    recorded_by_app_member_id: "m-jade",
    created_at: NOW(),
    rejected_at: null,
    voided_at: null,
    ...overrides,
  }];
  return store.settlements[0];
}

function receipt(store, overrides = {}) {
  const row = {
    id: `rec-${store.payment_receipts.length + 1}`,
    settlement_id: "set-1",
    payer_contributor_id: "c-jade",
    payee_contributor_id: "c-taylor",
    action: "confirm",
    amount_pennies: 2000,
    reason: null,
    source: "review",
    reviewed_by_app_member_id: "m-taylor",
    reviewer_contributor_id: "c-taylor",
    created_at: NOW(),
    ...overrides,
  };
  store.payment_receipts.push(row);
  return row;
}

test("a claim the payer records asks the receiver to confirm it, and tells nobody else", async () => {
  const store = familyStore();
  claim(store);
  const sender = recordingSender();

  const report = await run(store, { sender, kind: "payment", subjectId: "set-1", caller: "m-jade" });

  assert.equal(report.preferencesAllowed, 1, "only the receiver has anything to do");
  assert.equal(report.inAppCreated, 1);
  assert.equal(report.delivered, 1);
  assert.deepEqual(sender.sent.map((row) => row.endpoint), ["https://push.example/taylor"]);
  assert.equal(sender.sent[0].payload.body, "Christmas 2026 · Jade says they paid you £20.");
  assert.equal(sender.sent[0].payload.category, "money_owed_to_me");
  assert.deepEqual(store.notifications.map((row) => row.app_member_id), ["m-taylor"]);
});

test("confirming a claim in full tells the payer, and only the payer", async () => {
  const store = familyStore();
  claim(store, { confirmed_amount_pennies: 2000 });
  receipt(store);
  const sender = recordingSender();

  const report = await run(store, { sender, kind: "payment_review", subjectId: "rec-1", caller: "m-taylor" });

  assert.equal(report.preferencesAllowed, 1);
  assert.equal(report.delivered, 1);
  assert.deepEqual(sender.sent.map((row) => row.endpoint), ["https://push.example/jade"]);
  // The TITLE still says what happened — that is the line a phone shows first.
  // The BODY names the event, as context for the sentence.
  assert.equal(sender.sent[0].payload.title, "✅ Payment confirmed");
  assert.equal(sender.sent[0].payload.body, "Christmas 2026 · Taylor confirmed your £20 payment.");
  // And the link goes inside that event, not to the legacy path.
  assert.equal(sender.sent[0].payload.url, "/events/evt/owed");
  assert.equal(store.notifications.length, 1);
  assert.equal(store.notifications[0].app_member_id, "m-jade");
  assert.equal(store.notifications[0].event_kind, "payment_review");
});

test("a partial confirmation quotes both figures", async () => {
  const store = familyStore();
  claim(store, { confirmed_amount_pennies: 1200 });
  receipt(store, { amount_pennies: 1200 });
  const sender = recordingSender();

  await run(store, { sender, kind: "payment_review", subjectId: "rec-1", caller: "m-taylor" });

  assert.equal(sender.sent[0].payload.body, "Christmas 2026 · Taylor confirmed £12 of your £20 payment.");
  assert.equal(store.notifications[0].body, "Christmas 2026 · Taylor confirmed £12 of your £20 payment.");
});

test("every partial confirmation of one payment is its own notification", async () => {
  // The receipt is the subject, not the settlement. Keying these on the payment
  // would deliver the first £10 and silently swallow the £15 and the £5.
  const store = familyStore();
  claim(store, { confirmed_amount_pennies: 1000 });
  receipt(store, { amount_pennies: 1000 });
  const first = recordingSender();
  await run(store, { sender: first, kind: "payment_review", subjectId: "rec-1", caller: "m-taylor" });

  store.settlements[0].confirmed_amount_pennies = 2000;
  receipt(store, { amount_pennies: 1000 });
  const second = recordingSender();
  const report = await run(store, { sender: second, kind: "payment_review", subjectId: "rec-2", caller: "m-taylor" });

  assert.equal(report.deduplicated, false);
  assert.equal(second.sent.length, 1, "the second confirmation is its own event");
  assert.equal(store.notifications.length, 2, "and its own inbox entry");
  assert.equal(second.sent[0].payload.body, "Christmas 2026 · Taylor confirmed your £20 payment.");
});

test("a rejection reaches the payer, with its reason in the app and not on the lock screen", async () => {
  const store = familyStore();
  claim(store, { rejected_at: NOW() });
  receipt(store, { action: "reject", amount_pennies: 2000, reason: "Nothing has arrived in my bank yet." });
  const sender = recordingSender();

  await run(store, { sender, kind: "payment_review", subjectId: "rec-1", caller: "m-taylor" });

  assert.deepEqual(sender.sent.map((row) => row.endpoint), ["https://push.example/jade"]);
  assert.equal(sender.sent[0].payload.body, "Christmas 2026 · Taylor rejected your £20 payment.");
  assert.equal(sender.sent[0].payload.inAppBody, undefined, "the push payload must not carry it at all");
  assert.doesNotMatch(JSON.stringify(sender.sent[0].payload), /bank/);
  // The longer in-app body is stamped with the event too, so the Notification
  // Centre says which occasion the refused payment belonged to.
  assert.equal(
    store.notifications[0].body,
    "Christmas 2026 · Taylor rejected your £20 payment. Reason: Nothing has arrived in my bank yet.",
  );
});

test("the receiver is never notified about their own review", async () => {
  const store = familyStore();
  claim(store, { confirmed_amount_pennies: 2000 });
  receipt(store);
  const sender = recordingSender();

  await run(store, { sender, kind: "payment_review", subjectId: "rec-1", caller: "m-taylor" });

  assert.ok(!sender.sent.some((row) => row.endpoint.includes("taylor")));
  assert.ok(!store.notifications.some((row) => row.app_member_id === "m-taylor"));
});

test("the receiver recording a payment themselves is not announced twice", async () => {
  // Recording as the receiver confirms in one step, so the auto receipt must
  // not produce a second message on top of the payment's own.
  const store = familyStore();
  claim(store, { confirmed_amount_pennies: 2000, recorded_by_app_member_id: "m-taylor" });
  receipt(store, { source: "auto_receipt" });
  const sender = recordingSender();

  const report = await run(store, { sender, kind: "payment_review", subjectId: "rec-1", caller: "m-taylor" });
  assert.equal(report.outcome, "not-applicable");
  assert.equal(sender.sent.length, 0);
  assert.equal(store.notifications.length, 0);
});

test("a review of a voided payment notifies nobody", async () => {
  const store = familyStore();
  claim(store, { confirmed_amount_pennies: 2000, voided_at: NOW() });
  receipt(store);
  const sender = recordingSender();

  const report = await run(store, { sender, kind: "payment_review", subjectId: "rec-1", caller: "m-taylor" });
  assert.equal(report.outcome, "not-applicable");
  assert.equal(sender.sent.length, 0);
});

test("a member cannot fire somebody else's review notification", async () => {
  const store = familyStore();
  claim(store, { confirmed_amount_pennies: 2000 });
  receipt(store);

  await assert.rejects(
    () => run(store, { sender: recordingSender(), kind: "payment_review", subjectId: "rec-1", caller: "m-paige" }),
    (error) => error instanceof NotificationError && error.status === 403,
  );
  assert.equal(store.notifications.length, 0);
});

test("a review the browser never dispatched is still delivered by the outbox", async () => {
  const store = familyStore();
  claim(store, { confirmed_amount_pennies: 2000 });
  receipt(store);
  store.notification_outbox = [{
    id: "out-review",
    kind: "payment_review",
    subject_id: "rec-1",
    fingerprint: "reviewed",
    actor_app_member_id: "m-taylor",
    created_at: NOW(),
    attempts: 0,
    processed_at: null,
  }];
  const admin = createClient(store);
  const sender = recordingSender();

  const reports = await drainNotificationOutbox({
    admin,
    createPushSender: sender.create,
    loadContext: (client) => loadFamilyContext(client, client, "evt"),
  });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].delivered, 1);
  assert.equal(reports[0].inAppCreated, 1);
  assert.equal(store.notification_outbox[0].processed_at !== null, true);
});

test("a pending claim never moves the balance a notification quotes", async () => {
  // Jade carries £10 of the £40 purchase Taylor paid for, so she owes £10. A
  // claim she has recorded but Taylor has not confirmed must not change that.
  const store = familyStore();
  claim(store, { amount_pennies: 1000, confirmed_amount_pennies: 0 });
  const admin = createClient(store);
  const context = await loadFamilyContext(admin, admin, "evt");

  const jadeToTaylor = context.balances.find((balance) => balance.pairKey.includes("c-jade"));
  assert.equal(jadeToTaylor.amountPennies, 1000, "the claim is not a repayment");
  assert.equal(jadeToTaylor.debtorContributorId, "c-jade");

  // And once Taylor confirms it, the same engine says the debt is gone.
  store.settlements[0].confirmed_amount_pennies = 1000;
  const settled = await loadFamilyContext(admin, admin, "evt");
  assert.equal(settled.balances.some((balance) => balance.pairKey.includes("c-jade")), false);
});

// ---------------------------------------------------------------------------
// Global Admin is an ordinary payer (and an ordinary receiver)
// ---------------------------------------------------------------------------
// Taylor is the Global Admin throughout. None of these tests tell the pipeline
// that: the point is that his role never enters into it, so the same rows
// produce the same notifications for him as for anybody else.

test("a Global Admin recording their own payment notifies exactly like a member", async () => {
  // Taylor (admin) says he paid Jade. Taylor is the payer, so this is a claim.
  const adminStore = familyStore();
  adminStore.settlements = [{
    id: "set-1",
    christmas_event_id: "evt",
    payer_contributor_id: "c-taylor",
    payee_contributor_id: "c-jade",
    amount_pennies: 2000,
    confirmed_amount_pennies: 0,
    recorded_by_app_member_id: "m-taylor",
    created_at: NOW(),
    rejected_at: null,
    voided_at: null,
  }];
  const adminSender = recordingSender();
  const adminReport = await run(adminStore, { sender: adminSender, kind: "payment", subjectId: "set-1", caller: "m-taylor" });

  // The identical situation with the roles swapped: Paige is nobody special.
  const memberStore = familyStore();
  memberStore.settlements = [{
    ...adminStore.settlements[0],
    payer_contributor_id: "c-paige",
    payee_contributor_id: "c-jade",
    confirmed_amount_pennies: 0,
    recorded_by_app_member_id: "m-paige",
  }];
  const memberSender = recordingSender();
  const memberReport = await run(memberStore, { sender: memberSender, kind: "payment", subjectId: "set-1", caller: "m-paige" });

  assert.equal(adminReport.preferencesAllowed, memberReport.preferencesAllowed);
  assert.equal(adminReport.delivered, memberReport.delivered);
  assert.deepEqual(adminSender.sent.map((row) => row.endpoint), ["https://push.example/jade"]);
  assert.deepEqual(memberSender.sent.map((row) => row.endpoint), ["https://push.example/jade"]);
  assert.equal(adminSender.sent[0].payload.title, memberSender.sent[0].payload.title);
  assert.equal(adminSender.sent[0].payload.body, "Christmas 2026 · Taylor says they paid you £20.");
  assert.equal(memberSender.sent[0].payload.body, "Christmas 2026 · Paige says they paid you £20.");
  assert.equal(adminSender.sent[0].payload.category, "money_owed_to_me");
});

test("a Global Admin recording a payment they received confirms it, like any receiver", async () => {
  const store = familyStore();
  store.settlements = [{
    id: "set-1",
    christmas_event_id: "evt",
    payer_contributor_id: "c-jade",
    payee_contributor_id: "c-taylor",
    amount_pennies: 2000,
    confirmed_amount_pennies: 2000,
    recorded_by_app_member_id: "m-taylor",
    created_at: NOW(),
    rejected_at: null,
    voided_at: null,
  }];
  const sender = recordingSender();
  await run(store, { sender, kind: "payment", subjectId: "set-1", caller: "m-taylor" });

  // The payer hears that it was acknowledged -- the receiver's own record IS
  // the acknowledgement, whether or not that receiver happens to be an admin.
  assert.deepEqual(sender.sent.map((row) => row.endpoint), ["https://push.example/jade"]);
  assert.equal(sender.sent[0].payload.body, "Christmas 2026 · Taylor recorded your £20 payment.");
  assert.equal(sender.sent[0].payload.category, "money_i_owe");
});

test("an admin override is announced as an admin override, to both people", async () => {
  // Taylor reconciles a £20 payment Jade made to Paige outside the app.
  const store = familyStore();
  store.settlements = [{
    id: "set-1",
    christmas_event_id: "evt",
    payer_contributor_id: "c-jade",
    payee_contributor_id: "c-paige",
    amount_pennies: 2000,
    confirmed_amount_pennies: 2000,
    recorded_by_app_member_id: "m-taylor",
    created_at: NOW(),
    rejected_at: null,
    voided_at: null,
  }];
  store.payment_receipts = [{
    id: "rec-1",
    settlement_id: "set-1",
    payer_contributor_id: "c-jade",
    payee_contributor_id: "c-paige",
    action: "confirm",
    amount_pennies: 2000,
    reason: "Payment confirmed outside the app",
    source: "admin_override",
    reviewed_by_app_member_id: "m-taylor",
    reviewer_contributor_id: "c-paige",
    created_at: NOW(),
  }];
  const sender = recordingSender();
  const report = await run(store, { sender, kind: "payment", subjectId: "set-1", caller: "m-taylor" });

  assert.equal(report.preferencesAllowed, 2, "both people whose balance moved");
  assert.deepEqual(
    sender.sent.map((row) => row.endpoint).sort(),
    ["https://push.example/jade", "https://push.example/paige"],
  );

  const byEndpoint = new Map(sender.sent.map((row) => [row.endpoint, row.payload]));
  assert.equal(byEndpoint.get("https://push.example/jade").body, "Christmas 2026 · Taylor recorded a confirmed £20 payment from you to Paige.");
  assert.equal(byEndpoint.get("https://push.example/paige").body, "Christmas 2026 · Taylor recorded a confirmed £20 payment from Jade to you.");

  // The one wording that would be a lie: nobody said they paid anything.
  for (const payload of sender.sent.map((row) => row.payload)) {
    assert.doesNotMatch(payload.body, /says they paid/);
  }
  // And the admin's justification is not broadcast to anybody's lock screen.
  assert.doesNotMatch(JSON.stringify(sender.sent), /outside the app/);
});

test("an ordinary confirmed payment is never mistaken for an admin override", async () => {
  const store = familyStore();
  store.settlements = [{
    id: "set-1",
    christmas_event_id: "evt",
    payer_contributor_id: "c-jade",
    payee_contributor_id: "c-taylor",
    amount_pennies: 2000,
    confirmed_amount_pennies: 2000,
    recorded_by_app_member_id: "m-taylor",
    created_at: NOW(),
    rejected_at: null,
    voided_at: null,
  }];
  store.payment_receipts = [{
    id: "rec-1",
    settlement_id: "set-1",
    payer_contributor_id: "c-jade",
    payee_contributor_id: "c-taylor",
    action: "confirm",
    amount_pennies: 2000,
    reason: null,
    source: "auto_receipt",
    reviewed_by_app_member_id: "m-taylor",
    reviewer_contributor_id: "c-taylor",
    created_at: NOW(),
  }];
  const sender = recordingSender();
  await run(store, { sender, kind: "payment", subjectId: "set-1", caller: "m-taylor" });

  assert.equal(sender.sent[0].payload.body, "Christmas 2026 · Taylor recorded your £20 payment.");
  assert.doesNotMatch(sender.sent[0].payload.title, /admin/i);
});

test("a database without the override table still notifies about ordinary payments", async () => {
  // Migration 022 not applied: the receipt lookup fails, and the ordinary
  // wording must still go out rather than the event being lost.
  const store = familyStore();
  delete store.payment_receipts;
  store.settlements = [{
    id: "set-1",
    christmas_event_id: "evt",
    payer_contributor_id: "c-taylor",
    payee_contributor_id: "c-jade",
    amount_pennies: 2000,
    confirmed_amount_pennies: 0,
    recorded_by_app_member_id: "m-taylor",
    created_at: NOW(),
    rejected_at: null,
    voided_at: null,
  }];
  const sender = recordingSender();
  const report = await run(store, { sender, kind: "payment", subjectId: "set-1", caller: "m-taylor" });

  assert.equal(report.delivered, 1);
  assert.equal(sender.sent[0].payload.body, "Christmas 2026 · Taylor says they paid you £20.");
});
