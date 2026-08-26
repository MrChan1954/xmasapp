/**
 * THE WHOLE LIFE OF A FAMILY, RUN RATHER THAN READ.
 *
 * Creating one, joining one, being invited to a second, changing who runs it,
 * standing down, leaving, being let back in, and putting the whole thing away.
 * Every assertion here is somebody trying something against a real PostgreSQL 18
 * with all forty-three migrations applied, through the same shape a browser
 * request has: one transaction, a role, JWT claims, and the pre-request hook.
 *
 * WHAT Q2 ADDED, AND WHY EACH PIECE EXISTS
 *   041  An Area's administrator could never be changed -- in any order, by any
 *        route. A lost admin account meant a family nobody could run, for good.
 *   042  Nobody could leave a family. The only way out was to ask the
 *        administrator to disable you, which is a different thing said by a
 *        different person. And one stale invitation could stop somebody joining
 *        an unrelated household.
 *   043  Because of 041, the administrator's own birthday could not be planned
 *        by anybody: they are refused because it is theirs, everybody else
 *        because they are not the administrator.
 *
 * See `scripts/pg/fixtures.mjs` for who everybody is. Alpha's administrator is
 * Ada (the `dual` login, who also runs Charlie and is an ordinary member of
 * Bravo); Jade is Alpha's contributor and is also Jem in Bravo.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe, before, after, beforeEach } from "node:test";

import {
  asOwner, attempt, buildRehearsal, probe, rows, seen, value,
} from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

let db;
let f;

const who = (user, area) => ({ user, area });

/** Put Alpha back the way the fixture built it, whatever a test did to it. */
async function restoreAlpha() {
  await asOwner(db);
  const admin = await value(db,
    "select id from public.app_members where area_id = $1 and role = 'admin' and active", [f.areas.alpha]);
  if (admin !== f.members.adaAlpha) {
    // Hand it back through the routine, so the restore obeys the same rules.
    const holder = await value(db, "select user_id from public.app_members where id = $1", [admin]);
    await probe(db, who(holder, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.adaAlpha]);
  }
  await asOwner(db);
  await db.query("update public.app_members set active = true where area_id = $1", [f.areas.alpha]);
}

before(async () => {
  db = await buildRehearsal({});
  f = await buildTwoFamilies(db);
});
after(async () => { await db?.close(); });

// ===========================================================================
// 1. Handing a family over
// ===========================================================================

