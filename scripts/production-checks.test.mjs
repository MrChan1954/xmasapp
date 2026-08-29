/**
 * THE PRODUCTION CHECK FILE IS SAFE TO PASTE INTO A LIVE DATABASE.
 *
 * `docs/PHASE-5-POST-APPLY-CHECKS.sql` is meant to be pasted whole into the
 * Supabase SQL Editor and run against the real family's data. Two things have
 * to be true of it, and neither should rest on somebody having read it
 * carefully:
 *
 *   IT MUST NOT CHANGE ANYTHING. Not a row, not a grant, not an object. It is
 *   swept below for every statement that could.
 *
 *   IT MUST RUN. A file that errors halfway is worse than useless: the person
 *   running it cannot tell a broken query from a broken database. It is
 *   executed here, in full, against a database built by replaying every
 *   migration -- so what is tested is the real thing against the real schema.
 *
 * WHY THE FILE IS ONE STATEMENT. The Supabase SQL Editor shows the result of
 * the LAST statement it runs. An earlier version was twenty-nine queries, so
 * twenty-eight results were invisible; the first of them also asked for
 * `supabase_migrations.schema_migrations`, which this project has never had
 * (no `supabase/config.toml`, no `supabase db push` -- migrations are applied
 * by hand in the SQL Editor). It errored, and nothing else ran.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT, asOwner, buildRehearsal } from "./pg/rehearsal.mjs";

const CHECKS = join(ROOT, "docs", "PHASE-5-POST-APPLY-CHECKS.sql");
const sql = readFileSync(CHECKS, "utf8").replace(/\r\n/gu, "\n");

/**
 * THE FILE WITH ITS COMMENTS AND STRING LITERALS TAKEN OUT.
 *
 * Only what is left is a statement. Comments are allowed to say "insert" and
 * "delete" -- they explain what the database refuses -- and so are string
 * literals: the report prints the words "insert", "update" and "delete" in its
 * own output, and `position('insert into' in ...)` is how it inspects another
 * function's body without running it.
 *
 * A regular expression cannot tell those apart from a statement, so this walks
 * the text properly: line comments, block comments, single-quoted literals with
 * their doubled-quote escapes, and quoted identifiers. Getting this wrong in the
 * lenient direction would let a write slip into a file meant to be pasted into
 * a live database, so it is worth the thirty lines.
 */
function stripCommentsAndLiterals(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const pair = text.slice(i, i + 2);

    if (pair === "--") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (pair === "/*") {
      i += 2;
      while (i < text.length && text.slice(i, i + 2) !== "*/") i += 1;
      i += 2;
      continue;
    }
    if (text[i] === "'") {
      i += 1;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (text[i] === "'") { i += 1; break; }
        i += 1;
      }
      out += " <literal> ";
      continue;
    }
    if (text[i] === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += 1;
      i += 1;
      out += " <identifier> ";
      continue;
    }

    out += text[i];
    i += 1;
  }
  return out;
}

const executable = stripCommentsAndLiterals(sql);

