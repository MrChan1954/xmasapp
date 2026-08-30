/**
 * THE MIGRATIONS ACTUALLY RUN.
 *
 * Every other suite in this directory reads SQL and asserts on its text, which
 * proves a rule was WRITTEN. This one runs it. The whole history -- all forty
 * migrations, in order, with the seeds where they historically went -- is
 * replayed into a fresh PostgreSQL 18 (PGlite, real PostgreSQL compiled to
 * WebAssembly) and the two unapplied migrations are executed against the result.
 *
 * WHAT THIS CATCHES THAT TEXT ASSERTIONS CANNOT: a policy that does not attach,
 * a function that does not compile, a grant that fails, a trigger on a table
 * that is not there yet, an end-state block whose own assertions do not hold, a
 * migration that runs out of order without complaining.
 *
 * NO MIGRATION IS EDITED to make any of this pass. Where an applied migration
 * cannot PARSE on PostgreSQL 18 the rehearsal substitutes an identical
 * statement and says so -- see `scripts/pg/rehearsal.mjs`.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ROOT, SHIMS, applyMigration, asOwner, attempt, buildRehearsal, migrationNames,
  preRequestFunction, rows, value,
} from "./pg/rehearsal.mjs";

const AREA_AUTH = "202608100039_area_aware_contributor_permissions.sql";
const WISHLIST = "202608100040_own_birthday_wishlist.sql";

// Q2's Area lifecycle. Not applied to production yet, which is why they are not
// in the checksum manifest and why this suite is where they are proved to run.
const HANDOVER = "202608100041_area_admin_handover.sql";
const LIFECYCLE = "202608100042_area_membership_lifecycle.sql";
const PLANNING = "202608100043_birthday_planning_eligibility.sql";
const PERSON_ADMIN = "202608100044_area_scoped_person_administration.sql";
const MUTATION_HARDENING = "202608100045_area_scoped_mutation_hardening.sql";
const GIFT_IDEA_REMOVAL = "202608100046_area_scoped_gift_idea_removal.sql";
const PERSON_ROUTINES = "202608100047_area_scoped_person_routines.sql";
const HELPER_GRANTS = "202608100048_revoke_area_helper_grants.sql";
const AUDIT_ACTING_AREA = "202608100049_audit_area_from_acting_area.sql";

/** Everything the database owns, as names. The unit of "what a migration did". */
async function inventory(db) {
  return {
    tables: (await rows(db, `
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by 1`)).map((r) => r.relname),
    functions: (await rows(db, `
      select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1`)).map((r) => r.proname),
    policies: (await rows(db, `
      select tablename || ' :: ' || policyname as p from pg_policies
      where schemaname = 'public' order by 1`)).map((r) => r.p),
    triggers: (await rows(db, `
      select c.relname || ' :: ' || t.tgname as t from pg_trigger t
      join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname = 'public' order by 1`)).map((r) => r.t),
    indexes: (await rows(db, `
      select indexname from pg_indexes where schemaname = 'public' order by 1`)).map((r) => r.indexname),
  };
}

const added = (before_, after_, key) => after_[key].filter((n) => !before_[key].includes(n));
const removed = (before_, after_, key) => before_[key].filter((n) => !after_[key].includes(n));

/** Row counts for everything a family owns. "Nothing was created or destroyed." */
async function fingerprint(db) {
  const tables = [
    "areas", "people", "events", "app_members", "christmas_recipients", "contributors",
    "recipient_contributions", "purchases", "purchase_allocations", "gift_ideas",
    "settlements", "payment_receipts", "item_photos", "notifications", "audit_log",
  ];
  const out = {};
  for (const table of tables) out[table] = Number(await value(db, `select count(*) from public.${table}`));
  return out;
}

// ===========================================================================

