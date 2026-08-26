/**
 * Q3: PERSON, CONTRIBUTOR, ACCOUNT, ADMIN -- FOUR THINGS, NOT ONE.
 *
 * The product rule this file defends, in one sentence each:
 *
 *   PERSON       a durable family record. Grandma is one and always will be.
 *   CONTRIBUTOR  may be asked to share the cost of a gift. A flag on the
 *                PERSON, so somebody with no login at all can be one.
 *   ACCOUNT      a login. Most people never need one.
 *   ADMIN        who runs THIS family. A property of the MEMBERSHIP, per Area,
 *                and changed only by handover.
 *
 * Collapsing any pair of these is the bug. Giving somebody an account must not
 * make them a contributor; making them a contributor must not give them a
 * login; neither may make them an administrator; and none of it may reach into
 * another family.
 *
 * THE DATABASE HALF IS RUN, NOT READ. Section 1 drives real routines against a
 * real PostgreSQL 18 with all forty-four migrations applied, through the same
 * shape a browser request has. The screens are swept as text afterwards,
 * because what a screen SAYS is the only thing text can answer.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { describe, before, after } from "node:test";

import { ROOT, asOwner, buildRehearsal, probe, rows, value } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/gu, "\n");
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\{\/\*[\s\S]*?\*\/\}/gu, "").replace(/^\s*\/\/.*$/gmu, "");

const APP = ["src", "app"];
const PANEL = ["src", "app", "people", "[id]", "person-admin-panel.tsx"];

let db;
let f;
const who = (user, area) => ({ user, area });

before(async () => { db = await buildRehearsal({}); f = await buildTwoFamilies(db); });
after(async () => { await db?.close(); });

// ===========================================================================
// 1. The four concepts, proved apart, against a real database
// ===========================================================================

describe("changing one of the four changes exactly one of the four", () => {
  /**
   * A PERSON WITH NO LOGIN, made for these tests.
   *
   * Every fixture account has a membership, and "somebody with no account" is
   * precisely the case that matters here: most of a real family is exactly
   * that. Created through `create_person`, which is the only way in, so the
   * starting state is the product's own.
   */
  let noAccount;
  before(async () => {
    const created = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.create_person('Nobody QA', null::smallint, null::smallint, null::smallint)).id as id");
    assert.ok(created.ok, created.error);
    noAccount = created.rows[0].id;
  });

  /** Everything worth knowing about a person, in one row. */
  const snapshot = async (personId) => {
    await asOwner(db);
    const person = (await rows(db,
      "select name, is_family_contributor, archived_at, area_id from public.people where id = $1",
      [personId]))[0];
    const membership = (await rows(db,
      "select role, active, user_id, person_id from public.app_members where person_id = $1",
      [personId]))[0] ?? null;
    return { person, membership };
  };

  test("MAKING SOMEBODY A CONTRIBUTOR GIVES THEM NO LOGIN", async () => {
    const before = await snapshot(noAccount);
    assert.equal(before.membership, null, "they must start with no account");

    const done = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_family_contributor($1, true)", [noAccount]);
    assert.ok(done.ok, done.error);

    const after = await snapshot(noAccount);
    assert.equal(after.person.is_family_contributor, true, "the one thing that changed");
    assert.equal(after.membership, null, "AND STILL NO ACCOUNT. Contributing is not signing in.");
    assert.equal(after.person.name, before.person.name);
    assert.equal(after.person.archived_at, before.person.archived_at);
  });

  test("and taking it away removes no login either", async () => {
    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_family_contributor($1, false)", [noAccount]);
    const after = await snapshot(noAccount);
    assert.equal(after.person.is_family_contributor, false);
    assert.equal(after.membership, null);
  });

  test("A CONTRIBUTOR CHANGE REWRITES NO MONEY", async () => {
    /*
     * The promise migration 030 made and 044 keeps: eligibility is about what
     * happens NEXT. Taylor's birthday already has planned contributions and a
     * purchase behind it, and none of it may move.
     */
    await asOwner(db);
    const moneyBefore = await rows(db, `
      select
        (select count(*) from public.recipient_contributions) as contributions,
        (select count(*) from public.purchases) as purchases,
        (select count(*) from public.purchase_allocations) as allocations,
        (select count(*) from public.contributors) as contributors`);

    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_family_contributor($1, true)", [f.people.jade]);
    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_family_contributor($1, false)", [f.people.jade]);

    await asOwner(db);
    const moneyAfter = await rows(db, `
      select
        (select count(*) from public.recipient_contributions) as contributions,
        (select count(*) from public.purchases) as purchases,
        (select count(*) from public.purchase_allocations) as allocations,
        (select count(*) from public.contributors) as contributors`);
    assert.deepEqual(moneyAfter, moneyBefore, "not one financial row may move");

    // Put Jade back the way the fixture built her.
    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_family_contributor($1, true)", [f.people.jade]);
  });

  test("RENAMING SOMEBODY MOVES NOTHING ELSE ABOUT THEM", async () => {
    const before = await snapshot(noAccount);
    const done = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_name($1, 'Nobody Corrected')", [noAccount]);
    assert.ok(done.ok, done.error);

    const after = await snapshot(noAccount);
    assert.equal(after.person.name, "Nobody Corrected");
    assert.equal(after.person.area_id, before.person.area_id, "a rename is not a move between families");
    assert.equal(after.person.is_family_contributor, before.person.is_family_contributor);
    assert.equal(after.person.archived_at, before.person.archived_at);
    assert.equal(after.membership, null);

    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_name($1, 'Nobody QA')", [noAccount]);
  });

  test("ARCHIVING KEEPS THE PERSON, THEIR ID AND THEIR WHOLE HISTORY", async () => {
    /*
     * The reason there is no "delete person". Taylor has a birthday, a
     * recipient row, a purchase and gift ideas behind them. Archiving is one
     * timestamp and must leave every one of those exactly where it is.
     */
    await asOwner(db);
    const historyBefore = await rows(db, `
      select
        (select count(*) from public.christmas_recipients where person_id = $1) as recipiencies,
        (select count(*) from public.purchases p join public.christmas_recipients r
           on r.id = p.christmas_recipient_id where r.person_id = $1) as purchases,
        (select count(*) from public.gift_ideas g join public.christmas_recipients r
           on r.id = g.christmas_recipient_id where r.person_id = $1) as ideas`, [f.people.taylor]);

    const done = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_archived($1, true)", [f.people.taylor]);
    assert.ok(done.ok, done.error);

    await asOwner(db);
    const still = (await rows(db,
      "select id, name, birthday_month, archived_at from public.people where id = $1", [f.people.taylor]))[0];
    assert.ok(still, "THE PERSON STILL EXISTS. Archiving is not deletion.");
    assert.equal(still.id, f.people.taylor, "and keeps their id, so every foreign key still resolves");
    assert.ok(still.archived_at, "only the timestamp is new");
    assert.ok(still.birthday_month, "their birthday is untouched");

    const historyAfter = await rows(db, `
      select
        (select count(*) from public.christmas_recipients where person_id = $1) as recipiencies,
        (select count(*) from public.purchases p join public.christmas_recipients r
           on r.id = p.christmas_recipient_id where r.person_id = $1) as purchases,
        (select count(*) from public.gift_ideas g join public.christmas_recipients r
           on r.id = g.christmas_recipient_id where r.person_id = $1) as ideas`, [f.people.taylor]);
    assert.deepEqual(historyAfter, historyBefore, "every piece of history survives");

    // And restoring is the exact inverse.
    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_archived($1, false)", [f.people.taylor]);
    await asOwner(db);
    assert.equal(
      await value(db, "select archived_at from public.people where id = $1", [f.people.taylor]), null);
  });
});

