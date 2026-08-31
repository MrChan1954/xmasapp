/**
 * THE ROLLBACK AND THE POST-APPLY CHECKS, RUN.
 *
 * A rollback script nobody has executed is a document, not a plan. This runs
 * `docs/Q20-053-ROLLBACK.sql` in full against a disposable PostgreSQL carrying
 * migrations 001-053, reads its own PASS/FAIL report, and then RE-APPLIES 053
 * on top of the rolled-back database -- because a rollback you cannot come back
 * from is only half a rollback.
 *
 * `docs/Q20-053-POST-APPLY-CHECKS.sql` is run here too, on the same disposable
 * database, so the file that will be pasted into the production SQL editor has
 * been proved to parse, to return one table, and to report PASS.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT, applyMigration, asOwner, buildRehearsal, rows, value } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

const CONSENT = "202608100053_family_invitation_consent.sql";
const ROLLBACK = join(ROOT, "docs", "Q20-053-ROLLBACK.sql");
const POST_APPLY = join(ROOT, "docs", "Q20-053-POST-APPLY-CHECKS.sql");

const sqlOf = (path) => readFileSync(path, "utf8");

/**
 * `public.rls_auto_enable`, and the event trigger that fires it, verbatim out of
 * the production schema dump. Production has it; no migration creates it.
 */
const PRODUCTION_OBJECTS = sqlOf(join(ROOT, "scripts", "pg", "production-objects.sql"));

const SWEEP = "NO callable SECURITY DEFINER routine anywhere has a mutable search_path";
const EVENT_TRIGGER_ROW = "event-trigger SECURITY DEFINER functions, reviewed separately from the sweep";

const find = (report, name) => report.find((r) => r.check_name === name);

/** Everything the database owns, as names. */
async function inventory(db) {
  return {
    functions: (await rows(db,
      "select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1"))
      .map((r) => r.proname),
    indexes: (await rows(db,
      "select indexname from pg_indexes where schemaname = 'public' order by 1"))
      .map((r) => r.indexname),
    policies: (await rows(db,
      "select tablename || ' :: ' || policyname as p from pg_policies where schemaname = 'public' order by 1"))
      .map((r) => r.p),
    columns: (await rows(db,
      `select attname from pg_attribute where attrelid = 'public.app_members'::regclass
       and attnum > 0 and not attisdropped order by 1`)).map((r) => r.attname),
  };
}