describe("handing over a family", () => {
  beforeEach(async () => { await restoreAlpha(); });

  test("this family's administrator can, to one of its active members", async () => {
    const done = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.jadeAlpha]);
    assert.equal(done.ok, true, done.error);

    await asOwner(db);
    const roles = await rows(db, `
      select p.name, m.role from public.app_members m
      join public.people p on p.id = m.person_id
      where m.area_id = $1 order by p.name`, [f.areas.alpha]);
    assert.deepEqual(
      roles.filter((row) => row.role === "admin").map((row) => row.name), ["Jade"]);
    // AND THE OUTGOING ADMINISTRATOR IS STILL A MEMBER. Handing over is not
    // leaving: the person, their place and their history are untouched.
    assert.ok(roles.some((row) => row.name === "Ada" && row.role === "member"));
  });

  test("an ordinary member cannot", async () => {
    const result = await probe(db, who(f.users.mo, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.moAlpha]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
  });

  test("nor can somebody who administers a DIFFERENT family", async () => {
    // `dual` really does administer Alpha and Charlie. Neither buys anything in
    // Bravo, where the same login is an ordinary member.
    const result = await probe(db, who(f.users.dual, f.areas.bravo),
      "select public.transfer_area_admin($1, $2)", [f.areas.bravo, f.members.joBravo]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
  });

  test("and claiming a different Area in the header changes nothing", async () => {
    // The routine reads the membership table, not the acting Area.
    const claimingBravo = await probe(db, who(f.users.dual, f.areas.bravo),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.jadeAlpha]);
    assert.equal(claimingBravo.ok, true, "administering Alpha is what counts, not what was claimed");
    await restoreAlpha();

    const claimingAlpha = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.bravo, f.members.joBravo]);
    assert.equal(claimingAlpha.ok, false, "and claiming Alpha does not help in Bravo");
  });

  test("a successor from ANOTHER family is refused", async () => {
    const result = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.samBravo]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
  });

  test("an INACTIVE successor is refused", async () => {
    await asOwner(db);
    await db.query("update public.app_members set active = false where id = $1", [f.members.moAlpha]);
    const result = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.moAlpha]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
  });

  test("a successor with NO PERSON is refused", async () => {
    // A membership with nobody behind it is an account that cannot act, and an
    // Area run by one is an Area with no identifiable administrator.
    await asOwner(db);
    const orphan = await attempt(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, null, 'orphan@example.test', 'member', true) returning id`, [f.areas.alpha]);

    if (orphan.ok) {
      const result = await probe(db, who(f.users.dual, f.areas.alpha),
        "select public.transfer_area_admin($1, $2)", [f.areas.alpha, orphan.rows[0].id]);
      assert.equal(result.ok, false);
      assert.equal(result.code, "42501");
      await asOwner(db);
      await db.query("delete from public.app_members where id = $1", [orphan.rows[0].id]);
    } else {
      // Migration 033 refuses an active membership with no person outright,
      // which is the same protection arriving earlier.
      assert.match(orphan.error, /family member|person/iu);
    }
  });

  test("and handing it to yourself is refused rather than quietly doing nothing", async () => {
    const result = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.adaAlpha]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "23505");
  });

  test("an unknown membership id is refused exactly like a foreign one", async () => {
    const unknown = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)",
      [f.areas.alpha, "00000000-0000-4000-8000-000000000000"]);
    const foreign = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.samBravo]);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, foreign.error, "the two must be indistinguishable");
  });

  test("a signed-out caller cannot reach it at all", async () => {
    const result = await probe(db, { user: null },
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.jadeAlpha]);
    assert.equal(result.ok, false);
  });

  test("THE SWAP IS ALL-OR-NOTHING: a failure part-way leaves the family as it was", async () => {
    /*
     * The two role writes and the audit entry are one transaction. Breaking the
     * audit insert -- the last thing the routine does -- is the sharpest way to
     * ask whether the earlier writes would survive on their own.
     */
    await asOwner(db);
    await db.exec(`
      alter table public.audit_log drop constraint if exists audit_log_action_check;
      alter table public.audit_log add constraint audit_log_action_check
        check (action in ('added', 'removed', 'restored')) not valid;`);

    const attempted = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.jadeAlpha]);
    assert.equal(attempted.ok, false, "the audit entry must be part of the same transaction");

    await asOwner(db);
    const stillAdmin = await value(db,
      "select id from public.app_members where area_id = $1 and role = 'admin' and active", [f.areas.alpha]);
    assert.equal(stillAdmin, f.members.adaAlpha, "neither half of the swap may survive");

    // Put the vocabulary back.
    await db.exec(`
      alter table public.audit_log drop constraint if exists audit_log_action_check;
      alter table public.audit_log add constraint audit_log_action_check
        check (action in ('added', 'removed', 'restored', 'handover'));`);
  });

  test("a second handover from the old administrator is refused, not queued", async () => {
    // The nearest thing to two callers at once that one connection can show:
    // once the first has committed, the second finds it is nobody.
    const first = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.jadeAlpha]);
    assert.equal(first.ok, true, first.error);

    const second = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.moAlpha]);
    assert.equal(second.ok, false);
    assert.equal(second.code, "42501");
  });

  test("and it is written down, because nothing else records a role change", async () => {
    await asOwner(db);
    const before_ = Number(await value(db, "select count(*) from public.audit_log where action = 'handover'"));

    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.jadeAlpha]);

    await asOwner(db);
    const entry = (await rows(db, `
      select action, table_name, subject, area_id from public.audit_log
      where action = 'handover' order by occurred_at desc limit 1`))[0];
    assert.equal(Number(await value(db, "select count(*) from public.audit_log where action = 'handover'")), before_ + 1);
    assert.equal(entry.table_name, "app_members");
    assert.equal(entry.subject, "Jade");
    assert.equal(entry.area_id, f.areas.alpha, "and it belongs to the family it happened in");
  });

  test("the audit entry is invisible to another family", async () => {
    assert.equal(
      await seen(db, who(f.users.sam, f.areas.bravo), "audit_log", "action = 'handover'"), 0);
  });
});

// ===========================================================================
// 2. Leaving a family
// ===========================================================================

describe("leaving a family", () => {
  beforeEach(async () => { await restoreAlpha(); });

  test("an ordinary member may, and it deactivates rather than deletes", async () => {
    const left = await probe(db, who(f.users.mo, f.areas.alpha),
      "select public.leave_area($1)", [f.areas.alpha]);
    assert.equal(left.ok, true, left.error);

    await asOwner(db);
    const row = (await rows(db,
      "select active, role, person_id from public.app_members where id = $1", [f.members.moAlpha]))[0];
    assert.equal(row.active, false);
    assert.equal(row.person_id, f.people.mo, "the person link survives, so letting them back in is not a new membership");
    assert.equal(Number(await value(db, "select count(*) from public.people where id = $1", [f.people.mo])), 1);
  });

  test("and afterwards they can read nothing of that family", async () => {
    await probe(db, who(f.users.mo, f.areas.alpha), "select public.leave_area($1)", [f.areas.alpha]);
    assert.equal(await seen(db, who(f.users.mo, f.areas.alpha), "people", "area_id = $1", [f.areas.alpha]), 0);
    assert.equal(await seen(db, who(f.users.mo, f.areas.alpha), "areas", "id = $1", [f.areas.alpha]), 0);
  });

  test("THE ADMINISTRATOR MAY NOT, and is told what to do instead", async () => {
    const result = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.leave_area($1)", [f.areas.alpha]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
    assert.match(result.error, /[Hh]and this family over/u);
  });

  test("but after handing over, they may", async () => {
    const handed = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.jadeAlpha]);
    assert.equal(handed.ok, true, handed.error);

    const left = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.leave_area($1)", [f.areas.alpha]);
    assert.equal(left.ok, true, left.error);
  });

  test("LEAVING ONE FAMILY TOUCHES NO OTHER", async () => {
    // `dual` is Ada in Alpha, Jo in Bravo and Cass in Charlie.
    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.jadeAlpha]);
    await probe(db, who(f.users.dual, f.areas.alpha), "select public.leave_area($1)", [f.areas.alpha]);

    await asOwner(db);
    const memberships = await rows(db, `
      select a.name, m.role, m.active from public.app_members m
      join public.areas a on a.id = m.area_id
      where m.user_id = $1 order by a.name`, [f.users.dual]);
    assert.deepEqual(memberships, [
      { name: "Alpha", role: "member", active: false },
      { name: "Bravo", role: "member", active: true },
      { name: "Charlie", role: "admin", active: true },
    ]);

    // And they still work in the families they are still in.
    assert.ok(await seen(db, who(f.users.dual, f.areas.bravo), "people", "area_id = $1", [f.areas.bravo]) > 0);
    assert.equal(
      (await probe(db, who(f.users.dual, f.areas.charlie), "select public.is_app_admin()")).rows[0].is_app_admin,
      true, "still runs Charlie");
  });

  test("you cannot leave a family you were never in", async () => {
    const result = await probe(db, who(f.users.mo, f.areas.alpha),
      "select public.leave_area($1)", [f.areas.bravo]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
  });

  test("or one that does not exist, and the two look the same", async () => {
    const nowhere = await probe(db, who(f.users.mo, f.areas.alpha),
      "select public.leave_area($1)", ["00000000-0000-4000-8000-000000000000"]);
    const elsewhere = await probe(db, who(f.users.mo, f.areas.alpha),
      "select public.leave_area($1)", [f.areas.bravo]);
    assert.equal(nowhere.ok, false);
    assert.equal(nowhere.error, elsewhere.error);
  });

  test("leaving twice is refused the second time", async () => {
    assert.equal((await probe(db, who(f.users.mo, f.areas.alpha), "select public.leave_area($1)", [f.areas.alpha])).ok, true);
    assert.equal((await probe(db, who(f.users.mo, f.areas.alpha), "select public.leave_area($1)", [f.areas.alpha])).ok, false);
  });

  test("and being let back in restores the same membership, not a second one", async () => {
    await probe(db, who(f.users.mo, f.areas.alpha), "select public.leave_area($1)", [f.areas.alpha]);

    // What the Family Access route does: reactivate the row that is already
    // there, found by person and Area.
    await asOwner(db);
    await db.query(`
      update public.app_members set active = true, updated_at = now()
      where area_id = $1 and person_id = $2`, [f.areas.alpha, f.people.mo]);

    const rowsBack = await rows(db,
      "select id, active from public.app_members where area_id = $1 and person_id = $2",
      [f.areas.alpha, f.people.mo]);
    assert.equal(rowsBack.length, 1, "one membership, reactivated");
    assert.equal(rowsBack[0].id, f.members.moAlpha, "the same one");
    assert.ok(await seen(db, who(f.users.mo, f.areas.alpha), "people", "area_id = $1", [f.areas.alpha]) > 0);
  });
});

// ===========================================================================
// 3. Deactivation is per family
// ===========================================================================

describe("being switched off in one family says nothing about another", () => {
  beforeEach(async () => { await restoreAlpha(); });

  test("deactivated in Bravo, still fully working in Alpha", async () => {
    // `jade` is Jade in Alpha (a contributor) and Jem in Bravo.
    await asOwner(db);
    await db.query("update public.app_members set active = false where id = $1", [f.members.jemBravo]);

    assert.equal(await seen(db, who(f.users.jade, f.areas.bravo), "people", "area_id = $1", [f.areas.bravo]), 0);
    assert.ok(await seen(db, who(f.users.jade, f.areas.alpha), "people", "area_id = $1", [f.areas.alpha]) > 0);
    assert.equal(
      (await probe(db, who(f.users.jade, f.areas.alpha), "select public.is_area_contributor_member($1)", [f.areas.alpha]))
        .rows[0].is_area_contributor_member, true, "still a contributor where they are still active");

    await asOwner(db);
    await db.query("update public.app_members set active = true where id = $1", [f.members.jemBravo]);
  });

  test("and a deactivated membership can do nothing in the family it was in", async () => {
    await asOwner(db);
    await db.query("update public.app_members set active = false where id = $1", [f.members.jemBravo]);

    for (const [what, sql, params] of [
      ["claim the Area", "select public.acting_area()", []],
      ["leave it", "select public.leave_area($1)", [f.areas.bravo]],
    ]) {
      const result = await probe(db, who(f.users.jade, f.areas.bravo), sql, params.length ? params : undefined);
      if (what === "claim the Area") {
        assert.equal(result.rows[0].acting_area, null, "a deactivated membership claims nothing");
      } else {
        assert.equal(result.ok, false, `a deactivated membership must not ${what}`);
      }
    }

    await asOwner(db);
    await db.query("update public.app_members set active = true where id = $1", [f.members.jemBravo]);
  });
});

// ===========================================================================
// 4. Creating a family
// ===========================================================================

describe("creating a family gives you an empty one", () => {
  test("a signed-out visitor cannot create one", async () => {
    const result = await probe(db, { user: null }, "select public.create_area($1, $2)", ["Nope", "Nobody"]);
    assert.equal(result.ok, false);
  });

  test("somebody already in three families can create a fourth", async () => {
    const created = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.create_area($1, $2) as id", ["Delta", "Dee"]);
    assert.equal(created.ok, true, created.error);
    const delta = created.rows[0].id;

    await asOwner(db);
    const membership = (await rows(db, `
      select m.role, m.active, p.name from public.app_members m
      join public.people p on p.id = m.person_id
      where m.area_id = $1`, [delta]))[0];
    assert.deepEqual(membership, { role: "admin", active: true, name: "Dee" });
  });

  test("AND IT IS EMPTY -- nothing is copied from the family they were in", async () => {
    const created = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.create_area($1, $2) as id", ["Echo", "Eve"]);
    assert.equal(created.ok, true, created.error);
    const echo = created.rows[0].id;

    await asOwner(db);
    // One person -- the founder -- and nothing else at all.
    assert.equal(Number(await value(db, "select count(*) from public.people where area_id = $1", [echo])), 1);
    assert.equal(Number(await value(db, "select count(*) from public.events where area_id = $1", [echo])), 0);
    for (const [table, join] of [
      ["christmas_recipients", "join public.events e on e.id = t.christmas_event_id where e.area_id = $1"],
      ["contributors", "join public.events e on e.id = t.christmas_event_id where e.area_id = $1"],
      ["settlements", "join public.events e on e.id = t.christmas_event_id where e.area_id = $1"],
    ]) {
      assert.equal(
        Number(await value(db, `select count(*) from public.${table} t ${join}`, [echo])), 0,
        `${table} must be empty in a new family`);
    }
    assert.equal(
      Number(await value(db, "select count(*) from public.birthday_wishlist_ideas where area_id = $1", [echo])), 0);
  });

  test("the founder is a NEW person, not the one they are elsewhere", async () => {
    const created = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.create_area($1, $2) as id", ["Foxtrot", "Ada"]);
    assert.equal(created.ok, true, created.error);

    await asOwner(db);
    const person = await value(db,
      "select person_id from public.app_members where area_id = $1", [created.rows[0].id]);
    assert.notEqual(person, f.people.ada, "same name, different family, different person row");
  });

  test("two families may share a name -- they are different households", async () => {
    const first = await probe(db, who(f.users.mo, f.areas.alpha),
      "select public.create_area($1, $2) as id", ["The Wards", "Mo"]);
    const second = await probe(db, who(f.users.sam, f.areas.bravo),
      "select public.create_area($1, $2) as id", ["The Wards", "Sam"]);
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    assert.notEqual(first.rows[0].id, second.rows[0].id);
  });

  test("but a blank or control-character name is refused", async () => {
    for (const name of ["", "   ", "ab"]) {
      const result = await probe(db, who(f.users.mo, f.areas.alpha),
        "select public.create_area($1, $2)", [name, "Somebody"]);
      assert.equal(result.ok, false, `"${name}" must be refused`);
    }
  });

  test("and so is a founder with no name", async () => {
    const result = await probe(db, who(f.users.mo, f.areas.alpha),
      "select public.create_area($1, $2)", ["Golf", "  "]);
    assert.equal(result.ok, false);
  });

  test("creating one does not disturb the family they were in", async () => {
    await asOwner(db);
    const before_ = await value(db, "select count(*) from public.people where area_id = $1", [f.areas.alpha]);
    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.create_area($1, $2)", ["Hotel", "Hattie"]);
    await asOwner(db);
    assert.equal(await value(db, "select count(*) from public.people where area_id = $1", [f.areas.alpha]), before_);
  });
});

// ===========================================================================
// 5. Invitations, and one login in several families
// ===========================================================================

describe("being invited to a second family", () => {
  test("an existing account gets a NEW membership, and keeps the old one", async () => {
    // The Family Access shape: the service role writes a membership naming the
    // Area, for a person that already exists there.
    await asOwner(db);
    const before_ = await rows(db,
      "select area_id, role from public.app_members where user_id = $1 order by area_id", [f.users.mo]);

    const person = await value(db, `
      insert into public.people (area_id, name) values ($1, 'Mo (in Bravo)') returning id`, [f.areas.bravo]);
    const added = await attempt(db, `
      insert into public.app_members (area_id, person_id, user_id, email, role, active)
      values ($1, $2, $3, 'mo-bravo@example.test', 'member', true) returning id`,
    [f.areas.bravo, person, f.users.mo]);
    assert.equal(added.ok, true, added.error);

    const after_ = await rows(db,
      "select area_id, role from public.app_members where user_id = $1 order by area_id", [f.users.mo]);
    assert.equal(after_.length, before_.length + 1, "a second membership, not a replacement");

    // ONE AUTH IDENTITY. The same login now belongs to two families.
    assert.equal(Number(await value(db,
      "select count(*) from auth.users where id = $1", [f.users.mo])), 1);
  });

  test("and the two are independent: a different person, and a role of their own", async () => {
    await asOwner(db);
    const both = await rows(db, `
      select a.name as area, p.name as person, m.role from public.app_members m
      join public.areas a on a.id = m.area_id
      join public.people p on p.id = m.person_id
      where m.user_id = $1 order by a.name`, [f.users.mo]);
    assert.ok(both.length >= 2);
    assert.notEqual(both[0].person, both[1].person, "a different person row in each family");
  });

  test("a membership may NEVER name a person from another family", async () => {
    await asOwner(db);
    const result = await attempt(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'cross@example.test', 'member', true)`, [f.areas.bravo, f.people.taylor]);
    assert.equal(result.ok, false);
    assert.match(result.error, /different Area/u);
  });

  test("nor may an existing membership be moved onto one", async () => {
    await asOwner(db);
    const result = await attempt(db,
      "update public.app_members set person_id = $1 where id = $2", [f.people.sam, f.members.moAlpha]);
    assert.equal(result.ok, false);
  });

  test("the same email may be used in two families, because they are two families", async () => {
    await asOwner(db);
    const personA = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Shared A') returning id", [f.areas.alpha]);
    const personB = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Shared B') returning id", [f.areas.bravo]);

    const first = await attempt(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'shared@example.test', 'member', true)`, [f.areas.alpha, personA]);
    const second = await attempt(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'shared@example.test', 'member', true)`, [f.areas.bravo, personB]);

    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
  });

  test("but not twice inside one family", async () => {
    await asOwner(db);
    const person = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Shared C') returning id", [f.areas.alpha]);
    const again = await attempt(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'shared@example.test', 'member', true)`, [f.areas.alpha, person]);
    assert.equal(again.ok, false);
    assert.equal(again.code, "23505");
  });
});

describe("claiming an invitation", () => {
  let newcomer;
  let pendingAlpha;

  before(async () => {
    await asOwner(db);
    newcomer = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('newcomer@example.test', now()) returning id`);
    const person = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Newcomer') returning id", [f.areas.alpha]);
    pendingAlpha = await value(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'newcomer@example.test', 'member', true) returning id`, [f.areas.alpha, person]);
  });

  test("an account with no membership claims the invitation addressed to it", async () => {
    const claimed = await probe(db, { user: newcomer }, "select public.claim_app_member() as got");
    assert.equal(claimed.rows[0].got, true);

    await asOwner(db);
    assert.equal(await value(db, "select user_id from public.app_members where id = $1", [pendingAlpha]), newcomer);
  });

  test("and it claims a MEMBER role, never an administrator one", async () => {
    await asOwner(db);
    assert.equal(await value(db, "select role from public.app_members where id = $1", [pendingAlpha]), "member");
    // Alpha's administrator is unchanged by somebody joining it.
    assert.equal(Number(await value(db,
      "select count(*) from public.app_members where area_id = $1 and role = 'admin' and active",
      [f.areas.alpha])), 1);
  });

  test("claiming again finds nothing left to claim", async () => {
    const again = await probe(db, { user: newcomer }, "select public.claim_app_member() as got");
    assert.equal(again.rows[0].got, false);
  });

  test("ONE STALE INVITATION CANNOT BLOCK A GENUINE ONE IN ANOTHER FAMILY", async () => {
    /*
     * THE BUG MIGRATION 042 CLOSES, built the only way it can actually happen.
     *
     * A login already in Alpha under one address changes their email, and
     * somebody in Alpha invites the NEW address without noticing they are
     * already there. That pending row and their existing row are two different
     * rows in one Area -- legal, because the unique rule is on the EMAIL, and
     * the two emails differ.
     *
     * The old claim tried to set `user_id` on every matching pending row in one
     * statement. The Alpha one would have violated 035's one-login-per-Area
     * index, and the whole statement would have been refused -- taking Bravo's
     * perfectly good invitation down with it. Somebody would have been unable to
     * join an unrelated household because of a stale invite in a different one.
     */
    await asOwner(db);
    const login = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('moved-house@example.test', now()) returning id`);

    // Already in Alpha, under the address they signed up with long ago.
    const oldPerson = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Moved house') returning id", [f.areas.alpha]);
    await db.query(`
      insert into public.app_members (area_id, person_id, user_id, email, role, active)
      values ($1, $2, $3, 'old-address@example.test', 'member', true)`,
    [f.areas.alpha, oldPerson, login]);

    // Invited to Alpha AGAIN, at the new address. Nobody noticed.
    const stalePerson = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Moved house (again)') returning id", [f.areas.alpha]);
    const stale = await value(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'moved-house@example.test', 'member', true) returning id`,
    [f.areas.alpha, stalePerson]);

    // And genuinely invited to Bravo, which has nothing to do with any of it.
    const bravoPerson = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Moved house in Bravo') returning id", [f.areas.bravo]);
    const genuine = await value(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'moved-house@example.test', 'member', true) returning id`,
    [f.areas.bravo, bravoPerson]);

    const claimed = await probe(db, { user: login }, "select public.claim_app_member() as got");
    assert.equal(claimed.ok, true, "the duplicate must not abort the whole claim");
    assert.equal(claimed.rows[0].got, true);

    await asOwner(db);
    assert.equal(await value(db, "select user_id from public.app_members where id = $1", [genuine]), login,
      "the genuine invitation in the other family was claimed");
    assert.equal(await value(db, "select user_id from public.app_members where id = $1", [stale]), null,
      "and the duplicate in the family they were already in was left alone");
  });

  test("an inactive invitation is not claimable", async () => {
    await asOwner(db);
    const person = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Disabled invite') returning id", [f.areas.charlie]);
    const disabled = await value(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'newcomer@example.test', 'member', false) returning id`, [f.areas.charlie, person]);

    await probe(db, { user: newcomer }, "select public.claim_app_member()");
    await asOwner(db);
    assert.equal(await value(db, "select user_id from public.app_members where id = $1", [disabled]), null);
  });

  test("and somebody else's invitation is not claimable at all", async () => {
    await asOwner(db);
    const stranger = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('stranger@example.test', now()) returning id`);
    const person = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Not for the stranger') returning id", [f.areas.charlie]);
    const notTheirs = await value(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'somebody-else@example.test', 'member', true) returning id`, [f.areas.charlie, person]);

    const claimed = await probe(db, { user: stranger }, "select public.claim_app_member() as got");
    assert.equal(claimed.rows[0].got, false);
    await asOwner(db);
    assert.equal(await value(db, "select user_id from public.app_members where id = $1", [notTheirs]), null);
  });
});

// ===========================================================================
// 6. Archiving
// ===========================================================================

describe("putting a family away", () => {
  beforeEach(async () => { await restoreAlpha(); });

  test("its administrator may, and nothing is deleted", async () => {
    await asOwner(db);
    const before_ = await value(db, "select count(*) from public.people where area_id = $1", [f.areas.alpha]);

    const archived = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_area_archived($1, true)", [f.areas.alpha]);
    assert.equal(archived.ok, true, archived.error);

    await asOwner(db);
    assert.notEqual(await value(db, "select archived_at from public.areas where id = $1", [f.areas.alpha]), null);
    assert.equal(await value(db, "select count(*) from public.people where area_id = $1", [f.areas.alpha]), before_,
      "archiving is a date, not a delete");

    await probe(db, who(f.users.dual, f.areas.alpha), "select public.set_area_archived($1, false)", [f.areas.alpha]);
  });

  test("an ordinary member may not", async () => {
    const result = await probe(db, who(f.users.mo, f.areas.alpha),
      "select public.set_area_archived($1, true)", [f.areas.alpha]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
  });

  test("and neither may somebody who runs a different family", async () => {
    const result = await probe(db, who(f.users.bravoadmin, f.areas.bravo),
      "select public.set_area_archived($1, true)", [f.areas.alpha]);
    assert.equal(result.ok, false);
  });

  test("an archived family is still readable by its own members and by nobody else", async () => {
    await probe(db, who(f.users.dual, f.areas.alpha), "select public.set_area_archived($1, true)", [f.areas.alpha]);
    assert.equal(await seen(db, who(f.users.dual, f.areas.alpha), "areas", "id = $1", [f.areas.alpha]), 1);
    assert.equal(await seen(db, who(f.users.sam, f.areas.bravo), "areas", "id = $1", [f.areas.alpha]), 0);
    await probe(db, who(f.users.dual, f.areas.alpha), "select public.set_area_archived($1, false)", [f.areas.alpha]);
  });

  test("there is no way to delete a family at all, which is the point", async () => {
    await asOwner(db);

    // Nothing in the database deletes one.
    const deleters = await rows(db, `
      select proname from pg_proc
      where pronamespace = 'public'::regnamespace and prosrc ilike '%delete from public.areas%'`);
    assert.deepEqual(deleters, []);

    /*
     * AND NO BROWSER CAN. The lock is the absence of a write POLICY, not the
     * absence of a grant: Supabase grants ALL on every new public table by
     * default and migration 034 revoked that from `anon` without taking the
     * rest back from `authenticated`. Row level security refuses it anyway --
     * which is what this proves, by trying.
     */
    assert.deepEqual(
      (await rows(db, "select cmd from pg_policies where tablename = 'areas'")).map((row) => row.cmd),
      ["SELECT"]);

    const tried = await probe(db, who(f.users.dual, f.areas.alpha),
      "delete from public.areas where id = $1 returning id", [f.areas.alpha]);
    assert.equal(tried.count, 0, "no row is visible to delete");
    assert.equal(Number(await value(db, "select count(*) from public.areas where id = $1", [f.areas.alpha])), 1);
  });
});

// ===========================================================================
// 7. auth.users -> membership -> person, for every shape a login can have
// ===========================================================================

describe("the mapping from a login to who they are, in each family", () => {
  // Earlier sections deliberately hand Alpha over and walk out of it. This puts
  // the family back so the mapping is read from the shape the fixture built.
  beforeEach(async () => { await restoreAlpha(); });

  test("one login, three families, three people, three roles", async () => {
    await asOwner(db);
    const mapping = await rows(db, `
      select a.name as area, p.name as person, m.role, m.active
      from public.app_members m
      join public.areas a on a.id = m.area_id
      join public.people p on p.id = m.person_id
      where m.user_id = $1 and m.area_id = any($2::uuid[]) order by a.name`,
    [f.users.dual, [f.areas.alpha, f.areas.bravo, f.areas.charlie]]);

    // The three the fixture built. This login has also founded others in the
    // create-a-family section above, which is itself the point: one account,
    // as many households as it likes.
    assert.deepEqual(mapping, [
      { area: "Alpha", person: "Ada", role: "admin", active: true },
      { area: "Bravo", person: "Jo", role: "member", active: true },
      { area: "Charlie", person: "Cass", role: "admin", active: true },
    ]);
  });

  test("and the database answers about whichever one is on screen", async () => {
    for (const [area, expected] of [
      [f.areas.alpha, f.people.ada],
      [f.areas.bravo, f.people.jo],
      [f.areas.charlie, f.people.cass],
    ]) {
      const person = await probe(db, who(f.users.dual, area), "select public.current_person_id() as p");
      assert.equal(person.rows[0].p, expected);
    }
  });

  test("NO MEMBERSHIP ANYWHERE POINTS AT A PERSON IN ANOTHER FAMILY", async () => {
    await asOwner(db);
    const crossed = await value(db, `
      select count(*) from public.app_members m
      join public.people p on p.id = m.person_id
      where p.area_id is distinct from m.area_id`);
    assert.equal(Number(crossed), 0);
  });

  test("and no login holds two memberships in one family", async () => {
    await asOwner(db);
    const doubled = await rows(db, `
      select area_id, user_id from public.app_members
      where user_id is not null group by area_id, user_id having count(*) > 1`);
    assert.deepEqual(doubled, []);
  });
});

// ===========================================================================
// 8. The exemption that lets somebody become a member, and nothing more
// ===========================================================================

describe("becoming a member is the one write the barrier lets a stranger make", () => {
  let outsider;
  let invitation;

  before(async () => {
    await asOwner(db);
    outsider = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('outsider@example.test', now()) returning id`);
    const person = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Outsider') returning id", [f.areas.charlie]);
    invitation = await value(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'outsider@example.test', 'member', true) returning id`, [f.areas.charlie, person]);
  });

  test("a stranger cannot write anything else in that family first", async () => {
    const write = await probe(db, who(outsider, f.areas.charlie),
      "update public.people set name = 'hacked' where area_id = $1 returning id", [f.areas.charlie]);
    assert.ok(!write.ok || write.count === 0, "row level security and the barrier both refuse them");
  });

  test("they cannot claim a row addressed to somebody else", async () => {
    await asOwner(db);
    const person = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Somebody else') returning id", [f.areas.charlie]);
    const notTheirs = await value(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'not-the-outsider@example.test', 'member', true) returning id`, [f.areas.charlie, person]);

    const grab = await probe(db, who(outsider, f.areas.charlie),
      "update public.app_members set user_id = $1 where id = $2 returning id", [outsider, notTheirs]);
    assert.ok(!grab.ok || grab.count === 0, "the exemption is only for a row addressed to their own email");
  });

  test("nor move an invitation into a different family while claiming it", async () => {
    const moved = await probe(db, who(outsider, f.areas.charlie),
      "update public.app_members set user_id = $1, area_id = $2 where id = $3 returning id",
      [outsider, f.areas.alpha, invitation]);
    assert.ok(!moved.ok || moved.count === 0, "the Area may not change on the way through");
  });

  test("but the routine written for it works", async () => {
    const claimed = await probe(db, { user: outsider }, "select public.claim_app_member() as got");
    assert.equal(claimed.ok, true, claimed.error);
    assert.equal(claimed.rows[0].got, true);

    await asOwner(db);
    assert.equal(await value(db, "select user_id from public.app_members where id = $1", [invitation]), outsider);
  });

  test("and once claimed, the same trick cannot be played again", async () => {
    await asOwner(db);
    const person = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Second bite') returning id", [f.areas.alpha]);
    const other = await value(db, `
      insert into public.app_members (area_id, person_id, email, role, active)
      values ($1, $2, 'someone@example.test', 'member', true) returning id`, [f.areas.alpha, person]);

    const grab = await probe(db, who(outsider, f.areas.charlie),
      "update public.app_members set user_id = $1 where id = $2 returning id", [outsider, other]);
    assert.ok(!grab.ok || grab.count === 0);
  });

  test("claiming gave them a family, and only the one they were invited to", async () => {
    assert.equal(await seen(db, who(outsider, f.areas.charlie), "areas", "id = $1", [f.areas.charlie]), 1);
    assert.equal(await seen(db, who(outsider, f.areas.charlie), "areas", "id = $1", [f.areas.alpha]), 0);
    assert.equal(await seen(db, who(outsider, f.areas.charlie), "people", "area_id = $1", [f.areas.alpha]), 0);
  });
});

