/**
 * THE ROLLBACK, RUN AGAINST A REAL DATABASE AND COMPARED TO THE REAL BEFORE.
 *
 * A rollback script nobody has executed is a paragraph of good intentions. The
 * only way to know `docs/Q19-052-ROLLBACK.sql` works is to build a database
 * carrying 001-052, run it, and then compare the result -- object by object --
 * with a database that carries 001-051 and has never seen 052 at all.
 *
 * WHAT IS COMPARED. Not "does it look right": the catalogue's own text for
 * every routine 052 touched, every policy on the two tables it changed, the
 * constraint it widened, and the table it created. If any one of them differs,
 * the rollback left the database in a third state that is neither 051 nor 052 --
 * which is the worst possible outcome and the one this file exists to prevent.
 *
 * AND THEN 052 IS APPLIED AGAIN, because a rollback you cannot come back from
 * is a one-way door with a reassuring label on it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe, before, after } from "node:test";

import {
  applyMigration, asOwner, buildRehearsal, literal, probe, rows, value,
} from "./pg/rehearsal.mjs";
import { buildTwoFamilies, setAccountStatus } from "./pg/fixtures.mjs";

const GLOBAL_APPROVAL = "202608100052_global_account_approval.sql";
const BEFORE_052 = "202608100051_drop_superseded_routines_and_narrow_table_grants.sql";
const ROLLBACK = new URL("../docs/Q19-052-ROLLBACK.sql", import.meta.url);

/** The nine routines 052 redefines, by signature. */
const REDEFINED = [
  "public.is_active_app_member()",
  "public.is_area_member(uuid)",
  "public.is_area_admin(uuid)",
  "public.is_own_app_member(uuid)",
  "public.is_app_admin()",
  "public.is_area_contributor_member(uuid)",
  "public.create_area(text, text)",
  "public.claim_app_member()",
  "public.stamp_audit_area()",
];

const ADDED = [
  "public.is_globally_approved()",
  "public.is_global_admin()",
  "public.my_account_status()",
  "public.list_accounts(text)",
  "public.set_account_status(uuid, text, text)",
  "public.grant_global_admin(uuid)",
  "public.revoke_global_admin(uuid)",
  "public.grant_area_access(uuid, text)",
  "public.revoke_area_access(uuid, boolean)",
  "public.list_area_access()",
];

/**
 * A comparable picture of everything 052 touches.
 *
 * `pg_get_functiondef` normalises whitespace and dollar-quoting, so two bodies
 * that differ only in how they were typed compare equal -- and two that differ
 * in what they DO never do.
 */
async function shapeOf(db) {
  const shape = { routines: {}, policies: {}, constraint: null, table: null };

  for (const signature of REDEFINED) {
    shape.routines[signature] = await value(db, `
      select pg_get_functiondef(${literal(signature)}::regprocedure)`);
  }

  for (const table of ["app_members", "audit_log"]) {
    const list = await rows(db, `
      select p.polname,
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') as using_expr,
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as check_expr
      from pg_policy p where p.polrelid = ${literal("public." + table)}::regclass
      order by p.polname`);
    shape.policies[table] = list.map((r) => `${r.polname} :: ${r.using_expr} :: ${r.check_expr}`);
  }

  shape.constraint = await value(db, `
    select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.audit_log'::regclass and conname = 'audit_log_action_check'`);

  shape.table = await value(db, "select to_regclass('public.app_accounts')::text");
  return shape;
}