describe("the production check file cannot change anything", () => {
  test("it contains no statement that writes, and none that changes an object", () => {
    /*
     * Word-boundary matches against the executable text. A false positive here
     * is cheap -- rename the thing it tripped on -- and a false negative is a
     * file that alters somebody's live database.
     */
    const FORBIDDEN = [
      "insert", "update", "delete", "upsert", "merge",
      "alter", "create", "drop", "truncate",
      "grant", "revoke", "comment on", "call", "do",
      "vacuum", "analyze", "reindex", "cluster", "refresh",
      "copy", "lock", "set ", "reset", "begin", "commit", "rollback",
      "security definer", "perform", "notify",
    ];

    const found = FORBIDDEN.filter((word) =>
      new RegExp(String.raw`(?<![\w.])${word.trim()}(?![\w])`, "iu").test(executable));

    assert.deepEqual(found, [],
      `these words appear as executable SQL, not just in comments: ${found.join(", ")}`);
  });

  test("every statement in it is a SELECT", () => {
    // Split on semicolons that end a statement. There should be exactly one.
    const statements = executable.split(";").map((s) => s.trim()).filter(Boolean);
    assert.equal(statements.length, 1, "the file must be ONE statement, so the SQL Editor shows its result");
    assert.match(statements[0], /^with\b/iu, "and that statement is a read: a WITH ... SELECT");
  });

  test("it never asks for the Supabase CLI's migration history table", () => {
    // The bug that made it fail on the first block. That table is created by
    // `supabase db push`, which this project has never used.
    assert.ok(!executable.includes("supabase_migrations"),
      "migration state is proved by the objects each migration created, not by a CLI table");
  });

  test("and it reads no money", () => {
    // Counts, ids and object names only. Never an amount.
    for (const column of [
      "budget_pennies", "actual_price_pennies", "estimated_price_pennies",
      "planned_amount_pennies", "responsibility_pennies", "amount_pennies",
    ]) {
      assert.ok(!executable.includes(column), `the check file must not read ${column}`);
    }
  });

  test("it says how to read its own output", () => {
    for (const phrase of ["PASS", "FAIL", "INFO", "REVIEW", "HOW TO RUN IT", "HOW TO READ THE RESULT"]) {
      assert.ok(sql.includes(phrase), `the header must explain ${phrase}`);
    }
  });
});

describe("the production check file actually runs, against the real schema", () => {
  let db;
  let result;

  before(async () => {
    /*
     * THROUGH 040, because that is the state this file describes: it is the
     * check list for the database production is running right now. Q2's
     * migrations 041-043 change two of the things it asserts -- the immediate
     * one-admin index goes -- so running it against a chain that includes them
     * would be checking the wrong database.
     */
    db = await buildRehearsal({ through: "202608100040_own_birthday_wishlist.sql" });
    await asOwner(db);
    result = await db.query(readFileSync(CHECKS, "utf8"));
  });
  after(async () => { await db?.close(); });

  test("it returns one table with the four columns a reader needs", () => {
    assert.ok(result.rows.length > 100, "it should be a substantial report");
    assert.deepEqual(
      Object.keys(result.rows[0]).sort(),
      ["check_name", "detail", "section", "verdict"],
    );
  });

  test("the first row is the summary", () => {
    assert.equal(result.rows[0].section, "SUMMARY");
    assert.match(result.rows[0].detail, /passed, .* failed, .* to review/u);
  });

  test("and against a correctly migrated database, nothing fails", () => {
    const bad = result.rows.filter((row) => row.verdict === "FAIL" || row.verdict === "REVIEW");
    assert.deepEqual(
      bad.map((row) => `${row.section} :: ${row.check_name}`), [],
      "a fresh, fully migrated database must come out clean",
    );
  });

  test("every verdict is one of the four the header explains", () => {
    const kinds = [...new Set(result.rows.map((row) => row.verdict))].sort();
    for (const kind of kinds) {
      assert.ok(["PASS", "FAIL", "INFO", "REVIEW"].includes(kind), `unexpected verdict: ${kind}`);
    }
  });

  test("it checks all seven migrations by name", () => {
    const sections = new Set(result.rows.map((row) => row.section));
    for (const migration of ["034", "035", "036", "037", "038", "039", "040"]) {
      assert.ok([...sections].some((s) => s.startsWith(migration)),
        `no section covers migration ${migration}`);
    }
  });

  test("039's and 040's own protections are each checked, not assumed", () => {
    const named = result.rows.map((row) => row.check_name).join(" | ");
    for (const claim of [
      "is_area_contributor_member",
      "set_person_birthday derives the Area from the person being edited",
      "set_person_birthday no longer asks the global admin question",
      "list_gift_ideas checks the caller belongs to the recipient's Area",
      "gift_ideas_refuse_cross_area_author",
      "the birthday_wishlist_ideas table exists",
      "row level security is ON for the wishlist",
      "all three WRITE policies check that the writer is the birthday person",
      "the wishlist has NO foreign key into the planning",
    ]) {
      assert.ok(named.includes(claim), `the file must check: ${claim}`);
    }
  });

  test("and it still carries the data-integrity checks that predate them", () => {
    const sections = new Set(result.rows.map((row) => row.section));
    for (const section of [
      "orphan rows", "cross-Area links", "money integrity", "administrators",
      "security posture", "function grants", "pre-request hook", "rls_auto_enable",
      "Christmas", "fingerprint (row counts)", "second-family readiness",
    ]) {
      assert.ok(sections.has(section), `the file must still cover: ${section}`);
    }
  });

  test("running it twice changes nothing at all", async () => {
    const fingerprint = async () => (await db.query(`
      select (select count(*) from public.people) p,
             (select count(*) from public.events) e,
             (select count(*) from public.app_members) m,
             (select count(*) from public.areas) a,
             (select count(*) from public.birthday_wishlist_ideas) w,
             (select count(*) from pg_policies where schemaname = 'public') pol,
             (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) fn`)).rows[0];

    const before_ = await fingerprint();
    await db.query(readFileSync(CHECKS, "utf8"));
    await db.query(readFileSync(CHECKS, "utf8"));
    assert.deepEqual(await fingerprint(), before_);
  });
});