// ===========================================================================
// 10. Switching between families
//
// WHAT SWITCHING IS, EXACTLY. A cookie becomes a header, the header becomes an
// acting Area for the length of one transaction, and the acting Area decides
// WHO THE CALLER IS -- their person, their membership, their role -- and where
// anything they write lands.
//
// WHAT IT IS NOT is a filter on what may be read. Row level security admits
// every family the reader actually belongs to, because they do belong to them;
// narrowing that would be a lie about permission and would break the moment a
// screen needed to name a second family. The SCREEN shows one family, by asking
// for one family. The DATABASE refuses the families that are not theirs.
// ===========================================================================

describe("switching family changes who you are, and carries nothing over", () => {
  beforeEach(async () => { await restoreAlpha(); });

  const identity = async (user, area) => {
    const result = await probe(db, who(user, area), `
      select public.acting_area() as acting,
             public.current_person_id() as person,
             public.current_app_member_id() as member,
             public.is_area_admin($1) as admin`, [area]);
    assert.ok(result.ok, result.error);
    return result.rows[0];
  };

  test("Alpha, then Bravo, then Alpha again -- and Alpha is exactly as it was", async () => {
    // The same login, three consecutive requests, exactly as a browser makes
    // them after somebody picks a different family from the switcher.
    const first = await identity(f.users.dual, f.areas.alpha);
    const second = await identity(f.users.dual, f.areas.bravo);
    const third = await identity(f.users.dual, f.areas.alpha);

    assert.deepEqual(third, first, "going back is going back, not somewhere new");
    assert.equal(first.person, f.people.ada);
    assert.equal(second.person, f.people.jo, "in Bravo this login is Jo, not Ada");
    assert.equal(first.admin, true, "Ada runs Alpha");
    assert.equal(second.admin, false, "and is an ordinary member of Bravo");
  });

  test("AND NOTHING FROM BRAVO SURVIVES INTO THE NEXT REQUEST", async () => {
    // The acting Area is set with `is_local => true`, so it dies with the
    // transaction that claimed it. A request that says nothing afterwards is
    // therefore acting for nobody -- not still acting for Bravo. Nothing has to
    // be cleared, because nothing was kept.
    await probe(db, who(f.users.dual, f.areas.bravo), "select public.current_person_id()");

    const after = await probe(db, { user: f.users.dual }, `
      select public.acting_area() as acting, public.current_person_id() as person`);
    assert.equal(after.rows[0].acting, null, "the previous request's family must not linger");
    assert.equal(after.rows[0].person, null,
      "and a login in several families that says nothing is nobody in particular");
  });

  test("what they write lands in the family that was on screen when they wrote it", async () => {
    // Through the routine the app uses, because a person is created by
    // `create_person`, and not by a bare insert.
    const created = await probe(db, who(f.users.dual, f.areas.charlie),
      "select id, area_id from public.create_person('Switched', null, null, null)");
    assert.ok(created.ok, created.error);
    assert.equal(created.rows[0].area_id, f.areas.charlie,
      "the Area is derived from the request, never sent by the browser");

    // And it is in Charlie only -- not visible on Alpha's screen, which asks
    // for Alpha.
    assert.equal(await seen(db, who(f.users.dual, f.areas.alpha),
      "people", "area_id = $1 and name = 'Switched'", [f.areas.alpha]), 0);

    await asOwner(db);
    await db.query("delete from public.people where id = $1", [created.rows[0].id]);
  });

  test("a cookie naming a family they are NOT in selects nothing, and reveals nothing", async () => {
    // `jade` is in Alpha and Bravo and has never been in Charlie. A forged
    // cookie becomes a forged header, and the hook does not believe it.
    const claimed = await identity(f.users.jade, f.areas.charlie);
    assert.equal(claimed.acting, null, "an Area they are not in is not claimable");
    assert.equal(claimed.admin, false);

    assert.equal(await seen(db, who(f.users.jade, f.areas.charlie),
      "people", "area_id = $1", [f.areas.charlie]), 0, "and naming it grants no sight of it");
    assert.equal(await seen(db, who(f.users.jade, f.areas.charlie),
      "areas", "id = $1", [f.areas.charlie]), 0);
  });

  test("a cookie left over from a family they have LEFT stops selecting it", async () => {
    // Jade leaves Bravo. The browser still remembers Bravo and still sends it,
    // because a cookie does not know what happened.
    const left = await probe(db, who(f.users.jade, f.areas.bravo),
      "select public.leave_area($1)", [f.areas.bravo]);
    assert.ok(left.ok, left.error);

    const stale = await identity(f.users.jade, f.areas.bravo);
    assert.equal(stale.acting, null, "a membership that is over is not a membership");
    assert.equal(await seen(db, who(f.users.jade, f.areas.bravo),
      "people", "area_id = $1", [f.areas.bravo]), 0, "and what they left is no longer readable");

    // Alpha, which they never left, is still theirs and still selectable. There
    // is nothing to log out of and no cookie anybody has to clear.
    const home = await identity(f.users.jade, f.areas.alpha);
    assert.equal(home.acting, f.areas.alpha);
    assert.equal(home.person, f.people.jade);

    await asOwner(db);
    await db.query("update public.app_members set active = true where user_id = $1 and area_id = $2",
      [f.users.jade, f.areas.bravo]);
  });

  test("the claim is re-checked every request, so ending a membership ends it at once", async () => {
    await asOwner(db);
    await db.query("update public.app_members set active = false where user_id = $1 and area_id = $2",
      [f.users.dual, f.areas.bravo]);

    const now = await identity(f.users.dual, f.areas.bravo);
    assert.equal(now.acting, null);
    assert.equal(now.member, null, "and there is no membership left to act with");

    await asOwner(db);
    await db.query("update public.app_members set active = true where user_id = $1 and area_id = $2",
      [f.users.dual, f.areas.bravo]);
  });

  test("every route that changes a family checks the request came from one of our pages", () => {
    // The database refuses an unauthorised caller whatever the origin says.
    // This is the lock the database cannot see: another site POSTing with
    // somebody's cookies attached, so a request they never made looks like one
    // they did.
    for (const route of [
      "src/app/api/areas/route.ts",
      "src/app/api/areas/name/route.ts",
      "src/app/api/areas/membership/route.ts",
    ]) {
      const source = readFileSync(new URL(`../${route}`, import.meta.url), "utf8");
      assert.match(source, /isSameOrigin\(request\)/u, `${route} must check the origin`);
    }
  });
});