// ===========================================================================
// 2. Every one of them asks about the RIGHT family
// ===========================================================================

describe("administering one family is no authority in another", () => {
  /**
   * THE HOLE Q3 FOUND, AND THE REASON MIGRATION 044 EXISTS.
   *
   * `set_family_contributor` and `set_person_archived` asked `is_app_admin()`
   * -- which answers about the Area the caller SAID they are acting in -- and
   * then wrote `where id = p_person_id`, with no Area anywhere. Migration 037's
   * write barrier does not catch it: it refuses a writer who is not a MEMBER of
   * the row's Area, which is no help against somebody who belongs to both.
   *
   * `dual` administers Alpha and is an ordinary member of Bravo. Before 044,
   * acting in Alpha, they flipped a Bravo person's contributor flag and
   * archived a Bravo person. Both are refused now.
   */
  const asAlphaAdminOnBravoPerson = (sql) =>
    probe(db, who(f.users.dual, f.areas.alpha), sql, [f.people.jem]);

  test("the setup is real: admin here, only a member there", async () => {
    const here = await probe(db, who(f.users.dual, f.areas.alpha), "select public.is_app_admin() as x");
    const there = await probe(db, who(f.users.dual, f.areas.bravo), "select public.is_app_admin() as x");
    assert.equal(here.rows[0].x, true, "administers Alpha");
    assert.equal(there.rows[0].x, false, "and merely belongs to Bravo");
    assert.equal(
      await (async () => { await asOwner(db); return value(db, "select area_id from public.people where id = $1", [f.people.jem]); })(),
      f.areas.bravo, "and Jem is a Bravo person");
  });

  test("CONTRIBUTOR: refused across the Area boundary", async () => {
    await asOwner(db);
    const before = await value(db, "select is_family_contributor from public.people where id = $1", [f.people.jem]);
    const refused = await asAlphaAdminOnBravoPerson("select public.set_family_contributor($1, true)");
    assert.equal(refused.ok, false, "an Alpha admin may not touch a Bravo person");
    await asOwner(db);
    assert.equal(await value(db, "select is_family_contributor from public.people where id = $1", [f.people.jem]), before);
  });

  test("ARCHIVE: refused across the Area boundary", async () => {
    const refused = await asAlphaAdminOnBravoPerson("select public.set_person_archived($1, true)");
    assert.equal(refused.ok, false);
    await asOwner(db);
    assert.equal(await value(db, "select archived_at from public.people where id = $1", [f.people.jem]), null);
  });

  test("RENAME: refused across the Area boundary", async () => {
    const refused = await asAlphaAdminOnBravoPerson("select public.set_person_name($1, 'Hacked')");
    assert.equal(refused.ok, false);
    await asOwner(db);
    assert.equal(await value(db, "select name from public.people where id = $1", [f.people.jem]), "Jem");
  });

  test("BIRTHDAY: still refused, as migration 039 already made it", async () => {
    const refused = await asAlphaAdminOnBravoPerson(
      "select public.set_person_birthday($1, 5::smallint, 5::smallint, null::smallint)");
    assert.equal(refused.ok, false);
  });

  test("and a person who does not exist is the SAME refusal as one in another family", async () => {
    // Telling the two apart would let somebody discover who exists elsewhere.
    const missing = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_name($1, 'x')", ["3f2b1c4d-9a7e-4b21-8c6f-5d4e3a2b1c09"]);
    const foreign = await asAlphaAdminOnBravoPerson("select public.set_person_name($1, 'x')");
    assert.equal(missing.ok, false);
    assert.equal(foreign.ok, false);
    assert.equal(missing.error, foreign.error, "the same sentence for both");
  });
});