/* ===========================================================================
 * THE Q2 CHECK FILE -- the same two promises, for migrations 041 to 043
 *
 * A SECOND FILE RATHER THAN A LONGER ONE, deliberately. The Phase 5 file
 * describes the database production is running RIGHT NOW; it is what proves
 * 034-040 landed, and it will still be the right question to ask afterwards.
 * Q2 changes one of its answers -- 041 drops the immediate one-admin index it
 * asks for -- so the two states cannot be described by one file without it
 * lying about one of them.
 * =========================================================================== */

const Q2_CHECKS = join(ROOT, "docs", "Q2-POST-APPLY-CHECKS.sql");
const q2Sql = readFileSync(Q2_CHECKS, "utf8").replace(/\r\n/gu, "\n");
const q2Executable = stripCommentsAndLiterals(q2Sql);

describe("the Q2 check file cannot change anything either", () => {
  test("it contains no statement that writes, and none that changes an object", () => {
    const FORBIDDEN = [
      "insert", "update", "delete", "upsert", "merge",
      "alter", "create", "drop", "truncate",
      "grant", "revoke", "comment on", "call", "do",
      "vacuum", "analyze", "reindex", "cluster", "refresh",
      "copy", "lock", "set ", "reset", "begin", "commit", "rollback",
      "security definer", "perform", "notify",
    ];

    const found = FORBIDDEN.filter((word) =>
      new RegExp(String.raw`(?<![\w.])${word.trim()}(?![\w])`, "iu").test(q2Executable));

    assert.deepEqual(found, [],
      `these words appear as executable SQL, not just in comments: ${found.join(", ")}`);
  });

  test("every statement in it is a SELECT", () => {
    const statements = q2Executable.split(";").map((s) => s.trim()).filter(Boolean);
    assert.equal(statements.length, 1, "one statement, so the SQL Editor shows its result");
    assert.match(statements[0], /^with\b/iu);
  });

  test("and it reads no money", () => {
    for (const column of [
      "budget_pennies", "actual_price_pennies", "estimated_price_pennies",
      "planned_amount_pennies", "responsibility_pennies", "amount_pennies",
    ]) {
      assert.ok(!q2Executable.includes(column), `the check file must not read ${column}`);
    }
  });

  test("it says how to read its own output", () => {
    for (const phrase of ["PASS", "FAIL", "INFO", "REVIEW", "HOW TO RUN IT", "HOW TO READ THE RESULT"]) {
      assert.ok(q2Sql.includes(phrase), `the header must explain ${phrase}`);
    }
  });

  test("and it warns that it supersedes one row of the Phase 5 file", () => {
    // Somebody will run both. The one FAIL they will see has to be explained
    // in the file itself, not in a conversation they were not part of.
    assert.match(q2Sql, /SUPERSEDED/u);
    assert.ok(q2Sql.includes("app_members_single_admin_per_area_idx"));
  });
});