// ===========================================================================
// 11. Belonging to several families, and staying signed in to them
// ===========================================================================

/**
 * TWO DEFECTS, ONE CAUSE, BOTH FOUND BY A PERSON RATHER THAN BY A TEST.
 *
 *   A. Leaving one family signed you out of the others.
 *   B. Signing in signed you straight back out again, for ever.
 *
 * The cause is the same in both. Three rules, each defensible alone:
 *
 *   1. `getCurrentMember` -- and migration 038 in the database -- REFUSE TO
 *      GUESS which family a login with several memberships means. Right, and
 *      the reason two families cannot bleed into each other.
 *   2. `FamilyProvider` treats "no membership" as "your access was revoked",
 *      signs the session out and shows `/login?error=access_denied`.
 *   3. Nothing in the sign-in path ever wrote the `gp_area` cookie, and leaving
 *      a family DELETED it.
 *
 * Put together: an account in two or more families with no cookie could not
 * survive one render. Leaving a family caused it (A); so did a new browser, a
 * private window, a cleared cookie, a second device, or simply signing in on a
 * machine that had never switched family (B). There was no way out from inside
 * the app.
 *
 * THE REFUSAL IS NOT WHAT CHANGED. Rule 1 stays exactly as it was. What was
 * missing is that "has not chosen yet" is not "has no access": it is a question
 * nobody asked. The app asks it now -- at sign-in, and again if it ever finds
 * itself without an answer -- and only concludes "revoked" once there is
 * genuinely nothing to choose.
 */