// ===========================================================================
// 3. A plain member administers nobody
// ===========================================================================

describe("the authorization matrix, run rather than described", () => {
  test("an ordinary member of this family may not rename, archive or re-elect anybody", async () => {
    for (const [what, sql] of [
      ["rename", "select public.set_person_name($1, 'Nope')"],
      ["archive", "select public.set_person_archived($1, true)"],
      ["contributor", "select public.set_family_contributor($1, true)"],
    ]) {
      const refused = await probe(db, who(f.users.taylor, f.areas.alpha), sql, [f.people.mo]);
      assert.equal(refused.ok, false, `a member must not be able to ${what}`);
    }
  });

  test("A CONTRIBUTOR IS NOT AN ADMIN", async () => {
    // Jade is Alpha's contributor. Contributing money is not administering
    // people, and migration 039 gave contributors birthdays and nothing else.
    const birthday = await probe(db, who(f.users.jade, f.areas.alpha),
      "select public.set_person_birthday($1, 4::smallint, 1::smallint, null::smallint)", [f.people.mo]);
    assert.ok(birthday.ok, "a contributor may keep the calendar current");

    for (const [what, sql] of [
      ["rename", "select public.set_person_name($1, 'Nope')"],
      ["archive", "select public.set_person_archived($1, true)"],
      ["elect another contributor", "select public.set_family_contributor($1, true)"],
    ]) {
      const refused = await probe(db, who(f.users.jade, f.areas.alpha), sql, [f.people.mo]);
      assert.equal(refused.ok, false, `a contributor must not be able to ${what}`);
    }

    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_birthday($1, null::smallint, null::smallint, null::smallint)", [f.people.mo]);
  });

  test("a NON-MEMBER of this family is refused, and reads nothing", async () => {
    const refused = await probe(db, who(f.users.bravoadmin, f.areas.alpha),
      "select public.set_person_name($1, 'Nope')", [f.people.mo]);
    assert.equal(refused.ok, false);

    const seen = await probe(db, who(f.users.bravoadmin, f.areas.alpha),
      "select id from public.people where id = $1", [f.people.mo]);
    assert.deepEqual(seen.rows, [], "and cannot even see them");
  });

  test("a DEACTIVATED membership is no membership", async () => {
    await asOwner(db);
    await db.query("update public.app_members set active = false where user_id = $1 and area_id = $2",
      [f.users.taylor, f.areas.alpha]);

    const seen = await probe(db, who(f.users.taylor, f.areas.alpha), "select id from public.people");
    assert.deepEqual(seen.rows, [], "an inactive member reads nothing in the family they left");

    await asOwner(db);
    await db.query("update public.app_members set active = true where user_id = $1 and area_id = $2",
      [f.users.taylor, f.areas.alpha]);
  });
});