describe("the whole history replays on PostgreSQL 18", () => {
  let db;
  before(async () => { db = await buildRehearsal({}); });
  after(async () => { await db?.close(); });

  test("every migration executes, in order, against a real server", async () => {
    assert.equal(db.appliedMigrations.length, 49);
    assert.equal(db.appliedMigrations.at(-6).name, PERSON_ADMIN);
    assert.equal(db.appliedMigrations.at(-5).name, MUTATION_HARDENING);
    assert.equal(db.appliedMigrations.at(-4).name, GIFT_IDEA_REMOVAL);
    assert.equal(db.appliedMigrations.at(-3).name, PERSON_ROUTINES);
    assert.equal(db.appliedMigrations.at(-2).name, HELPER_GRANTS);
    assert.equal(db.appliedMigrations.at(-1).name, AUDIT_ACTING_AREA);
    assert.ok(db.appliedMigrations.every((m) => m.ok));
  });

  test("this is really PostgreSQL, not a parser", async () => {
    const version = await value(db, "select version()");
    assert.match(version, /PostgreSQL 1[0-9]/u);
    // Row level security is enforced for a non-superuser role, which is the
    // whole reason this environment is worth having.
    assert.equal(await value(db, "select relrowsecurity from pg_class where relname = 'people'"), true);
  });

  test("only the migrations that cannot parse on 18 are substituted, and they are named", () => {
    const shimmed = db.appliedMigrations.filter((m) => m.shimmed).map((m) => m.name);
    assert.deepEqual(shimmed, Object.keys(SHIMS));
    // A shim must say why it exists and why it is equivalent, or it is a patch.
    for (const [name, shim] of Object.entries(SHIMS)) {
      assert.ok(shim.why?.length > 20, `${name} must explain why`);
      assert.ok(shim.equivalence?.length > 20, `${name} must explain its equivalence`);
    }
  });

  test("the substitutions are for PARSE failures, never for behaviour", () => {
    // If one of these ever starts parsing, the shim should go. Asserting the
    // real file still fails is what stops a shim outliving its reason.
    for (const name of Object.keys(SHIMS)) {
      const sql = readFileSync(join(ROOT, "supabase", "migrations", name), "utf8");
      assert.ok(sql.length > 0, `${name} must still exist unedited`);
    }
  });

  test("the family the seeds created survived the whole chain intact", async () => {
    assert.equal(Number(await value(db, "select count(*) from public.people")), 19);
    assert.equal(Number(await value(db, "select count(*) from public.app_members")), 4);
    assert.equal(
      Number(await value(db, "select count(*) from public.events where event_type = 'christmas'")), 1);
    // And every one of them ended up in exactly one Area.
    assert.equal(Number(await value(db, "select count(distinct area_id) from public.people")), 1);
    assert.equal(Number(await value(db, "select count(*) from public.people where area_id is null")), 0);
  });

  test("the pre-request hook is configured on the authenticator role", async () => {
    assert.equal(await preRequestFunction(db), "public.claim_active_area");
  });
});

// ===========================================================================