const source = (relative) =>
  readFileSync(new URL("../" + relative, import.meta.url), "utf8").replace(/\r\n/gu, "\n");

describe("leaving one family leaves the others alone -- in the app, not just the database", () => {
  const route = source("src/app/api/areas/membership/route.ts");
  const leave = route.slice(route.indexOf('if (action === "leave")'), route.indexOf("set_area_archived"));

  test("the leave branch does not simply delete the remembered Area", () => {
    assert.match(leave, /resolveActiveArea\(/u,
      "it must choose another family the person still belongs to");
    assert.match(leave, /rememberArea\(response, next\.id\)/u,
      "and write that choice, so the next request can resolve a membership");
  });

  test("the Area just left is excluded from the choice", () => {
    assert.match(leave, /\.neq\("id", areaId\)/u,
      "otherwise it could re-select the family they just walked out of");
  });

  test("the cookie is cleared ONLY when the list of remaining families is known to be empty", () => {
    /*
     * The failure this orders. `remaining` erroring is not the same as
     * "nothing left", and treating it as such is the OLD behaviour -- which
     * locked people out. A known-empty list clears; an unknown one leaves the
     * cookie alone for `ensureAreaChosen` to repair.
     */
    const remembered = leave.indexOf("rememberArea(response, next.id)");
    const errorGuard = leave.indexOf("if (remaining.error) return response;");
    const forgotten = leave.indexOf("forgetArea(response)");
    assert.ok(remembered > 0 && errorGuard > remembered && forgotten > errorGuard,
      "order must be: choose, then bail out on an unknown list, then forget");
  });

  test("and the two routes that remember an Area share one implementation", () => {
    // A `maxAge` or a `path` that disagreed between them would expire a choice
    // early and sign a multi-family login out -- this defect, from a typo.
    const cookie = source("src/utils/area-cookie.ts");
    assert.match(cookie, /export function rememberArea/u);
    assert.match(cookie, /export function forgetArea/u);
    for (const file of ["src/app/api/areas/route.ts", "src/app/api/areas/membership/route.ts"]) {
      assert.match(source(file), /from "@\/utils\/area-cookie"/u, file);
      assert.ok(!/cookies\.set\(AREA_COOKIE/u.test(source(file)),
        file + " must not write the cookie itself");
    }
  });

  test("AND THE DATABASE HALF WAS ALWAYS RIGHT -- one membership ends, the rest do not", async () => {
    // Re-proving the invariant the app broke, so the two halves are pinned
    // together: Jade leaves Bravo and keeps Alpha.
    await restoreAlpha();
    const left = await probe(db, who(f.users.jade, f.areas.bravo),
      "select public.leave_area($1)", [f.areas.bravo]);
    assert.ok(left.ok, left.error);

    await asOwner(db);
    const mine = await rows(db, `
      select a.name, m.active from public.app_members m
      join public.areas a on a.id = m.area_id
      where m.user_id = $1 order by a.name`, [f.users.jade]);
    assert.deepEqual(mine, [
      { name: "Alpha", active: true },
      { name: "Bravo", active: false },
    ], "exactly one membership ends");

    await asOwner(db);
    await db.query("update public.app_members set active = true where user_id = $1 and area_id = $2",
      [f.users.jade, f.areas.bravo]);
  });

  test("THREE FAMILIES, LEAVE ONE, TWO REMAIN -- and both are still readable", async () => {
    /*
     * `dual` administers Alpha and Charlie and is an ordinary member of Bravo:
     * the exact account live QA was signed out of. Leaving Bravo must leave two
     * families it can still read, which is what the route now points the cookie
     * at.
     */
    await restoreAlpha();
    const mine = async () => {
      const read = await probe(db, who(f.users.dual, null), "select name from public.areas order by name");
      assert.ok(read.ok, read.error);
      return read.rows.map((row) => row.name);
    };

    // Asserted as a DELTA rather than a fixed list: earlier sections of this
    // file hand `dual` more families, and what matters is that leaving one
    // removes exactly that one.
    const before = await mine();
    assert.ok(before.includes("Bravo") && before.includes("Alpha") && before.includes("Charlie"),
      "the account under test must start out in at least three families");

    const left = await probe(db, who(f.users.dual, f.areas.bravo),
      "select public.leave_area($1)", [f.areas.bravo]);
    assert.ok(left.ok, left.error);

    const after = await mine();
    assert.deepEqual(after, before.filter((name) => name !== "Bravo"),
      "exactly the family they left goes; every other one stays readable");
    assert.ok(after.length >= 2, "and there is more than one left to point the cookie at");

    await asOwner(db);
    await db.query("update public.app_members set active = true where user_id = $1 and area_id = $2",
      [f.users.dual, f.areas.bravo]);
  });

  test("leaving the ONLY family leaves nothing to choose, which is the one case for clearing", async () => {
    /*
     * A login of its own, belonging to Alpha and to nothing else, because the
     * fixture accounts have collected other families from the sections above
     * and this is the one assertion that needs the list to reach ZERO.
     */
    await restoreAlpha();
    await asOwner(db);
    const solitary = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('solitary@example.test', now()) returning id`);
    const person = await value(db,
      "insert into public.people (name, area_id) values ('Solitary', $1) returning id", [f.areas.alpha]);
    await db.query(`
      insert into public.app_members (area_id, person_id, user_id, email, role, active)
      values ($1, $2, $3, 'solitary@example.test', 'member', true)`, [f.areas.alpha, person, solitary]);

    const before = await probe(db, who(solitary, null), "select id from public.areas");
    assert.equal(before.rows.length, 1, "exactly one family to start with");

    const left = await probe(db, who(solitary, f.areas.alpha),
      "select public.leave_area($1)", [f.areas.alpha]);
    assert.ok(left.ok, left.error);

    const readable = await probe(db, who(solitary, null), "select id from public.areas");
    assert.deepEqual(readable.rows, [], "nothing left to point a cookie at");
    await restoreAlpha();
  });

  test("a sole administrator is still refused, and their other families are untouched", async () => {
    await restoreAlpha();
    const administered = async () => {
      await asOwner(db);
      return (await rows(db, `
        select a.name from public.app_members m
        join public.areas a on a.id = m.area_id
        where m.user_id = $1 and m.active and m.role = 'admin' order by a.name`, [f.users.dual]))
        .map((row) => row.name);
    };

    const before = await administered();
    assert.ok(before.includes("Alpha"), "they must run Alpha for the refusal to be the sole-admin one");

    const refused = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.leave_area($1)", [f.areas.alpha]);
    assert.equal(refused.ok, false, "Alpha's only admin cannot walk out of it");

    assert.deepEqual(await administered(), before, "a refusal changes nothing anywhere");
  });
});

describe("signing in cannot sign you out again", () => {
  const provider = source("src/app/family-context.tsx");
  const login = source("src/app/login/page.tsx");
  const chooser = source("src/utils/supabase/area-choice-client.ts");

  test("THE PROVIDER ASKS WHICH FAMILY BEFORE IT CONCLUDES THERE IS NO ACCESS", () => {
    const branch = provider.slice(
      provider.indexOf("if (!membership.data)"),
      provider.indexOf("setRole(membership.data.role"));
    assert.match(branch, /ensureAreaChosen\(\)/u,
      "the question that was never asked");
    const asked = branch.indexOf("ensureAreaChosen()");
    const signedOut = branch.indexOf("db.auth.signOut()");
    assert.ok(asked > 0 && signedOut > asked,
      "asking must come BEFORE signing out, or the fix does nothing");
  });

  test("and reloads rather than re-rendering once one is chosen", () => {
    // Half the screen holding one family while the other half fetches another
    // is not a state worth having -- the same reason switching reloads.
    assert.match(provider, /if \(outcome === "chosen"\) \{ window\.location\.reload\(\); return; \}/u);
  });

  test("signing in settles the family, so the first screen is already right", () => {
    assert.match(login, /await ensureAreaChosen\(\);/u);
    const chosen = login.indexOf("await ensureAreaChosen();");
    const home = login.indexOf('router.push("/")');
    assert.ok(chosen > 0 && home > chosen, "before the app is opened, not after");
  });

  test("THE CHOICE IS THE SWITCHER'S OWN RULE, not a second one invented here", () => {
    // Two rules would drift, and the family the app picked would stop matching
    // the family the menu showed as current.
    assert.match(chooser, /resolveActiveArea\(areas, remembered\)/u);
    assert.match(chooser, /\.from\("areas"\)/u, "read the caller's own families");
  });

  test("an account that belongs to nothing is NOT given a family", () => {
    assert.match(chooser, /if \(areas\.length === 0\) return "none";/u,
      "zero families is a real answer -- the product signs them out and says so");
  });

  test("and it cannot loop: the same choice is never written twice", () => {
    assert.match(chooser, /if \(chosen\.id === remembered\) return "unchanged";/u);
  });

  test("THE DATABASE STILL REFUSES TO GUESS, which is what the cookie exists to answer", async () => {
    /*
     * The rule the app must never work around. `dual` is in three families; with
     * no acting Area claimed, `is_app_admin()` is FALSE even though they
     * administer two of them. That is migration 038 doing its job, and it is
     * why "choose a family" had to be answered rather than skipped.
     */
    await restoreAlpha();
    const unsaid = await probe(db, who(f.users.dual, null), "select public.is_app_admin() as admin");
    assert.equal(unsaid.rows[0].admin, false, "no Area claimed, no administration");

    const said = await probe(db, who(f.users.dual, f.areas.alpha), "select public.is_app_admin() as admin");
    assert.equal(said.rows[0].admin, true, "say which family, and the answer arrives");
  });

  test("AND A CHOICE IS ALWAYS AVAILABLE TO BE MADE -- the fix is possible at all", async () => {
    /*
     * `ensureAreaChosen` reads `areas` with no Area claimed. If that read were
     * itself gated on having chosen one, the repair could never run. It is not:
     * `areas` answers `is_area_member(id)` directly.
     */
    const readable = await probe(db, who(f.users.dual, null), "select name from public.areas order by name");
    assert.ok(readable.ok, readable.error);
    const names = readable.rows.map((row) => row.name);
    for (const expected of ["Alpha", "Bravo", "Charlie"]) {
      assert.ok(names.includes(expected), `${expected} must be choosable with nothing claimed`);
    }
    assert.ok(names.length > 1,
      "more than one, which is the case the cookie exists to answer");
  });
});