// ===========================================================================
// 4. One login, two families, two different people
// ===========================================================================

describe("the same login is a different person in each family", () => {
  test("jade is one auth account and TWO people, with different eligibility", async () => {
    await asOwner(db);
    const mine = await rows(db, `
      select a.name as area, p.name as person, p.is_family_contributor as contributor, m.role
      from public.app_members m
      join public.areas a on a.id = m.area_id
      join public.people p on p.id = m.person_id
      where m.user_id = $1 and m.active order by a.name`, [f.users.jade]);

    assert.equal(mine.length, 2, "one login, two memberships");
    assert.deepEqual(mine.map((row) => row.area), ["Alpha", "Bravo"]);
    assert.notEqual(mine[0].person, mine[1].person, "A DIFFERENT PERSON IN EACH");
    assert.equal(mine[0].contributor, true, "a contributor in Alpha");
    assert.equal(mine[1].contributor, false, "and not in Bravo -- the same human, two answers");
  });

  test("renaming their Alpha person leaves their Bravo person alone", async () => {
    const bravoPersonBefore = await value(db,
      "select name from public.people where id = $1", [f.people.jem]);

    const done = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_name($1, 'Jade Alpha Only')", [f.people.jade]);
    assert.ok(done.ok, done.error);

    await asOwner(db);
    assert.equal(await value(db, "select name from public.people where id = $1", [f.people.jade]), "Jade Alpha Only");
    assert.equal(await value(db, "select name from public.people where id = $1", [f.people.jem]), bravoPersonBefore,
      "the other family's person did not move");

    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_name($1, 'Jade')", [f.people.jade]);
  });

  test("DISABLING ONE MEMBERSHIP LEAVES THE OTHER ALONE, and keeps both people", async () => {
    await asOwner(db);
    await db.query("update public.app_members set active = false where user_id = $1 and area_id = $2",
      [f.users.jade, f.areas.bravo]);

    const after = await rows(db, `
      select a.name as area, m.active, m.person_id is not null as has_person
      from public.app_members m join public.areas a on a.id = m.area_id
      where m.user_id = $1 order by a.name`, [f.users.jade]);
    assert.deepEqual(after, [
      { area: "Alpha", active: true, has_person: true },
      { area: "Bravo", active: false, has_person: true },
    ], "one off, one on, and NEITHER lost its person");

    // Both people still exist: disabling access deletes nobody.
    for (const personId of [f.people.jade, f.people.jem]) {
      assert.ok(await value(db, "select id from public.people where id = $1", [personId]));
    }

    // Reactivating restores the SAME membership row and the same person link.
    await asOwner(db);
    await db.query("update public.app_members set active = true where user_id = $1 and area_id = $2",
      [f.users.jade, f.areas.bravo]);
    const restored = await rows(db,
      "select active, person_id from public.app_members where user_id = $1 and area_id = $2",
      [f.users.jade, f.areas.bravo]);
    assert.equal(restored.length, 1, "one membership, not a duplicate");
    assert.equal(restored[0].active, true);
    assert.equal(restored[0].person_id, f.people.jem, "linked to the same person as before");
  });

  test("and no membership may ever name a person from another family", async () => {
    await asOwner(db);
    const crossed = await rows(db, `
      select count(*)::int as n from public.app_members m
      join public.people p on p.id = m.person_id
      where p.area_id <> m.area_id`);
    assert.equal(crossed[0].n, 0);

    // The guard that keeps it that way, tried for real.
    const refused = await probe(db, who(f.users.dual, f.areas.alpha), `
      insert into public.app_members (area_id, person_id, user_id, email, role, active)
      values ($1, $2, $3, 'x@example.test', 'member', true)`,
      [f.areas.alpha, f.people.jem, f.users.mo]);
    assert.equal(refused.ok, false, "an Alpha membership may not point at a Bravo person");
  });
});

