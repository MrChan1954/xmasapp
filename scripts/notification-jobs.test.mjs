/**
 * Q8 -- THE BACKGROUND JOBS, AGAINST A REAL POSTGRESQL.
 *
 * The notification subsystem has 97 tests across four suites, and not one of
 * them builds a database: they assert on source text and on pure functions.
 * That is the right shape for wording, preferences and audience arithmetic --
 * and the wrong shape for the three things that decide whether a job runs
 * twice:
 *
 *     claim_birthday_reminder          insert ... on conflict do nothing
 *     claim_birthday_budget_summary    insert ... on conflict do nothing
 *     notifications_event_recipient_key  the unique index a retry lands on
 *
 * Those are database behaviours. Whether a second worker gets `false`, whether
 * a redelivery collides, and whether a stage can be replayed after a restart
 * are all decided by indexes and `on conflict` clauses that only exist when
 * something is actually running. This file runs them.
 *
 * WHAT "CONCURRENT" MEANS HERE. PGlite is one connection, so the parallel
 * claims below serialise rather than racing. That still proves the thing that
 * matters: the winner is chosen by the UNIQUE INDEX, not by a read-then-write
 * the loser could have overtaken. A claim implemented as "select, then insert
 * if absent" would return true twice here and fail these tests.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";

import { asOwner, buildRehearsal, probe, rows, value, seen } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

let db;
let f;
const who = (user, area) => ({ user, area });

/**
 * Web Push key material, at the lengths the table insists on: `p256dh` is a
 * 65-byte public key and `auth` a 16-byte secret, both base64url, so the
 * constraints require >= 80 and >= 16 characters. Fake values of the right
 * SHAPE, so the tests exercise the real constraints rather than dodging them.
 */
const P256DH = "B".repeat(87);
const AUTH = "A".repeat(22);

before(async () => {
  db = await buildRehearsal({});
  f = await buildTwoFamilies(db);
});
after(async () => { await db?.close(); });

const claimReminder = (personId, year, stage, date) => value(db,
  "select public.claim_birthday_reminder($1, $2::smallint, $3, $4)", [personId, year, stage, date]);

const claimSummary = (personId, month, pennies, count, lines) => value(db,
  "select public.claim_birthday_budget_summary($1, $2, $3, $4::smallint, $5::jsonb)",
  [personId, month, pennies, count, JSON.stringify(lines)]);

describe("Q8: a birthday reminder stage is claimed exactly once", () => {
  test("THE FIRST CLAIM WINS AND THE SECOND IS TOLD SO", async () => {
    await asOwner(db);
    const first = await claimReminder(f.people.taylor, 2027, "one_week", "2027-03-14");
    const second = await claimReminder(f.people.taylor, 2027, "one_week", "2027-03-14");
    assert.equal(first, true, "the first claim must succeed");
    assert.equal(second, false, "THE SAME STAGE WAS CLAIMED TWICE -- it would be sent twice");
  });

  test("and only one row exists for it, however many workers asked", async () => {
    await asOwner(db);
    const rowsFor = await value(db,
      "select count(*)::int from public.birthday_reminders where person_id=$1 and occurrence_year=2027 and stage='one_week'",
      [f.people.taylor]);
    assert.equal(rowsFor, 1);
  });

  test("TEN WORKERS ASKING AT ONCE STILL PRODUCE ONE CLAIM", async () => {
    /*
     * Ten claims for a stage nobody has taken. Exactly one must come back true.
     * A `select then insert` implementation returns true more than once here.
     */
    await asOwner(db);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimReminder(f.people.jade, 2027, "one_day", "2027-06-01")));
    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1, `${winners.length} workers each believed they had the job`);
    assert.equal(await value(db,
      "select count(*)::int from public.birthday_reminders where person_id=$1 and occurrence_year=2027 and stage='one_day'",
      [f.people.jade]), 1);
  });

  test("the two stages are independent, so one_day still runs after one_week", async () => {
    await asOwner(db);
    assert.equal(await claimReminder(f.people.taylor, 2027, "one_day", "2027-03-14"), true,
      "claiming the week reminder must not consume the day reminder");
  });

  test("and next year is a different occurrence", async () => {
    await asOwner(db);
    assert.equal(await claimReminder(f.people.taylor, 2028, "one_week", "2028-03-14"), true,
      "a stage claimed in 2027 must not block 2028");
  });

  test("A RESTART CANNOT REPLAY A STAGE THAT WAS ALREADY SENT", async () => {
    // The restart case, which is the reason the claim is a row rather than a
    // variable: the evidence outlives the process.
    await asOwner(db);
    assert.equal(await claimReminder(f.people.taylor, 2027, "one_week", "2027-03-14"), false);
    assert.equal(await claimReminder(f.people.taylor, 2027, "one_day", "2027-03-14"), false);
  });

  test("an unknown stage is refused rather than silently queued", async () => {
    const bad = await probe(db, { role: "postgres" },
      "select public.claim_birthday_reminder($1, 2027::smallint, 'one_month', '2027-03-14')", [f.people.taylor]);
    assert.equal(bad.ok, false, "an unrecognised stage was accepted");
    assert.match(bad.error, /Unknown reminder stage/u);
  });

  test("and a signed-in person cannot claim reminders at all", async () => {
    // These are service-role jobs. If `authenticated` could call them, anybody
    // could burn a stage and stop the real reminder ever being sent.
    const asUser = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.claim_birthday_reminder($1, 2029::smallint, 'one_week', '2029-03-14')", [f.people.taylor]);
    assert.equal(asUser.ok, false, "an authenticated caller claimed a background job");
    assert.match(asUser.error, /permission denied/iu);
  });
});