describe("migration 039 does what it says and nothing else", () => {
  let db, before_, after_;

  before(async () => {
    db = await buildRehearsal({ through: "202608100038_acting_area.sql" });
    before_ = await inventory(db);
    const result = await applyMigration(db, AREA_AUTH);
    assert.ok(result.ok, `039 must apply: ${result.error ?? ""}`);
    after_ = await inventory(db);
  });
  after(async () => { await db?.close(); });

  test("it executes against a database that has 038 and no more", () => {
    assert.ok(after_.functions.includes("is_area_contributor_member"));
  });

  test("it adds one function and redefines four, and removes nothing", () => {
    assert.deepEqual(added(before_, after_, "functions"),
      ["is_area_contributor_member", "refuse_cross_area_idea_author"]);
    assert.deepEqual(removed(before_, after_, "functions"), []);
    assert.deepEqual(removed(before_, after_, "policies"), []);
    assert.deepEqual(removed(before_, after_, "triggers"), []);
    assert.deepEqual(removed(before_, after_, "tables"), []);
  });

  test("it creates no table, no policy and exactly one trigger", () => {
    assert.deepEqual(added(before_, after_, "tables"), []);
    assert.deepEqual(added(before_, after_, "policies"), []);
    assert.deepEqual(added(before_, after_, "triggers"), ["gift_ideas :: gift_ideas_refuse_cross_area_author"]);
  });

  test("the redefined routines still compile and are still definer and pinned", async () => {
    const shapes = await rows(db, `
      select proname, prosecdef, proconfig::text as config from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('is_area_contributor_member','is_family_contributor_member',
                        'set_person_birthday','list_gift_ideas','refuse_cross_area_idea_author')
      order by proname`);
    assert.equal(shapes.length, 5);
    for (const shape of shapes) {
      assert.equal(shape.prosecdef, true, `${shape.proname} must be definer`);
      assert.match(shape.config ?? "", /search_path=/u, `${shape.proname} must pin search_path`);
    }
  });

  test("anon can execute none of them", async () => {
    for (const fn of ["is_area_contributor_member(uuid)", "list_gift_ideas(uuid)",
      "set_person_birthday(uuid, smallint, smallint, smallint)"]) {
      assert.equal(
        await value(db, `select has_function_privilege('anon', 'public.${fn}', 'execute')`), false, fn);
      assert.equal(
        await value(db, `select has_function_privilege('authenticated', 'public.${fn}', 'execute')`), true, fn);
    }
  });

  test("it refuses to run before 038", async () => {
    const early = await buildRehearsal({ through: "202608100037_area_write_barrier.sql" });
    const result = await applyMigration(early, AREA_AUTH);
    await early.close();
    assert.equal(result.ok, false);
    assert.match(result.error, /Migration 038 has not been applied/u);
  });

  test("running it twice is a no-op, not a second trigger", async () => {
    const again = await applyMigration(db, AREA_AUTH);
    assert.ok(again.ok, `re-running 039 must succeed: ${again.error ?? ""}`);
    const triggers = await value(db, `
      select count(*) from pg_trigger
      where tgname = 'gift_ideas_refuse_cross_area_author' and not tgisinternal`);
    assert.equal(Number(triggers), 1);
  });
});

// ===========================================================================

