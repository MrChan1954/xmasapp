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
    const text = sqlOf(POST_APPLY);
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
});

describe("the 053 rollback, executed", () => {
  let db;
  let before053;

  before(async () => {
    db = await buildRehearsal({});
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

  test("the rollback file says out loud what it destroys", () => {
    const header = sqlOf(ROLLBACK).slice(0, 4000);
    assert.match(header, /RESTORES THE SILENT AUTO-JOIN/);
    assert.match(header, /DESTROYS DECLINE HISTORY/);
    assert.match(header, /BACKUP/);
  });
});