describe("the Q2 check file actually runs, against a 041-043 database", () => {
  let db;
  let result;

  before(async () => {
    // The whole chain this time, because this file describes the state AFTER
    // Q2 lands.
    db = await buildRehearsal({});
    await asOwner(db);
    result = await db.query(readFileSync(Q2_CHECKS, "utf8"));
  });
  after(async () => { await db?.close(); });

  test("it returns one table with the four columns a reader needs", () => {
    assert.ok(result.rows.length > 30, "it should cover all three migrations");
    assert.deepEqual(
      Object.keys(result.rows[0]).sort(),
      ["check_name", "detail", "section", "verdict"],
    );
  });

  test("the first row is the summary", () => {
    assert.equal(result.rows[0].section, "SUMMARY");
    assert.match(result.rows[0].detail, /passed, .* failed, .* to review/u);
  });

  test("and against a correctly migrated database, nothing fails", () => {
    const bad = result.rows.filter((row) => row.verdict === "FAIL" || row.verdict === "REVIEW");
    assert.deepEqual(bad.map((row) => `${row.section} :: ${row.check_name}`), []);
  });

  test("every verdict is one of the four the header explains", () => {
    for (const kind of new Set(result.rows.map((row) => row.verdict))) {
      assert.ok(["PASS", "FAIL", "INFO", "REVIEW"].includes(kind), `unexpected verdict: ${kind}`);
    }
  });

  test("it checks all three migrations by name", () => {
    const sections = new Set(result.rows.map((row) => row.section));
    for (const migration of ["041", "042", "043"]) {
      assert.ok([...sections].some((s) => s.startsWith(migration)),
        `no section covers migration ${migration}`);
    }
  });

  test("each of Q2's own protections is checked, not assumed", () => {
    const named = result.rows.map((row) => row.check_name).join(" | ");
    for (const claim of [
      "trigger app_members_exactly_one_admin is attached",
      "DEFERRABLE INITIALLY DEFERRED",
      "app_members_single_admin_per_area_idx is GONE",
      "transfer_area_admin runs with definer rights",
      "the audit log accepts a handover being recorded",
      "EVERY family with members has exactly one active administrator",
      "function public.leave_area(uuid) exists",
      "NO login holds two memberships in one family",
      "is_area_contributor_member",
      "privacy beats being admin",
      "NONE of them is callable by a signed-out visitor",
    ]) {
      assert.ok(named.includes(claim), `the file must check: ${claim}`);
    }
  });

  test("running it twice changes nothing at all", async () => {
    const fingerprint = async () => (await db.query(`
      select (select count(*) from public.people) p,
             (select count(*) from public.events) e,
             (select count(*) from public.app_members) m,
             (select count(*) from public.areas) a,
             (select count(*) from public.audit_log) l,
             (select count(*) from pg_policies where schemaname = 'public') pol,
             (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) fn`)).rows[0];

    const before_ = await fingerprint();
    await db.query(readFileSync(Q2_CHECKS, "utf8"));
    await db.query(readFileSync(Q2_CHECKS, "utf8"));
    assert.deepEqual(await fingerprint(), before_);
  });
});

/* ===========================================================================
 * Q3 -- docs/Q3-POST-APPLY-CHECKS.sql
 *
 * A THIRD FILE, for the same reason there is a second. Q3 adds migration 044,
 * which rewrites two function bodies and adds one, and the state it describes
 * did not exist before it. The Phase 5 and Q2 files describe the database as it
 * was at their own moments and are not edited to keep up: each one is the
 * record of what was true when it was written.
 * =========================================================================== */