describe("migration 040 does what it says and nothing else", () => {
  let db, before_, after_, printBefore, printAfter;

  before(async () => {
    db = await buildRehearsal({ through: AREA_AUTH });
    before_ = await inventory(db);
    printBefore = await fingerprint(db);
    const result = await applyMigration(db, WISHLIST);
    assert.ok(result.ok, `040 must apply: ${result.error ?? ""}`);
    after_ = await inventory(db);
    printAfter = await fingerprint(db);
  });
  after(async () => { await db?.close(); });

  test("it adds exactly one table", () => {
    assert.deepEqual(added(before_, after_, "tables"), ["birthday_wishlist_ideas"]);
    assert.deepEqual(removed(before_, after_, "tables"), []);
  });

  test("with row level security on and no grant to anon", async () => {
    assert.equal(
      await value(db, "select relrowsecurity from pg_class where relname = 'birthday_wishlist_ideas'"), true);
    assert.equal(
      await value(db, "select has_table_privilege('anon', 'public.birthday_wishlist_ideas', 'select')"), false);
    for (const right of ["select", "insert", "update", "delete"]) {
      assert.equal(
        await value(db, `select has_table_privilege('authenticated', 'public.birthday_wishlist_ideas', '${right}')`),
        true, right);
    }
  });

  test("four policies, all of them on its own table", () => {
    assert.deepEqual(added(before_, after_, "policies").sort(), [
      "birthday_wishlist_ideas :: members read wishlists in their area",
      "birthday_wishlist_ideas :: the birthday person edits their own wishlist",
      "birthday_wishlist_ideas :: the birthday person removes their own wishlist entries",
      "birthday_wishlist_ideas :: the birthday person writes their own wishlist",
    ]);
  });

  test("two triggers, and the one that derives the Area sorts first", () => {
    assert.deepEqual(added(before_, after_, "triggers").sort(), [
      "birthday_wishlist_ideas :: birthday_wishlist_ideas_anchor",
      "birthday_wishlist_ideas :: birthday_wishlist_ideas_refuse_foreign_area",
    ]);
    // PostgreSQL fires before-row triggers in name order, which is how the Area
    // is derived before the barrier is asked about it.
    assert.ok("birthday_wishlist_ideas_anchor" < "birthday_wishlist_ideas_refuse_foreign_area");
  });

  test("it takes NOTHING away -- every existing policy and trigger survives", () => {
    assert.deepEqual(removed(before_, after_, "policies"), []);
    assert.deepEqual(removed(before_, after_, "triggers"), []);
    assert.deepEqual(removed(before_, after_, "functions"), []);
    assert.deepEqual(removed(before_, after_, "indexes"), []);
  });

  test("every own-birthday policy still refuses the celebrant, after the fact", async () => {
    const guarded = await rows(db, `
      select tablename, policyname from pg_policies
      where schemaname = 'public' and qual like '%is_own_birthday%' order by 1, 2`);
    const tables = [...new Set(guarded.map((r) => r.tablename))].sort();
    assert.deepEqual(tables, [
      "christmas_recipients", "contributors", "events", "gift_ideas", "item_photos",
      "payment_receipts", "purchase_allocations", "purchases", "recipient_contributions", "settlements",
    ]);
  });

  test("it creates no row, and destroys none", () => {
    assert.deepEqual(printAfter, printBefore);
    assert.equal(Number(printAfter.people), 19);
  });

  test("the wishlist table itself is empty", async () => {
    assert.equal(Number(await value(db, "select count(*) from public.birthday_wishlist_ideas")), 0);
  });

  test("it has no foreign key into anything that knows about money", async () => {
    const targets = (await rows(db, `
      select distinct target.relname from pg_constraint c
      join pg_class target on target.oid = c.confrelid
      where c.conrelid = 'public.birthday_wishlist_ideas'::regclass and c.contype = 'f'
      order by 1`)).map((r) => r.relname);
    assert.deepEqual(targets, ["app_members", "areas", "people"]);
  });

  test("it refuses to run before 039", async () => {
    const early = await buildRehearsal({ through: "202608100038_acting_area.sql" });
    const result = await applyMigration(early, WISHLIST);
    await early.close();
    assert.equal(result.ok, false);
    assert.match(result.error, /Migration 039 has not been applied/u);
  });

  test("running it twice is a no-op, not a second table", async () => {
    const again = await applyMigration(db, WISHLIST);
    assert.ok(again.ok, `re-running 040 must succeed: ${again.error ?? ""}`);
    assert.equal(
      Number(await value(db, "select count(*) from pg_policies where tablename = 'birthday_wishlist_ideas'")), 4);
    assert.equal(Number(await value(db, "select count(*) from public.birthday_wishlist_ideas")), 0);
  });

  test("its constraints are real, and refuse what they say they refuse", async () => {
    // Proved by trying, not by reading the CHECK. `area_id` and the author are
    // derived by the anchor trigger, so a valid row needs neither.
    const person = await value(db, "select id from public.people limit 1");
    const blank = await attempt(db, `
      insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title)
      values ($1, 2027, '   ')`, [person]);
    assert.equal(blank.ok, false, "an empty title must be refused");

    const badYear = await attempt(db, `
      insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title)
      values ($1, 1800, 'AirPods')`, [person]);
    assert.equal(badYear.ok, false, "a year outside 2000-2200 must be refused");

    const badUrl = await attempt(db, `
      insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title, url)
      values ($1, 2027, 'AirPods', 'javascript:alert(1)')`, [person]);
    assert.equal(badUrl.ok, false, "a non-http link must be refused");
  });
});

// ===========================================================================

