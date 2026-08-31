/**
 * THE PEOPLE WHO ALREADY SAID YES.
 *
 * Migration 054's section 1 fixes every FUTURE accept and nobody who has
 * already accepted -- and those are exactly the people the architecture exists
 * for. They will not call `accept_family_invitation` again: their invitation is
 * claimed, gone from their list, with nothing left to press. Section 1b is the
 * one-time backfill that settles them, and this file runs it.
 *
 * THE PREDICATE IS THE WHOLE RISK. `app_members.user_id is not null` is true of
 * every membership this installation has ever had, including seats an
 * administrator attached by hand and seats the retired auto-join claimed
 * without asking. Approving those would invent a sponsorship that never
 * happened. So the tests below spend most of their effort on what must NOT be
 * approved.
 *
 * The block is lifted verbatim out of the migration file rather than retyped,
 * so this suite cannot drift from the thing it is testing.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";
import { readFileSync } from "node:fs";

import { asOwner, buildRehearsal, probeValue, rows, value } from "./pg/rehearsal.mjs";
import { buildTwoFamilies, setAccountStatus } from "./pg/fixtures.mjs";

const who = (user, area) => ({ user, role: "authenticated", area });

const MIGRATION = new URL(
  "../supabase/migrations/202608100054_family_sponsored_approval.sql",
  import.meta.url,
);

/** Section 1b, exactly as the migration will run it. */
function backfillBlock() {
  const sql = readFileSync(MIGRATION, "utf8").replace(/\r\n/gu, "\n");
  const section = sql
    .split("-- 1b. THE PEOPLE WHO ALREADY SAID YES")[1]
    .split("-- 2. WHAT MUST BE TRUE AFTERWARDS")[0];
  const start = section.indexOf("do $$");
  const end = section.lastIndexOf("$$;");
  assert.ok(start > -1 && end > start, "the backfill block must be findable in the migration");
  return section.slice(start, end + 3);
}