describe("the 053 post-apply checks", () => {
  let db;
  before(async () => {
    db = await buildRehearsal({});
    // THE REHEARSAL MUST CARRY WHAT PRODUCTION CARRIES, OR IT VERIFIES A
    // DIFFERENT DATABASE. The first production run of the post-apply file
    // reported a FAIL this suite had never seen, because the suite built its
    // schema out of migrations alone and production also holds platform state
    // no migration creates. `production-objects.sql` is that known inventory,
    // verbatim out of the production schema dump; loading it here is what makes
    // a PASS in this file mean the same thing as a PASS in the SQL editor.
    await db.exec(PRODUCTION_OBJECTS);
    await buildTwoFamilies(db);
    await asOwner(db);
  });
  after(async () => { await db?.close(); });

  test("the file is one statement and returns one report", async () => {
    const report = await rows(db, sqlOf(POST_APPLY));
    assert.ok(report.length > 20, `only ${report.length} checks ran`);
    assert.deepEqual(Object.keys(report[0]).sort(), ["check_name", "detail", "result"]);
  });

  test("every check PASSes on a database that really carries 053", async () => {
    const report = await rows(db, sqlOf(POST_APPLY));
    const failed = report.filter((r) => r.result === "FAIL");
    assert.deepEqual(
      failed.map((r) => `${r.check_name} -- ${r.detail}`), [],
      "the post-apply file must report no FAIL on a correctly migrated database",
    );
  });

  test("it reads no email address out of any table", () => {
    // The comments are stripped first. The rule is about the SQL: prose that
    // says the word while explaining why nothing selects it is not a leak, and
    // a guard that cannot tell the two apart makes the file harder to explain.
    const text = sqlOf(POST_APPLY).replace(/--[^\n]*/g, "");
    assert.ok(!/select[^;]*\bemail\b[^;]*from public\.app_members/i.test(text),
      "the census must count invitations without selecting an address");
  });

  test("it writes nothing", () => {
    const text = sqlOf(POST_APPLY).replace(/--[^\n]*/g, "");
    for (const forbidden of [/\binsert\s+into\b/i, /\bupdate\s+public\./i, /\bdelete\s+from\b/i,
      /\bdrop\s+/i, /\balter\s+/i, /\bcreate\s+/i, /\bgrant\s+/i, /\brevoke\s+/i]) {
      assert.ok(!forbidden.test(text), `post-apply checks must be read-only: ${forbidden}`);
    }
  });

  // -------------------------------------------------------------------------
  // The false positive, and the correction to it
  //
  // The first production run reported one FAIL: the schema-wide definer sweep
  // named `rls_auto_enable`. It was the predicate that was wrong, not 053.
  // -------------------------------------------------------------------------

  test("the rehearsal really is carrying the production platform object", async () => {
    // If this fails, every assertion below is being made about a database
    // production does not have, and proves nothing about production.
    const row = await rows(db, `
      select p.prosecdef, p.proconfig, pg_get_function_result(p.oid) as result
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = 'rls_auto_enable'`);
    assert.equal(row.length, 1, "rls_auto_enable must exist in the rehearsal");
    assert.equal(row[0].prosecdef, true);
    assert.equal(row[0].result, "event_trigger");
    assert.deepEqual(row[0].proconfig, ["search_path=pg_catalog"]);
  });

  test("with it live, the sweep PASSes and does not name it", async () => {
    const sweep = find(await rows(db, sqlOf(POST_APPLY)), SWEEP);
    assert.ok(sweep, "the callable-routine sweep must still be in the file");
    assert.equal(sweep.result, "PASS");
    assert.equal(sweep.detail, "none");
  });

  test("it is reported by name instead, as INFO, with every fact about it", async () => {
    const row = find(await rows(db, sqlOf(POST_APPLY)), EVENT_TRIGGER_ROW);
    assert.ok(row, "the event-trigger review row must be in the file");
    assert.equal(row.result, "INFO");
    for (const fact of [
      "rls_auto_enable",
      "returns event_trigger",
      "SECURITY DEFINER",
      "search_path=pg_catalog",
      "not directly callable as an ordinary routine or RPC",
      "platform/Supabase state and not introduced by migration 053",
    ]) {
      assert.ok(row.detail.includes(fact), `the review row must state: ${fact}`);
    }
  });

  test("053's own four routines are still held to the strict rule", async () => {
    const strict = find(await rows(db, sqlOf(POST_APPLY)),
      "every new routine is SECURITY DEFINER with a pinned search_path");
    assert.ok(strict, "the four-routine check must still be in the file");
    assert.equal(strict.result, "PASS");
    assert.equal(strict.detail, "all four correct");
    // And the strict rule is still the empty search_path, unchanged.
    const four = await rows(db, `
      select proname, proconfig from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('list_my_family_invitations', 'accept_family_invitation',
                        'decline_family_invitation', 'record_invitation_delivery')
      order by proname`);
    assert.equal(four.length, 4);
    for (const fn of four) assert.deepEqual(fn.proconfig, ['search_path=""'], fn.proname);
  });

  test("the exception in the sweep is one return type and nothing else", () => {
    const text = sqlOf(POST_APPLY);
    assert.ok(text.includes("and p.prorettype <> 'pg_catalog.event_trigger'::regtype"),
      "the sweep must exclude event triggers by return type, narrowly");

    // The predicate itself, read out of the file: everything between the
    // `union all` that opens the sweep and the name it reports under.
    const end = text.indexOf(`'${SWEEP}'`);
    assert.ok(end > 0, "the sweep must still report under its own name");
    const predicate = text.slice(text.lastIndexOf("union all", end), end)
      .replace(/--[^\n]*/g, "");

    // No name, no owner, no allow-list. An exception written against
    // `rls_auto_enable` by name would excuse any future function borrowing it.
    assert.ok(!predicate.includes("rls_auto_enable"),
      "the sweep must not excuse a routine by name");
    assert.ok(!/proname\s*(<>|!=|not in|not like)/i.test(predicate),
      "the sweep must not excuse a definer routine by name");
    assert.ok(!/proowner|proacl/i.test(predicate),
      "the sweep must not excuse a routine by who owns it or who may call it");
    assert.ok(predicate.includes("p.prosecdef") && !/prosecdef[^\n]*=\s*false/i.test(predicate),
      "the sweep must still be about SECURITY DEFINER routines");
    assert.ok(predicate.includes(`'search_path=""'`),
      "the sweep must still demand the empty search path");
    // Exactly one exclusion clause was added, and it is the return type.
    assert.equal((predicate.match(/prorettype/gu) ?? []).length, 1);
  });
});