describe("Q8: the monthly birthday summary is claimed once per person per month", () => {
  const lines = (pennies) => [{ celebrant_name: "Taylor", event_date: "2027-03-14", planned_amount_pennies: pennies }];

  test("the first claim returns an id and the second returns nothing", async () => {
    await asOwner(db);
    const first = await claimSummary(f.people.jade, "2027-03", 3000, 1, lines(3000));
    const second = await claimSummary(f.people.jade, "2027-03", 3000, 1, lines(3000));
    assert.ok(first, "the first claim must return the row it created");
    assert.equal(second, null, "THE SAME MONTH WAS SUMMARISED TWICE");
  });

  test("EIGHT WORKERS ASKING AT ONCE STILL PRODUCE ONE SUMMARY", async () => {
    await asOwner(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimSummary(f.people.mo, "2027-04", 1500, 1, lines(1500))));
    assert.equal(results.filter(Boolean).length, 1,
      "more than one worker claimed the same month");
    assert.equal(await value(db,
      "select count(*)::int from public.birthday_budget_summaries where contributor_person_id=$1 and budget_month='2027-04'",
      [f.people.mo]), 1);
  });

  test("DECEMBER AND THE FOLLOWING JANUARY ARE DIFFERENT MONTHS", async () => {
    // The rollover a naive month key gets wrong.
    await asOwner(db);
    assert.ok(await claimSummary(f.people.jade, "2027-12", 1000, 1, lines(1000)), "December failed");
    assert.ok(await claimSummary(f.people.jade, "2028-01", 1000, 1, lines(1000)),
      "January of the next year collided with December");
    assert.equal(await claimSummary(f.people.jade, "2027-12", 1000, 1, lines(1000)), null,
      "December became claimable again");
  });

  test("a malformed month is refused", async () => {
    for (const month of ["2027-13", "2027-00", "27-03", "2027/03", "March"]) {
      const r = await probe(db, { role: "postgres" },
        "select public.claim_birthday_budget_summary($1,$2,1000,1::smallint,$3::jsonb)",
        [f.people.jade, month, JSON.stringify(lines(1000))]);
      assert.equal(r.ok, false, `"${month}" was accepted as a budget month`);
    }
  });

  test("A SUMMARY WHOSE TOTAL DOES NOT MATCH ITS BIRTHDAYS IS REFUSED", async () => {
    /*
     * The figure and the reason for it are written in the same call, so they
     * cannot disagree. Somebody would otherwise be told "£30 this month" above
     * a list that adds to £20.
     */
    const r = await probe(db, { role: "postgres" },
      "select public.claim_birthday_budget_summary($1,'2027-05',3000,1::smallint,$2::jsonb)",
      [f.people.jade, JSON.stringify(lines(2000))]);
    assert.equal(r.ok, false, "a summary was accepted whose total contradicted its lines");
    assert.match(r.error, /total does not match/u);
  });

  test("nothing to say is not worth a notification", async () => {
    for (const [pennies, lineSet] of [[0, lines(0)], [-100, lines(-100)]]) {
      const r = await probe(db, { role: "postgres" },
        "select public.claim_birthday_budget_summary($1,'2027-06',$2,1::smallint,$3::jsonb)",
        [f.people.jade, pennies, JSON.stringify(lineSet)]);
      assert.equal(r.ok, false, `a total of ${pennies} was accepted`);
    }
    const empty = await probe(db, { role: "postgres" },
      "select public.claim_birthday_budget_summary($1,'2027-06',1000,1::smallint,'[]'::jsonb)", [f.people.jade]);
    assert.equal(empty.ok, false, "a summary covering no birthdays was accepted");
  });

  test("and a signed-in person cannot claim a summary either", async () => {
    const asUser = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.claim_birthday_budget_summary($1,'2027-07',1000,1::smallint,$2::jsonb)",
      [f.people.jade, JSON.stringify(lines(1000))]);
    assert.equal(asUser.ok, false, "an authenticated caller claimed a background job");
    assert.match(asUser.error, /permission denied/iu);
  });
});