// ===========================================================================
// 5. What the screens say
// ===========================================================================

describe("the screens keep the four apart in words", () => {
  const panel = read(...PANEL);

  test("each concept is its own labelled card", () => {
    for (const title of ['title="Account access"', 'title="Contributor"', 'title="Name"', 'title="Birthday"']) {
      assert.ok(panel.includes(title), `${title} must be its own thing on screen`);
    }
  });

  test("the contributor control says, in words, that it is not a login", () => {
    const code = withoutComments(panel);
    assert.match(code, /neither gives nor removes account access/u);
    assert.match(code, /does not\s*\n?\s*make anybody an admin/u);
    assert.match(code, /Account access is separate and unchanged/u);
  });

  test("archiving says it keeps everything, and deletion is never offered", () => {
    assert.match(panel, /Archiving keeps everything/u);
    assert.ok(!panel.includes("Delete person"));
    assert.ok(!panel.includes("delete_person"));
  });

  test("the admin role is described per family and changed by handover", () => {
    assert.match(panel, /Admin of this family/u);
    assert.match(panel, /handing it over/u);
    assert.ok(!panel.includes("Global Admin"));
  });

  test("THE DIRECTORY SHOWS CONTRIBUTOR AND ADMIN AS DIFFERENT TAGS", () => {
    const directory = read(...APP, "people", "people-directory-screen.tsx");
    assert.match(directory, /label: "Contributor"/u);
    assert.match(directory, /label: "Admin"/u);
    assert.match(directory, /label: "Archived"/u);
    // The admin tag comes from the MEMBERSHIP, never from the person row.
    assert.match(directory, /account\?\.isAdmin/u);
    assert.match(directory, /person\.isFamilyContributor/u);
  });

  test("and the directory's account facts come from a row level security read, not a guess", () => {
    /*
     * EVERY membership read in this loader, not "at least one somewhere in the
     * file". The first version of this test matched a single occurrence, and a
     * mutation that unscoped the DIRECTORY's read still passed because the
     * PROFILE's scoped read satisfied the pattern. One unscoped read is enough
     * to put another family's account badges on this family's list.
     */
    const loader = withoutComments(read("src", "utils", "supabase", "people-server.ts"));
    const reads = loader.split('.from("app_members")').slice(1);
    assert.ok(reads.length >= 2, "both the directory and the profile read memberships");

    for (const chunk of reads) {
      const statement = chunk.split(/;|\.from\(/u)[0];
      assert.match(statement, /\.eq\("area_id", areaId\)/u,
        `an unscoped membership read: ${statement.slice(0, 80)}`);
    }
    assert.ok(!loader.includes("SUPABASE_SECRET_KEY"), "no service-role client in a page loader");
  });
});

// ===========================================================================
// 6. Adding somebody adds a PERSON and nothing else
// ===========================================================================

describe("adding a person", () => {
  test("creates a person with no account, no eligibility and no role", async () => {
    const created = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.create_person('Fresh QA Person', null::smallint, null::smallint, null::smallint)).id as id");
    assert.ok(created.ok, created.error);
    const id = created.rows[0].id;

    await asOwner(db);
    const person = (await rows(db,
      "select area_id, is_family_contributor, archived_at from public.people where id = $1", [id]))[0];
    assert.equal(person.area_id, f.areas.alpha, "in the family that added them");
    assert.equal(person.is_family_contributor, false, "NOT a contributor");
    assert.equal(person.archived_at, null);
    assert.equal(
      await value(db, "select count(*)::int from public.app_members where person_id = $1", [id]), 0,
      "and NO login");
  });

  test("a blank name is refused", async () => {
    for (const bad of ["", "   "]) {
      const refused = await probe(db, who(f.users.dual, f.areas.alpha),
        "select public.create_person($1, null::smallint, null::smallint, null::smallint)", [bad]);
      assert.equal(refused.ok, false, `"${bad}" must be refused`);
    }
  });

  test("and the form warns about a duplicate rather than refusing one", () => {
    // Two people in one family really can share a name.
    const form = read(...APP, "people", "new", "add-person-form.tsx");
    assert.match(form, /const duplicate = existingNames\.find/u);
    assert.match(form, /is already in this family/u);
    assert.match(form, /You can still add another/u);
    // The warning must not gate the button.
    assert.doesNotMatch(form, /disabled=\{[^}]*duplicate/u, "a warning is not a refusal");
  });
});

