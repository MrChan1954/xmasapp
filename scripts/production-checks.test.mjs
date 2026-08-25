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
    // Every migration, replayed -- so this is the post-040 schema, not a sketch.
    db = await buildRehearsal({});
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