const Q3_CHECKS = join(ROOT, "docs", "Q3-POST-APPLY-CHECKS.sql");
const q3Sql = readFileSync(Q3_CHECKS, "utf8").replace(/\r\n/gu, "\n");
const q3Executable = stripCommentsAndLiterals(q3Sql);

describe("the Q3 check file cannot change anything either", () => {
  test("it contains no statement that writes, and none that changes an object", () => {
    const FORBIDDEN = [
      "insert", "update", "delete", "upsert", "merge",
      "alter", "create", "drop", "truncate",
      "grant", "revoke", "comment on", "call", "do",
      "vacuum", "analyze", "reindex", "cluster", "refresh",
      "copy", "lock", "set ", "reset", "begin", "commit", "rollback",
      "security definer", "perform", "notify",
    ];

    const found = FORBIDDEN.filter((word) =>
      new RegExp(String.raw`(?<![\w.])${word.trim()}(?![\w])`, "iu").test(q3Executable));

    assert.deepEqual(found, [],
      `these words appear as executable SQL, not just in comments: ${found.join(", ")}`);
  });

  test("every statement in it is a SELECT", () => {
    const statements = q3Executable.split(";").map((s) => s.trim()).filter(Boolean);
    assert.equal(statements.length, 1, "one statement, so the SQL Editor shows its result");
    assert.match(statements[0], /^with\b/iu);
  });

  test("and it reads no money", () => {
    for (const column of [
      "budget_pennies", "actual_price_pennies", "estimated_price_pennies",
      "planned_amount_pennies", "responsibility_pennies", "amount_pennies",
    ]) {
      assert.ok(!q3Executable.includes(column), `the check file must not read ${column}`);
    }
  });

  test("and it names no person, no family and no gift", () => {
    // A check file gets pasted into chats and screenshots. Counts are safe;
    // "Grandma" and "The Taylors" are not.
    for (const column of ["p.name", "a.name", "people.name", "areas.name", "description", "title"]) {
      assert.ok(!q3Executable.includes(column), `the check file must not read ${column}`);
    }
  });

  test("it says how to read its own output", () => {
    for (const phrase of ["PASS", "FAIL", "INFO", "REVIEW", "HOW TO RUN IT", "HOW TO READ THE RESULT"]) {
      assert.ok(q3Sql.includes(phrase), `the header must explain ${phrase}`);
    }
  });

  test("IT CHECKS 045, NOT JUST 044", () => {
    /*
     * The file was written for 044 alone. 045 is the larger half -- nineteen
     * routines rather than three -- and a check file that quietly stopped at
     * the smaller one would report PASS on a database still carrying the
     * escalation it was meant to catch.
     */
    for (const needle of [
      "045 mutation hardening", "045 grants", "045 structural integrity",
      "EVERY targeted mutation calls the guard",
      "NO OTHER authenticated mutation is Area-blind",
      "area_of_settlement", "require_acting_area",
    ]) {
      assert.ok(q3Sql.includes(needle), `the file must check ${needle}`);
    }
  });

  test("and it explains what 044 was for", () => {
    // Whoever runs this months from now was not in the conversation.
    assert.match(q3Sql, /is_app_admin\(\)/u);
    assert.match(q3Sql, /area_of_person/u);
    assert.match(q3Sql, /write barrier/iu);
  });
});