// ===========================================================================
// 7. Sweeps -- the shapes that would quietly undo all of the above
// ===========================================================================

describe("no screen or route can quietly become Area-blind again", () => {
  /** Every product source file, tests excluded. */
  const sourceFiles = () => {
    const found = [];
    const walk = (relative) => {
      for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (/\.tsx?$/u.test(entry.name) && !/\.test\./u.test(entry.name)) found.push(child);
      }
    };
    walk("src");
    return found;
  };

  test("NO USER-FACING SCREEN SAYS 'Global Admin' ANY MORE", () => {
    /*
     * It described a power that no longer exists. Administration is per family:
     * one login can run one family and be an ordinary member of another, so
     * "Global Admin" named a role nobody holds and implied a reach nobody has.
     *
     * Comments are exempt on purpose -- they explain the history, which is
     * worth keeping -- so the sweep reads the code with them removed.
     */
    const offenders = [];
    for (const file of sourceFiles()) {
      if (withoutComments(read(file)).includes("Global Admin")) offenders.push(file);
    }
    assert.deepEqual(offenders, [], "administration is per family, and the words have to say so");
  });

  test("and the phrase really was there to remove, so this sweep proves something", () => {
    // If nothing in the repository ever said it, the sweep above is vacuous.
    // The comments still explain what it used to mean, which is the evidence.
    const explained = sourceFiles().some((file) => read(file).includes("Global Admin"));
    assert.ok(explained, "the history of the phrase should still be explained somewhere in comments");
  });

  test("every membership lookup keyed on a LOGIN is Area-scoped or explicitly resolved", () => {
    /*
     * `app_members` has one row per (login, family). A `maybeSingle()` on a
     * query keyed by `user_id` alone therefore ERRORS the moment somebody
     * belongs to two families -- and every caller reads that error as "not a
     * member", which silently strips a real administrator of everything.
     */
    const offenders = [];
    for (const file of sourceFiles()) {
      const source = withoutComments(read(file));
      for (const chunk of source.split('.from("app_members")').slice(1)) {
        const statement = chunk.split(/;|\.from\(/u)[0];
        if (!statement.includes(".maybeSingle()") && !statement.includes(".single()")) continue;
        const scoped = /\.eq\("area_id",/u.test(statement)
          || /\.eq\("id",/u.test(statement)
          || statement.includes(".limit(1)");
        if (!scoped) offenders.push(`${file}: a membership resolved to one row without an Area`);
      }
    }
    assert.deepEqual(offenders, [], "one login can hold several memberships");
  });

  test("THE SERVICE-ROLE ROUTE SCOPES EVERY PRIVILEGED READ AND WRITE BY AREA", () => {
    /*
     * The service role bypasses row level security AND migration 037's write
     * barrier, which exempts callers with no `auth.uid()`. So there is nothing
     * underneath this route to keep it inside one family: the Area has to be
     * carried from the check that authorised it and applied by hand.
     */
    const route = withoutComments(read("src/app/api/admin/family-access/route.ts"));

    for (const table of ["people", "app_members"]) {
      for (const chunk of route.split(`.from("${table}")`).slice(1)) {
        const statement = chunk.split(/;|\.from\(/u)[0];

        /*
         * AN INSERT CARRIES ITS AREA IN THE ROW, NOT IN A FILTER -- there is no
         * existing row to narrow. `linkMembership` is the only one, and the test
         * below pins that its payload sets `area_id` from the PERSON'S own Area,
         * which is the only value that cannot smuggle a membership into a
         * family the person is not in.
         */
        if (/^\.insert\(/u.test(statement.trim())) {
          assert.match(route, /area_id: person\.area_id/u,
            "an inserted membership must name the person's own Area");
          continue;
        }
        // Either binding of the SAME authorised Area: `context.areaId` is what
        // `requireFamilyAccessAdmin` returned, and `areaId` is that value
        // passed down. Anything else -- a header, a body field, a person's own
        // area read back from the client -- must not satisfy this.
        const scoped = /\.eq\("area_id", (context\.)?areaId\)/u.test(statement)
          // A write reached through `loadTarget`, which has already proved the
          // row is in this Area, addresses it by its own primary key.
          || /\.eq\("id", membership\.id\)/u.test(statement)
          || /area_id: person\.area_id/u.test(statement);
        assert.ok(scoped, `an unscoped service-role ${table} query: ${statement.slice(0, 90)}`);
      }
    }

    // And the authorization itself resolves the Area rather than trusting input.
    const guard = read("src/utils/supabase/family-access-admin.ts");
    assert.match(guard, /member\.role !== "admin"/u);
    assert.match(guard, /const areaId = \(member\.area_id as string \| null\)/u);
  });

  test("GIVING ACCESS TO AN EXISTING PERSON CREATES NO SECOND PERSON", () => {
    /*
     * The Q3 flow that must not duplicate. `linkMembership` writes a membership
     * whose `person_id` is the person the admin chose and whose `area_id` is
     * THAT PERSON'S OWN -- so migration 035's cross-Area guard agrees with it by
     * construction, and no new person is invented along the way.
     */
    const route = withoutComments(read("src/app/api/admin/family-access/route.ts"));
    const link = route.slice(route.indexOf("async function linkMembership"));

    assert.match(link, /person_id: person\.id/u, "it links the person it was given");
    assert.match(link, /area_id: person\.area_id/u, "in that person's own family");
    assert.match(link, /role: "member"/u, "and never as an admin");
    assert.ok(!link.includes('.from("people")'), "linking an account must not write to people at all");
    assert.ok(!link.includes("create_person"));

    // Nowhere in the whole route may a person be created.
    assert.ok(!route.includes('.from("people").insert'), "the access route never creates a person");
    assert.ok(!route.includes("create_person"));
  });

  test("no runtime file hard-codes a family, a person or an event", () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;
    const offenders = [];
    for (const file of sourceFiles()) {
      const source = withoutComments(read(file));
      if (uuid.test(source)) offenders.push(`${file} contains a hard-coded id`);
      if (/Our family/u.test(source)) offenders.push(`${file} names a real family`);
    }
    assert.deepEqual(offenders, []);
  });
});