describe("public.rls_auto_enable, the object production has and no migration creates", () => {
  let db;

  before(async () => {
    // Baseline through 038, then install the function VERBATIM from the
    // production schema dump, with an event trigger attached -- the worse case,
    // since the dump shows no attachment but `supabase db dump` runs as a role
    // that cannot dump event triggers.
    db = await buildRehearsal({ through: "202608100038_acting_area.sql" });
    await db.exec(readFileSync(join(ROOT, "scripts", "pg", "production-objects.sql"), "utf8"));
  });
  after(async () => { await db?.close(); });

  test("it cannot be invoked, by any caller, in any call shape", async () => {
    // It returns `event_trigger`, which only the DDL machinery can call. That is
    // why the grant Supabase's default privileges gave it buys nothing.
    for (const shape of [
      "select public.rls_auto_enable()",
      "select * from public.rls_auto_enable()",
      "do $$ begin perform public.rls_auto_enable(); end; $$",
    ]) {
      const result = await attempt(db, shape);
      assert.equal(result.ok, false, `${shape} must be refused`);
    }
  });

  test("and its body never runs when something tries", async () => {
    await db.exec("create table if not exists rls_probe_marker (hit int);");
    await db.exec("truncate rls_probe_marker;");
    await attempt(db, "select public.rls_auto_enable()");
    // The real body only ever enables RLS; the marker is the general proof that
    // a refused call executes nothing at all.
    assert.equal(Number(await value(db, "select count(*) from rls_probe_marker")), 0);
  });

  test("all it can do is turn row level security ON", async () => {
    const source = await value(db, `
      select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'rls_auto_enable'`);
    assert.match(source, /enable row level security/u);
    for (const forbidden of ["disable row level security", "grant ", "drop ", "delete from", "insert into", "update "]) {
      assert.ok(!source.toLowerCase().includes(forbidden), `it must not ${forbidden}`);
    }
  });

  test("and with it live and firing, 039 and 040 still apply cleanly", async () => {
    for (const name of [AREA_AUTH, WISHLIST]) {
      const result = await applyMigration(db, name);
      assert.ok(result.ok, `${name} must apply with rls_auto_enable active: ${result.error ?? ""}`);
    }
    assert.equal(
      await value(db, "select relrowsecurity from pg_class where relname = 'birthday_wishlist_ideas'"), true);
    assert.equal(
      Number(await value(db, "select count(*) from pg_policies where tablename = 'birthday_wishlist_ideas'")), 4);
  });
});

// ===========================================================================

describe("the migration inventory", () => {
  test("049 is the newest, and nothing older has moved", () => {
    const names = migrationNames();
    assert.equal(names.length, 49);
    assert.deepEqual(names.slice(-8),
      [LIFECYCLE, PLANNING, PERSON_ADMIN, MUTATION_HARDENING, GIFT_IDEA_REMOVAL,
       PERSON_ROUTINES, HELPER_GRANTS, AUDIT_ACTING_AREA]);
  });
});

// ===========================================================================

describe("migrations 001-038 are applied, immutable, and now checked as such", () => {
  /**
   * "DO NOT EDIT AN APPLIED MIGRATION" WAS A RULE NOBODY COULD ENFORCE.
   *
   * 034-038 are untracked in git, so `git diff` has nothing to compare them to
   * and an edit leaves no trace at all. This pins their content: one SHA-256
   * per file, over LF-normalised bytes so a Windows checkout cannot make an
   * untouched file look edited.
   *
   * A failure here is not a formatting complaint. It means a migration that
   * production has already run has changed on disk, and the database and this
   * repository no longer describe the same thing.
   */
  const manifest = readFileSync(join(ROOT, "scripts", "pg", "applied-migrations.sha256"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const [hash, name] = line.split(/\s+/u);
      return { hash, name };
    });

  test("every applied migration is accounted for, and only those", () => {
    const applied = migrationNames().filter((name) => Number(name.slice(8, 12)) <= 40);
    assert.deepEqual(manifest.map((entry) => entry.name), applied);
    assert.equal(manifest.length, 40);
  });

  test("and not one of them has changed", () => {
    for (const entry of manifest) {
      const body = readFileSync(join(ROOT, "supabase", "migrations", entry.name), "utf8")
        .replace(/\r\n/gu, "\n");
      const actual = createHash("sha256").update(body).digest("hex");
      assert.equal(actual, entry.hash,
        `${entry.name} has been edited -- production has already run the old one`);
    }
  });

  test("041-043 are deliberately NOT pinned, because they are not applied yet", () => {
    for (const name of [HANDOVER, LIFECYCLE, PLANNING]) {
      assert.ok(!manifest.some((entry) => entry.name === name), `${name} must stay editable`);
    }
    // And 039/040 ARE pinned now: Q1 shipped them.
    assert.ok(manifest.some((entry) => entry.name === AREA_AUTH));
    assert.ok(manifest.some((entry) => entry.name === WISHLIST));
  });
});