describe("the one-time backfill for invitations accepted before 054", () => {
  let db;
  let f;
  const BACKFILL = backfillBlock();

  const runBackfill = async () => { await asOwner(db); await db.exec(BACKFILL); };

  async function makeAccount(db_, email) {
    await asOwner(db_);
    return value(db_,
      `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`, [email]);
  }

  async function newPerson(admin, area, name) {
    const created = await probeValue(db, who(admin, area),
      "select public.create_person($1, null, null, null)", [name]);
    assert.ok(created.ok, created.error ?? "");
    await asOwner(db);
    return value(db, "select id from public.people where area_id = $1 and name = $2", [area, name]);
  }

  async function account(userId) {
    const [row] = await rows(db, "select * from public.app_accounts where user_id = $1", [userId]);
    return row ?? null;
  }

  /**
   * A database that looks like production did the moment before 054 landed: a
   * claimed seat, plus whatever audit entry the history in question would have
   * left behind. The options are the ways that entry can fail to be proof.
   */
  async function acceptedBefore054(email, options = {}) {
    const { proof = true, actor = null, summary = null, areaMatches = true } = options;
    const user = await makeAccount(db, email);
    const person = await newPerson(f.users.bravoadmin, f.areas.bravo,
      `P${Math.random().toString(36).slice(2, 8)}`);
    const granted = await probeValue(db, who(f.users.bravoadmin, f.areas.bravo),
      "select public.grant_area_access($1, $2)", [person, email]);
    assert.ok(granted.ok, granted.error ?? "");

    await asOwner(db);
    const seatId = await value(db,
      "select id from public.app_members where lower(email) = $1", [email]);
    // The claim itself, as the retired auto-join made it: a bare UPDATE that
    // crosses no `active` boundary and therefore leaves no trigger entry.
    await db.query("update public.app_members set user_id = $1 where id = $2", [user, seatId]);
    const areaId = await value(db, "select area_id from public.app_members where id = $1", [seatId]);

    if (proof) {
      await db.query(
        `insert into public.audit_log (table_name, record_id, action, actor_user_id, actor_name,
           summary, subject, context, amount_pennies, details, area_id, celebrant_person_id,
           birthday_privacy_unknown)
         values ('app_members', $1, 'added', $2, null, $3, null, null, null, '{}'::jsonb, $4, null, false)`,
        [seatId, actor ?? user, summary ?? "Joined Bravo", areaMatches ? areaId : f.areas.alpha],
      );
    }
    return { user, seatId, areaId };
  }

  before(async () => {
    db = await buildRehearsal({});
    f = await buildTwoFamilies(db);
  });
  after(async () => { await db?.close(); });

  // -------------------------------------------------------------------------
  // What IS settled
  // -------------------------------------------------------------------------

  test("A MISSING ACCOUNT ROW WITH PROOF IS APPROVED", async () => {
    const { user } = await acceptedBefore054("legacy-missing@example.test");
    assert.equal(await account(user), null, "no row beforehand -- which 052 defines as pending");
    await runBackfill();

    const row = await account(user);
    assert.ok(row, "the canonical row now exists");
    assert.equal(row.status, "approved");
    assert.equal(row.is_global_admin, false, "sponsorship grants no administration");
    assert.equal(row.decided_by, null, "and invents no human approver");
    assert.match(row.decision_note, /accepted before sponsorship existed/u);
  });

  test("a PENDING row with proof is approved too", async () => {
    const { user } = await acceptedBefore054("legacy-pending@example.test");
    await asOwner(db);
    await setAccountStatus(db, user, "pending");
    await runBackfill();
    assert.equal((await account(user)).status, "approved");
  });

  // -------------------------------------------------------------------------
  // What is NOT settled, which is where the risk lives
  // -------------------------------------------------------------------------

  test("A CLAIMED SEAT WITH NO ACCEPTANCE ENTRY IS NOT APPROVED", async () => {
    /*
     * The legacy population. The retired auto-join was a bare UPDATE of
     * `user_id`, which never crosses the `active` boundary `record_audit_event`
     * watches, so a silently claimed seat has no entry of its own. Nobody asked
     * those people anything, and this must not pretend otherwise.
     */
    const { user } = await acceptedBefore054("legacy-silent@example.test", { proof: false });
    await runBackfill();
    assert.equal(await account(user), null, "no invitee said yes, so nobody is approved");
  });

  test("AN ADMINISTRATOR'S ENTRY IS NOT THE INVITEE'S", async () => {
    // Somebody added them; they did not accept. The actor is what separates the
    // two, and it is the reason `user_id is not null` cannot be the predicate.
    const { user } = await acceptedBefore054("legacy-adminactor@example.test",
      { actor: f.users.bravoadmin });
    await runBackfill();
    assert.equal(await account(user), null);
  });

  test("AND THE TRIGGER'S OWN WORDING IS NOT AN ACCEPTANCE", async () => {
    /*
     * THE SUBTLE ONE, and the reason the summary is load-bearing.
     * `record_audit_event` (015) writes `format('%s %s', TG_TABLE_NAME,
     * resolved_action)` -- literally `app_members added` -- for every
     * trigger-generated entry. That includes a family founder's own admin seat,
     * which they insert themselves and which therefore matches actor =
     * user_id on every other clause. Only the sentence tells them apart.
     */
    const { user } = await acceptedBefore054("legacy-triggerword@example.test",
      { summary: "app_members added" });
    await runBackfill();
    assert.equal(await account(user), null);
  });

  test("an acceptance recorded against a different Area is not proof", async () => {
    const { user } = await acceptedBefore054("legacy-otherarea@example.test", { areaMatches: false });
    await runBackfill();
    assert.equal(await account(user), null);
  });

  test("A REAL FOUNDER'S OWN ADMIN SEAT MATCHES NOTHING", async () => {
    /*
     * Asked as the predicate itself rather than by approving people, because
     * the interesting population here is the one the fixture built for real:
     * every administrator seat was created by `create_area`, inserted by the
     * founder themselves, and therefore matches actor = user_id on every clause
     * except the sentence.
     *
     * Run against the whole database, so it also covers every ordinary
     * membership the fixture made -- the pre-consent population in miniature.
     * Zero rows is the assertion: nothing that exists here was an explicit
     * acceptance, because nothing here accepted anything.
     */
    await asOwner(db);
    const matched = await rows(db, `
      select m.id, m.role
      from public.app_members m
      join public.audit_log l
        on l.table_name = 'app_members'
       and l.record_id = m.id
       and l.action = 'added'
       and l.actor_user_id = m.user_id
       and l.area_id = m.area_id
       and l.summary like 'Joined %'
      where m.user_id is not null
        and m.active = true
        and m.declined_at is null
        and m.role = 'admin'`);
    assert.deepEqual(matched, [], "creating a family is not accepting an invitation to one");
  });

  test("APPROVED, REJECTED AND SUSPENDED ARE ALL LEFT EXACTLY AS THEY ARE", async () => {
    const cases = {};
    for (const status of ["approved", "rejected", "suspended"]) {
      const { user } = await acceptedBefore054(`legacy-${status}@example.test`);
      await asOwner(db);
      await setAccountStatus(db, user, status);
      cases[status] = { user, before: await account(user) };
    }
    await runBackfill();
    for (const [status, { user, before }] of Object.entries(cases)) {
      const after = await account(user);
      assert.equal(after.status, status, `${status} must survive the backfill`);
      assert.deepEqual(after.decided_at, before.decided_at, `${status}: the human decision stands`);
      assert.ok(!/sponsorship/u.test(after.decision_note ?? ""));
    }
  });

  // -------------------------------------------------------------------------
  // What it must not disturb, and how it behaves on a second run
  // -------------------------------------------------------------------------

  test("THE BACKFILL CHANGES NO MEMBERSHIP, ROLE OR CONTRIBUTOR FLAG", async () => {
    const { user, seatId } = await acceptedBefore054("legacy-untouched@example.test");
    await asOwner(db);
    const [before] = await rows(db, "select * from public.app_members where id = $1", [seatId]);
    const peopleBefore = await value(db, "select count(*) from public.people");
    const membersBefore = await value(db, "select count(*) from public.app_members");
    const contributorsBefore = await value(db,
      "select count(*) from public.people where is_family_contributor = true");

    await runBackfill();

    const [after] = await rows(db, "select * from public.app_members where id = $1", [seatId]);
    assert.deepEqual(after, before, "the seat is byte-identical afterwards");
    assert.equal(await value(db, "select count(*) from public.people"), peopleBefore);
    assert.equal(await value(db, "select count(*) from public.app_members"), membersBefore);
    assert.equal(
      await value(db, "select count(*) from public.people where is_family_contributor = true"),
      contributorsBefore);
    assert.equal((await account(user)).status, "approved", "only the account moved");
  });

  test("IT IS IDEMPOTENT -- a second run decides nothing again", async () => {
    // Which matters beyond tidiness: the rehearsal harness applies this file on
    // every build, and a production apply that were ever retried must not
    // re-stamp somebody's decision.
    const { user } = await acceptedBefore054("legacy-twice@example.test");
    await runBackfill();
    const first = await account(user);
    const decisions = async () => Number(await value(db,
      `select count(*) from public.audit_log
       where table_name = 'app_accounts' and record_id = $1`, [user]));
    const afterOne = await decisions();

    await runBackfill();
    const second = await account(user);
    assert.deepEqual(second.decided_at, first.decided_at, "the decision is not re-stamped");
    assert.equal(await decisions(), afterOne, "and no second audit row is written");
  });

  test("the provenance names the family, the seat and the original acceptance", async () => {
    const { user, seatId, areaId } = await acceptedBefore054("legacy-audited@example.test");
    await runBackfill();
    const [entry] = await rows(db,
      `select action, summary, details, area_id, actor_user_id
       from public.audit_log where table_name = 'app_accounts' and record_id = $1`, [user]);

    assert.equal(entry.action, "decided", "the vocabulary the log already has");
    assert.equal(entry.summary, "Global account set to approved");
    assert.equal(entry.details.source, "family_invitation_backfill",
      "distinguishable from a live sponsorship");
    assert.equal(entry.details.sponsor_area_id, areaId);
    assert.equal(entry.details.sponsor_app_member_id, seatId);
    assert.ok(entry.details.accepted_at, "the original acceptance timestamp is carried");
    assert.ok(entry.details.acceptance_audit_id, "and the entry it was proved from");
    assert.equal(entry.actor_user_id, null, "no human is invented as the approver");
    assert.equal(entry.area_id, null, "a global decision is not a family event");

    const text = JSON.stringify(entry.details).toLowerCase();
    for (const secret of ["@", "token", "password", "http"]) {
      assert.ok(!text.includes(secret), `the audit must not carry ${secret}`);
    }
  });

  // -------------------------------------------------------------------------
  // And the future path is unaffected
  // -------------------------------------------------------------------------

  test("a fresh invitation accepted now is still sponsored by the accept itself", async () => {
    const email = "after-backfill@example.test";
    const user = await makeAccount(db, email);
    const person = await newPerson(f.users.bravoadmin, f.areas.bravo, "AfterBackfill");
    assert.ok((await probeValue(db, who(f.users.bravoadmin, f.areas.bravo),
      "select public.grant_area_access($1, $2)", [person, email])).ok);
    await asOwner(db);
    const seatId = await value(db, "select id from public.app_members where lower(email) = $1", [email]);

    const accepted = await probeValue(db, who(user, null),
      "select public.accept_family_invitation($1)", [seatId]);
    assert.ok(accepted.ok, accepted.error ?? "");
    const row = await account(user);
    assert.equal(row.status, "approved");
    assert.equal(row.decision_note, "Approved by family invitation sponsorship",
      "the live note, not the backfill one");
  });

  test("and public sign-up with no accepted invitation is untouched by any of it", async () => {
    const stranger = await makeAccount(db, "stranger-backfill@example.test");
    await runBackfill();
    assert.equal(await account(stranger), null, "still no row, which is still pending");
  });
});