describe("Q8: a redelivery cannot become a second notification", () => {
  /*
   * `notifications_event_recipient_key` is unique on
   * (app_member_id, event_kind, event_subject_id, category). That index is the
   * whole retry policy: a dispatcher that runs twice writes the same row twice
   * and the second write is refused, so at-least-once delivery upstream becomes
   * at-most-one row downstream.
   */
  const insertNotification = (memberId, kind, subject, category, title) => probe(db, { role: "postgres" }, `
    insert into public.notifications (app_member_id, category, title, body, target_url, event_kind, event_subject_id)
    values ($1, $2, $3, 'body', '/owed', $4, $5)`, [memberId, category, title, kind, subject]);

  const SUBJECT = "11111111-1111-4111-8111-111111111111";

  test("the first delivery is written", async () => {
    await asOwner(db);
    const first = await insertNotification(f.members.jadeAlpha, "purchase", SUBJECT, "purchases", "A purchase");
    assert.equal(first.ok, true, first.error);
  });

  test("A RETRY OF THE SAME EVENT IS REFUSED BY THE INDEX", async () => {
    const retry = await insertNotification(f.members.jadeAlpha, "purchase", SUBJECT, "purchases", "A purchase");
    assert.equal(retry.ok, false, "a retry produced a SECOND notification for one event");
    assert.match(retry.error, /duplicate key|unique/iu);
    await asOwner(db);
    assert.equal(await value(db,
      "select count(*)::int from public.notifications where app_member_id=$1 and event_subject_id=$2",
      [f.members.jadeAlpha, SUBJECT]), 1);
  });

  test("but every recipient still gets their own copy", async () => {
    const other = await insertNotification(f.members.moAlpha, "purchase", SUBJECT, "purchases", "A purchase");
    assert.equal(other.ok, true, "a second member was denied their own notification");
  });

  test("and a different category about the same thing is a different message", async () => {
    // "A purchase was added" and "you now owe £12" are two facts about one
    // event, and a person may legitimately receive both.
    const money = await insertNotification(f.members.jadeAlpha, "purchase", SUBJECT, "money_i_owe", "You owe");
    assert.equal(money.ok, true, "the second category was swallowed by the dedupe key");
  });
});

describe("Q8: the outbox is claimed once and counts its attempts", () => {
  const KIND = "gift_idea";
  const SUBJECT = "22222222-2222-4222-8222-222222222222";

  test("one event row per (kind, subject, fingerprint)", async () => {
    await asOwner(db);
    const insert = (fp) => probe(db, { role: "postgres" }, `
      insert into public.notification_events (kind, subject_id, fingerprint, actor_app_member_id)
      values ($1,$2,$3,$4)`, [KIND, SUBJECT, fp, f.members.jadeAlpha]);
    assert.equal((await insert("fp-1")).ok, true);
    const again = await insert("fp-1");
    assert.equal(again.ok, false, "the same event was queued twice");
    assert.match(again.error, /duplicate key|unique/iu);
    assert.equal((await insert("fp-2")).ok, true, "a genuinely different occurrence was blocked");
  });

  test("ATTEMPTS ARE COUNTED WITHOUT CREATING A SECOND EVENT", async () => {
    // Retry bookkeeping updates the existing row. If a retry inserted instead,
    // the unique key above would refuse it and delivery would stall.
    await asOwner(db);
    await db.query(`update public.notification_events
      set attempt_count = attempt_count + 1, last_attempt_at = now()
      where kind=$1 and subject_id=$2 and fingerprint='fp-1'`, [KIND, SUBJECT]);
    const row = (await rows(db, `select attempt_count, delivered_count, last_attempt_at
      from public.notification_events where kind=$1 and subject_id=$2 and fingerprint='fp-1'`, [KIND, SUBJECT]))[0];
    assert.equal(row.attempt_count, 1);
    assert.ok(row.last_attempt_at, "the attempt was not timestamped, so backoff has nothing to read");
    assert.equal(await value(db,
      "select count(*)::int from public.notification_events where kind=$1 and subject_id=$2", [KIND, SUBJECT]), 2);
  });

  test("and no signed-in person can enqueue an event", async () => {
    const asUser = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.enqueue_notification_event($1,$2,'forged',$3)", [KIND, SUBJECT, f.members.jadeAlpha]);
    assert.equal(asUser.ok, false, "an authenticated caller queued a notification event");
    assert.match(asUser.error, /permission denied/iu);
  });
});