describe("the Q3 check file actually runs, against a 044+045 database", () => {
  let db;
  let result;

  before(async () => {
    db = await buildRehearsal({});
    await asOwner(db);
    result = await db.query(readFileSync(Q3_CHECKS, "utf8"));
  });
  after(async () => { await db?.close(); });

  test("it returns one table with the four columns a reader needs", () => {
    assert.ok(result.rows.length > 10, "it should cover the routines, the grants and the guards");
    assert.deepEqual(
      Object.keys(result.rows[0]).sort(),
      ["check_name", "detail", "section", "verdict"],
    );
  });

  test("the first row is the summary", () => {
    assert.equal(result.rows[0].section, "SUMMARY");
    assert.match(result.rows[0].detail, /passed, .* failed, .* to review/u);
  });

  test("and against a correctly migrated database, nothing fails", () => {
    const bad = result.rows.filter((row) => row.verdict === "FAIL" || row.verdict === "REVIEW");
    assert.deepEqual(bad.map((row) => `${row.section} :: ${row.check_name}`), []);
  });

  test("every verdict is one of the four the header explains", () => {
    for (const kind of new Set(result.rows.map((row) => row.verdict))) {
      assert.ok(["PASS", "FAIL", "INFO", "REVIEW"].includes(kind), `unexpected verdict: ${kind}`);
    }
  });
});

/* ===========================================================================
 * Q6 -- docs/Q6-POST-APPLY-CHECKS.sql
 *
 * A FOURTH FILE, for the same reason there is a third. Q6 adds migration 047,
 * which folds an acting-Area question into four person routines. The state it
 * describes did not exist before it, and the earlier files are not edited to
 * keep up: each one is the record of what was true when it was written.
 *
 * The block below is deliberately the same shape as Q3's. The one test that is
 * new is the negative: a check file that reports PASS on a database WITHOUT
 * the migration is worse than no check file, because it is trusted.
 * =========================================================================== */

const Q6_CHECKS = join(ROOT, "docs", "Q6-POST-APPLY-CHECKS.sql");
const q6Sql = readFileSync(Q6_CHECKS, "utf8").replace(/\r\n/gu, "\n");
const q6Executable = stripCommentsAndLiterals(q6Sql);

describe("the Q6 check file cannot change anything either", () => {
  test("it contains no statement that writes, and none that changes an object", () => {
    const FORBIDDEN = [
      "insert", "update", "delete", "upsert", "merge",
      "alter", "create", "drop", "truncate",
      "grant", "revoke", "comment on", "call", "do",
      "vacuum", "analyze", "reindex", "cluster", "refresh",
      "copy", "lock", "set ", "reset", "begin", "commit", "rollback",
      "security definer", "perform", "notify",
    ];

    const found = FORBIDDEN.filter((word) =>
      new RegExp(String.raw`(?<![\w.])${word.trim()}(?![\w])`, "iu").test(q6Executable));

    assert.deepEqual(found, [],
      `these words appear as executable SQL, not just in comments: ${found.join(", ")}`);
  });

  test("every statement in it is a SELECT", () => {
    const statements = q6Executable.split(";").map((s) => s.trim()).filter(Boolean);
    assert.equal(statements.length, 1, "one statement, so the SQL Editor shows its result");
    assert.match(statements[0], /^with\b/iu);
  });

  test("and it reads no money", () => {
    for (const column of [
      "budget_pennies", "actual_price_pennies", "estimated_price_pennies",
      "planned_amount_pennies", "responsibility_pennies", "amount_pennies",
    ]) {
      assert.ok(!q6Executable.includes(column), `the check file must not read ${column}`);
    }
  });

  test("and it names no person, no family and no gift", () => {
    for (const column of ["p.name", "a.name", "people.name", "areas.name", "description", "title"]) {
      assert.ok(!q6Executable.includes(column), `the check file must not read ${column}`);
    }
  });

  test("it says how to read its own output", () => {
    for (const phrase of ["PASS", "FAIL", "INFO", "REVIEW", "HOW TO RUN IT", "HOW TO READ THE RESULT"]) {
      assert.ok(q6Sql.includes(phrase), `the header must explain ${phrase}`);
    }
  });

  test("IT CHECKS EVERY THING 047 WAS ASKED TO PRESERVE", () => {
    /*
     * Signature, definer, search_path, grants, the guard itself, and the fact
     * that the Area is derived from the person rather than taken from the
     * request. A file that checked only "the routine exists" would report PASS
     * on a routine that had lost its hardening.
     */
    for (const needle of [
      "is_acting_area(target_area)", "area_of_person(p_person_id)",
      "prosecdef", "search_path", "has_function_privilege",
      "is_area_admin(target_area)", "is_area_contributor_member(target_area)",
      "set_person_birthday(uuid,smallint,smallint,smallint)",
      "no unguarded definer writer beyond the five known-safe ones",
    ]) {
      assert.ok(q6Sql.includes(needle), `the file must check ${needle}`);
    }
  });

  test("and it explains what 047 was for, including why Charlie is the sharp case", () => {
    // Whoever runs this months from now was not in the conversation.
    assert.match(q6Sql, /044/u);
    assert.match(q6Sql, /045/u);
    assert.match(q6Sql, /CHARLIE/u);
    assert.match(q6Sql, /genuine administrator/iu);
    assert.match(q6Sql, /require_acting_area/u);
  });
});