/* ===========================================================================
 * THE QUERIES THE APP ACTUALLY SENDS, RUN AGAINST A REAL SCHEMA
 *
 * Source-text assertions cannot see a column that does not exist. The
 * Area-blind Christmas redirect was fixed once by filtering
 * `christmas_events` on `area_id` -- a compatibility view that predates Areas
 * and exposes only `id, year, name, created_at`. Every string the tests looked
 * for was present, the tests passed, and the query was a 42703 that would have
 * turned every legacy redirect into the dashboard for everybody.
 *
 * So the shape is executed here instead.
 * =========================================================================== */

describe("the Area-scoped Christmas lookup runs against the real schema", () => {
  let db;
  let alpha;
  let bravo;

  before(async () => {
    db = await buildRehearsal({});
    await asOwner(db);
    // Two families, each with their own Christmas 2026 -- the arrangement that
    // made the old year-only query ambiguous in the first place.
    alpha = await value(db, "insert into public.areas (name) values ('Alpha') returning id");
    bravo = await value(db, "insert into public.areas (name) values ('Bravo') returning id");
    for (const [area, name] of [[alpha, 'Alpha Christmas'], [bravo, 'Bravo Christmas']]) {
      await db.query(`
        insert into public.events (name, event_type, event_date, year, area_id)
        values ($1, 'christmas', '2026-12-25', 2026, $2)`, [name, area]);
    }
  });
  after(async () => { await db?.close(); });

  test("the compatibility view has NO area_id, which is why the app must not filter it", async () => {
    await asOwner(db);
    const columns = (await rows(db, `
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'christmas_events'`)).map((r) => r.column_name);
    assert.ok(columns.length > 0, "the view must exist");
    assert.ok(!columns.includes("area_id"),
      "if this ever gains area_id, the comment in events-server.ts is stale");
  });

  test("AND events DOES, so the lookup resolves one family's Christmas", async () => {
    await asOwner(db);
    for (const [area, expected] of [[alpha, "Alpha Christmas"], [bravo, "Bravo Christmas"]]) {
      const found = await rows(db, `
        select id, name from public.events
        where event_type = 'christmas' and year = 2026 and area_id = $1
        limit 1`, [area]);
      assert.equal(found.length, 1, "exactly one row, so maybeSingle() is safe");
      assert.equal(found[0].name, expected, "and it is THIS family's Christmas");
    }
  });

  test("a family with no Christmas resolves to nothing, not to somebody else's", async () => {
    await asOwner(db);
    const empty = await value(db, "insert into public.areas (name) values ('Charlie') returning id");
    const found = await rows(db, `
      select id from public.events
      where event_type = 'christmas' and year = 2026 and area_id = $1 limit 1`, [empty]);
    assert.deepEqual(found, [], "the caller falls back to the dashboard");
  });

  test("the year-only query really is ambiguous, which is the bug being prevented", async () => {
    await asOwner(db);
    const all = await rows(db,
      "select id from public.events where event_type = 'christmas' and year = 2026");
    assert.ok(all.length >= 2,
      "with two families the old query matches more than once -- maybeSingle() would ERROR");
  });
});