/**
 * THE CORRECTED SWEEP, PUT UNDER A ROUTINE IT MUST STILL CATCH.
 *
 * The correction is only worth having if it kept its teeth. Each of these
 * installs one deliberately wrong SECURITY DEFINER routine, reads the report,
 * and takes it away again.
 */
describe("the corrected sweep still catches an ordinary callable definer", () => {
  let db;
  before(async () => {
    db = await buildRehearsal({});
    await db.exec(PRODUCTION_OBJECTS);
    await buildTwoFamilies(db);
    await asOwner(db);
  });
  after(async () => { await db?.close(); });

  /** Install one bad routine, read the sweep row, remove it again. */
  async function sweepWith(definition) {
    await db.exec(definition);
    try {
      return find(await rows(db, sqlOf(POST_APPLY)), SWEEP);
    } finally {
      await db.exec("drop function if exists public.q4b_probe();");
      await asOwner(db);
    }
  }

  test("a definer routine with search_path=public FAILs", async () => {
    const sweep = await sweepWith(`
      create function public.q4b_probe() returns int language sql security definer
      set search_path = public as $probe$ select 1 $probe$;`);
    assert.equal(sweep.result, "FAIL", "an arbitrary non-empty search path is not allowed");
    assert.match(sweep.detail, /q4b_probe -> search_path=public/u);
  });

  test("a definer routine with no search_path at all FAILs", async () => {
    const sweep = await sweepWith(`
      create function public.q4b_probe() returns int language sql security definer
      as $probe$ select 1 $probe$;`);
    assert.equal(sweep.result, "FAIL", "an unpinned definer is the escalation shape");
    assert.match(sweep.detail, /q4b_probe -> UNPINNED/u);
  });

  test("a definer routine pinned to pg_catalog FAILs, because it is callable", async () => {
    // This is the narrowness of the exception, stated as a test: the pinning
    // `rls_auto_enable` uses does NOT excuse a routine somebody can call.
    const sweep = await sweepWith(`
      create function public.q4b_probe() returns int language sql security definer
      set search_path = pg_catalog as $probe$ select 1 $probe$;`);
    assert.equal(sweep.result, "FAIL");
    assert.match(sweep.detail, /q4b_probe -> search_path=pg_catalog/u);
  });

  test("only the event_trigger return type is excused, and it is still reported", async () => {
    await db.exec(`
      create function public.q4b_probe_evt() returns event_trigger language plpgsql
      security definer as $probe$ begin end $probe$;`);
    try {
      const report = await rows(db, sqlOf(POST_APPLY));
      // Excused by the sweep...
      const sweep = find(report, SWEEP);
      assert.equal(sweep.result, "PASS");
      assert.ok(!sweep.detail.includes("q4b_probe_evt"));
      // ...and caught by the row that reviews them, because it is unpinned and
      // is not a known platform object.
      const review = find(report, EVENT_TRIGGER_ROW);
      assert.equal(review.result, "REVIEW", "an unpinned definer event trigger needs a person");
      assert.match(review.detail, /q4b_probe_evt -> returns event_trigger, SECURITY DEFINER, UNPINNED/u);
      assert.match(review.detail, /q4b_probe_evt[^;]*NOT a known platform object/u);
      // The real one is still reported truthfully alongside it.
      assert.match(review.detail, /rls_auto_enable -> returns event_trigger, SECURITY DEFINER, search_path=pg_catalog/u);
    } finally {
      await db.exec("drop function if exists public.q4b_probe_evt();");
      await asOwner(db);
    }
  });

  test("a plain non-definer routine is not swept at all", async () => {
    const sweep = await sweepWith(`
      create function public.q4b_probe() returns int language sql
      as $probe$ select 1 $probe$;`);
    assert.equal(sweep.result, "PASS", "the sweep is about SECURITY DEFINER, and still is");
  });
});