describe("Q8: a notification belongs to one person, and only that person", () => {
  test("A MEMBER READS THEIR OWN AND NOBODY ELSE'S", async () => {
    await asOwner(db);
    const mine = await seen(db, who(f.users.jade, f.areas.alpha), "notifications",
      "app_member_id = $1", [f.members.jadeAlpha]);
    const theirs = await seen(db, who(f.users.jade, f.areas.alpha), "notifications",
      "app_member_id = $1", [f.members.moAlpha]);
    assert.ok(mine > 0, "precondition: this member has notifications");
    assert.equal(theirs, 0, "one member could read another member's notifications");
  });

  test("and cannot mark somebody else's as read", async () => {
    await asOwner(db);
    const target = await value(db,
      "select id from public.notifications where app_member_id = $1 limit 1", [f.members.moAlpha]);
    const attempt = await probe(db, who(f.users.jade, f.areas.alpha),
      "update public.notifications set read_at = now() where id = $1", [target]);
    await asOwner(db);
    assert.equal(await value(db, "select read_at from public.notifications where id = $1", [target]), null,
      "another member's notification was marked read");
    void attempt;
  });

  test("MARKING YOUR OWN READ WORKS, AND STICKS", async () => {
    await asOwner(db);
    const mine = await value(db,
      "select id from public.notifications where app_member_id = $1 and read_at is null limit 1",
      [f.members.jadeAlpha]);
    const marked = await probe(db, who(f.users.jade, f.areas.alpha),
      "update public.notifications set read_at = now() where id = $1", [mine]);
    assert.equal(marked.ok, true, marked.error);
    await asOwner(db);
    assert.ok(await value(db, "select read_at from public.notifications where id = $1", [mine]),
      "the read state did not persist");
  });

  test("A MEMBER OF ANOTHER FAMILY SEES NONE OF IT", async () => {
    // The F1 shape, read side: Bravo's member must not read Alpha's rows even
    // though both are `authenticated` against the same table.
    await asOwner(db);
    const alphaCount = await value(db,
      "select count(*)::int from public.notifications where app_member_id = $1", [f.members.jadeAlpha]);
    assert.ok(alphaCount > 0, "precondition");
    assert.equal(await seen(db, who(f.users.sam, f.areas.bravo), "notifications",
      "app_member_id = $1", [f.members.jadeAlpha]), 0,
      "a Bravo member read an Alpha member's notifications");
  });

  test("and a device belongs to the member who registered it", async () => {
    await asOwner(db);
    await db.query(`insert into public.push_subscriptions (app_member_id, endpoint, p256dh, auth)
      values ($1,'https://push.example/one',$2,$3)`, [f.members.jadeAlpha, P256DH, AUTH]);
    assert.equal(await seen(db, who(f.users.mo, f.areas.alpha), "push_subscriptions",
      "app_member_id = $1", [f.members.jadeAlpha]), 0,
      "one member could read another member's push devices");
    assert.equal(await seen(db, who(f.users.jade, f.areas.alpha), "push_subscriptions",
      "app_member_id = $1", [f.members.jadeAlpha]), 1,
      "a member could not read their own device");
  });

  test("one member may hold several devices", async () => {
    await asOwner(db);
    await db.query(`insert into public.push_subscriptions (app_member_id, endpoint, p256dh, auth)
      values ($1,'https://push.example/two',$2,$3)`, [f.members.jadeAlpha, P256DH, AUTH]);
    assert.equal(await seen(db, who(f.users.jade, f.areas.alpha), "push_subscriptions",
      "app_member_id = $1", [f.members.jadeAlpha]), 2);
  });

  test("AND ONE MEMBER CANNOT DELETE ANOTHER'S DEVICE", async () => {
    await asOwner(db);
    const before = await value(db, "select count(*)::int from public.push_subscriptions where app_member_id=$1",
      [f.members.jadeAlpha]);
    await probe(db, who(f.users.mo, f.areas.alpha),
      "delete from public.push_subscriptions where app_member_id = $1", [f.members.jadeAlpha]);
    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.push_subscriptions where app_member_id=$1",
      [f.members.jadeAlpha]), before, "another member's device was deleted");
  });
});