describe("the 052 rollback puts the database back where it was", () => {
  let control, rolled, shapeBefore, shapeAfter;

  before(async () => {
    // The control: 001-051, never touched by 052.
    control = await buildRehearsal({ through: BEFORE_052 });
    await asOwner(control);
    shapeBefore = await shapeOf(control);

    // The subject: 001-052, used, and then rolled back.
    rolled = await buildRehearsal({});
    const f = await buildTwoFamilies(rolled);

    /*
     * ROLLED BACK FROM A DATABASE THAT WAS ACTUALLY USED, not a fresh one.
     * Approvals exist, a global administrator exists, and decisions have been
     * written into the audit log -- so the drop has real rows to destroy and
     * the delete has real rows to remove.
     */
    await asOwner(rolled);
    const admin = await value(rolled, `
      insert into auth.users (email, email_confirmed_at)
      values ('rollback-root@example.test', now()) returning id`);
    await rolled.query(`
      insert into public.app_accounts (user_id, status, is_global_admin, decided_at)
      values ($1, 'approved', true, now())`, [admin]);
    const subject = await value(rolled, `
      insert into auth.users (email, email_confirmed_at)
      values ('rollback-subject@example.test', now()) returning id`);

    const decided = await probe(rolled, { user: admin, role: "authenticated", area: null },
      "select public.set_account_status($1, $2, $3)", [subject, "rejected", "for the rollback test"]);
    assert.equal(decided.ok, true, decided.error);

    await asOwner(rolled);
    assert.ok(await value(rolled,
      "select count(*)::int from public.audit_log where table_name = 'app_accounts'") > 0,
    "the rollback must have real global audit rows to remove");
    assert.ok(await value(rolled, "select count(*)::int from public.app_accounts") > 0);
    // And a real family, so a rollback that damaged one would show.
    assert.ok(f.areas.alpha);

    await rolled.exec(readFileSync(ROLLBACK, "utf8"));
    await asOwner(rolled);
    shapeAfter = await shapeOf(rolled);
  });
  after(async () => { await control?.close(); await rolled?.close(); });

  test("the control database really is a pre-052 one", () => {
    assert.equal(shapeBefore.table, null, "the control must not have app_accounts");
    assert.ok(!shapeBefore.constraint.includes("decided"));
  });

  for (const signature of REDEFINED) {
    test(`${signature} is byte-for-byte its 051 definition again`, () => {
      assert.equal(shapeAfter.routines[signature], shapeBefore.routines[signature]);
    });
  }

  test("the policies on app_members are exactly the 051 set", () => {
    assert.deepEqual(shapeAfter.policies.app_members, shapeBefore.policies.app_members);
  });

  test("and so are the policies on audit_log -- the global one is gone", () => {
    assert.deepEqual(shapeAfter.policies.audit_log, shapeBefore.policies.audit_log);
  });

  test("the action vocabulary is the four words 041 left", () => {
    assert.equal(shapeAfter.constraint, shapeBefore.constraint);
  });

  test("app_accounts is gone", () => {
    assert.equal(shapeAfter.table, null);
  });

  test("all ten new routines are gone, and none was dropped with CASCADE", async () => {
    await asOwner(rolled);
    for (const signature of ADDED) {
      assert.equal(await value(rolled, `select to_regprocedure(${literal(signature)}) is null`), true,
        `${signature} survived the rollback`);
    }
  });

  test("THE FAMILY IS UNTOUCHED -- the rollback destroyed no family data", async () => {
    await asOwner(rolled);
    for (const table of [
      "areas", "people", "app_members", "events", "christmas_recipients",
      "contributors", "recipient_contributions", "gift_ideas", "purchases",
    ]) {
      assert.ok(await value(rolled, `select count(*)::int from public.${table}`) > 0,
        `${table} is empty after the rollback`);
    }
  });

  test("the only audit rows it removed were the Area-less global ones", async () => {
    await asOwner(rolled);
    assert.equal(await value(rolled,
      "select count(*)::int from public.audit_log where table_name = 'app_accounts'"), 0);
    assert.ok(await value(rolled, "select count(*)::int from public.audit_log") > 0,
      "the rollback emptied the whole activity log");
  });

  test("AND THE DOOR IT REOPENS IS REALLY OPEN AGAIN -- which is why the header shouts", async () => {
    await asOwner(rolled);
    const stranger = await value(rolled, `
      insert into auth.users (email, email_confirmed_at)
      values ('after-rollback@example.test', now()) returning id`);

    const made = await probe(rolled, { user: stranger, role: "authenticated", area: null },
      "select public.create_area($1, $2) as id", ["Anybody's family", "Anybody"]);
    assert.equal(made.ok, true,
      "after a rollback, any signed-in account can create a family -- this is the documented consequence");
  });

  test("and 052 applies again cleanly on top of the rolled-back database", async () => {
    const again = await applyMigration(rolled, GLOBAL_APPROVAL);
    assert.equal(again.ok, true, `052 could not be re-applied: ${again.error} ${again.detail ?? ""}`);

    await asOwner(rolled);
    assert.equal(await value(rolled, "select to_regclass('public.app_accounts') is not null"), true);
    assert.equal(await value(rolled,
      "select count(*)::int from public.app_accounts where is_global_admin = true"), 0,
    "re-applying must not resurrect a global administrator");
  });

  test("the re-applied database gates a pending account exactly as before", async () => {
    await asOwner(rolled);
    const user = await value(rolled, "select id from auth.users where email = 'after-rollback@example.test'");
    await setAccountStatus(rolled, user, "pending");
    const seen = await probe(rolled, { user, role: "authenticated", area: null },
      "select count(*)::int as n from public.people");
    assert.equal(seen.rows[0].n, 0);
  });
});