describe("the 053 rollback, executed", () => {
  let db;
  let before053;

  before(async () => {
    db = await buildRehearsal({});
    // Loaded here too, and for a second reason: `rls_auto_enable` fires on
    // CREATE TABLE, and the rollback creates one. Production's copy of the
    // membership rows came out with row level security already on because this
    // trigger turned it on. A rehearsal without it would report a table that is
    // wide open and call that the truth about production.
    await db.exec(PRODUCTION_OBJECTS);
    await buildTwoFamilies(db);
    await asOwner(db);
    before053 = await inventory(db);
  });
  after(async () => { await db?.close(); });

  test("it runs to completion and reports no FAIL", async () => {
    // The rollback is many statements, so it goes through exec, exactly as a
    // paste into the SQL editor would. Its last result is the verify report.
    const results = await db.exec(sqlOf(ROLLBACK));
    const report = results[results.length - 1].rows;
    const failed = report.filter((r) => r.result === "FAIL");
    assert.deepEqual(failed.map((r) => r.check_name), []);
    assert.ok(report.some((r) => r.check_name.startsWith("claim_app_member claims again")));
  });

  test("everything 053 added is gone", async () => {
    await asOwner(db);
    const now = await inventory(db);
    for (const fn of ["list_my_family_invitations", "accept_family_invitation",
      "decline_family_invitation", "record_invitation_delivery"]) {
      assert.ok(!now.functions.includes(fn), `${fn} survived the rollback`);
    }
    assert.ok(!now.columns.includes("declined_at"));
    assert.ok(!now.indexes.includes("app_members_open_invitation_idx"));
  });

  test("nothing 053 did not add was removed", async () => {
    await asOwner(db);
    const now = await inventory(db);
    const lostFunctions = before053.functions.filter(
      (fn) => !now.functions.includes(fn)
        && !["list_my_family_invitations", "accept_family_invitation",
             "decline_family_invitation", "record_invitation_delivery"].includes(fn));
    assert.deepEqual(lostFunctions, []);
    assert.deepEqual(now.policies, before053.policies, "no policy was disturbed");
  });

  test("no membership row was created or destroyed", async () => {
    await asOwner(db);
    assert.equal(
      Number(await value(db, "select count(*) from public.app_members")),
      Number(await value(db, "select count(*) from public.app_members_053_backup")),
    );
  });

  test("the audit rows 053's routines wrote are still there", async () => {
    await asOwner(db);
    const kept = await rows(db,
      `select count(*)::int as n from public.audit_log where table_name = 'app_members'`);
    assert.ok(kept[0].n > 0, "the rollback must delete no family audit history");
  });

  test("053 re-applies cleanly on top of the rolled-back database", async () => {
    const reapplied = await applyMigration(db, CONSENT);
    assert.ok(reapplied.ok, `re-apply failed: ${reapplied.error ?? ""}`);
    await asOwner(db);
    const now = await inventory(db);
    assert.ok(now.columns.includes("declined_at"));
    assert.ok(now.functions.includes("accept_family_invitation"));
    assert.equal(await value(db, "select public.claim_app_member()"), false);
  });

  test("and the post-apply checks PASS again after the round trip", async () => {
    const report = await rows(db, sqlOf(POST_APPLY));
    assert.deepEqual(report.filter((r) => r.result === "FAIL").map((r) => r.check_name), []);
  });

  test("and the post-apply checks then REVIEW the copy the rollback left behind", async () => {
    // Production carries this table today, because 053 was rolled back by
    // accident and re-applied. It holds real email addresses, RLS is on and no
    // policy is attached -- so nobody can read it -- but its presence is a
    // person's decision, which is why the row is REVIEW and not PASS or FAIL.
    await asOwner(db);
    const row = find(await rows(db, sqlOf(POST_APPLY)),
      "no rollback residue is left holding a copy of every membership row");
    assert.ok(row, "the residue check must be in the file");
    assert.equal(row.result, "REVIEW");
    assert.match(row.detail, /app_members_053_backup EXISTS -- row level security ON, policies attached: 0/u);
  });

  test("the rollback file says out loud what it destroys", () => {
    const header = sqlOf(ROLLBACK).slice(0, 4000);
    assert.match(header, /RESTORES THE SILENT AUTO-JOIN/);
    assert.match(header, /DESTROYS DECLINE HISTORY/);
    assert.match(header, /BACKUP/);
  });
});