describe("the Q6 check file actually runs, against a 047 database", () => {
  let db;
  let result;

  before(async () => {
    db = await buildRehearsal({});
    await asOwner(db);
    result = await db.query(readFileSync(Q6_CHECKS, "utf8"));
  });
  after(async () => { await db?.close(); });

  test("it returns one table with the four columns a reader needs", () => {
    assert.ok(result.rows.length > 10, "it should cover the routines, the grants and the guards");
    assert.deepEqual(
      Object.keys(result.rows[0]).sort(),
      ["check_name", "detail", "section", "verdict"],
    );
  });

  test("the first row is the summary", () => {
    assert.equal(result.rows[0].section, "SUMMARY");
    assert.match(result.rows[0].detail, /passed, .* failed, .* to review/u);
  });

  test("and against a correctly migrated database, nothing fails", () => {
    const bad = result.rows.filter((row) => row.verdict === "FAIL" || row.verdict === "REVIEW");
    assert.deepEqual(bad.map((row) => `${row.section} :: ${row.check_name}`), []);
  });

  test("every verdict is one of the four the header explains", () => {
    for (const kind of new Set(result.rows.map((row) => row.verdict))) {
      assert.ok(["PASS", "FAIL", "INFO", "REVIEW"].includes(kind), `unexpected verdict: ${kind}`);
    }
  });
});

describe("THE Q6 CHECK FILE FAILS ON A DATABASE THAT HAS NOT HAD 047", () => {
  /*
   * The test that gives the file its value. Everything above proves it says
   * PASS when it should; this proves it says FAIL when it should. Without it a
   * check file that had quietly stopped checking would still look healthy.
   */
  let db;
  let result;

  before(async () => {
    db = await buildRehearsal({ through: "202608100046_area_scoped_gift_idea_removal.sql" });
    await asOwner(db);
    result = await db.query(readFileSync(Q6_CHECKS, "utf8"));
  });
  after(async () => { await db?.close(); });

  test("the summary says FAIL", () => {
    assert.equal(result.rows[0].section, "SUMMARY");
    assert.equal(result.rows[0].verdict, "FAIL");
  });

  test("and it names the missing guard on all four routines", () => {
    const guard = result.rows.find((row) => row.check_name.includes("is_acting_area(target_area)"));
    assert.ok(guard, "the guard check should be present");
    assert.equal(guard.verdict, "FAIL");
    for (const name of [
      "set_family_contributor", "set_person_name", "set_person_archived", "set_person_birthday",
    ]) {
      assert.match(guard.detail, new RegExp(name, "u"), `${name} should be reported as unguarded`);
    }
  });

  test("and the drift check notices the routines that are Area-blind", () => {
    const drift = result.rows.find((row) => row.check_name.includes("five known-safe"));
    assert.ok(drift, "the drift check should be present");
    assert.equal(drift.verdict, "REVIEW");
  });
});
