/**
 * THE AREA RULES, RUN RATHER THAN READ.
 *
 * Two families, a login that belongs to both, a birthday with a secret in it,
 * and a real PostgreSQL 18 underneath. Every assertion here is somebody trying
 * something and the database allowing or refusing it -- through the same shape
 * a browser request has: one transaction, a role, JWT claims, and the PostgREST
 * pre-request hook running inside it.
 *
 * WHAT THIS IS FOR. Row level security, SECURITY DEFINER routines and triggers
 * cannot be checked by reading SQL. A policy can be written correctly and
 * attached to nothing; a definer routine can look careful and still bypass the
 * policy that was doing the work; a trigger can be created on the wrong table.
 * The only proof is a refusal.
 *
 * See `scripts/pg/fixtures.mjs` for who everybody is.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";
import { asOwner, attempt, buildRehearsal, probe, probeValue, rows, seen, value } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

let db;
let f;

/** Shorthand: who is asking, and which family they say they are in. */
const who = (user, area) => ({ user, area });

before(async () => {
  db = await buildRehearsal({});
  f = await buildTwoFamilies(db);
});
after(async () => { await db?.close(); });

// ===========================================================================
// 1. The pre-request hook
// ===========================================================================

describe("the acting Area is a claim, checked, and never a permission", () => {
  test("no header leaves no acting Area", async () => {
    const result = await probeValue(db, who(f.users.dual), "select public.acting_area()");
    assert.equal(result.value, null);
  });

  test("a header naming an Area the caller IS in becomes the acting Area", async () => {
    const result = await probeValue(db, who(f.users.dual, f.areas.alpha), "select public.acting_area()");
    assert.equal(result.value, f.areas.alpha);
  });

  test("a header naming an Area the caller is NOT in is ignored, not obeyed", async () => {
    // `dual` is a member of Alpha, Bravo and Charlie -- never the legacy family.
    const result = await probeValue(db, who(f.users.dual, f.areas.legacy), "select public.acting_area()");
    assert.equal(result.value, null);
  });

  test("a malformed header is ignored and the request still succeeds", async () => {
    const result = await probeValue(db, who(f.users.dual, "not-a-uuid"), "select public.acting_area()");
    assert.equal(result.ok, true);
    assert.equal(result.value, null);
  });

  test("claiming an Area gets you a member's rights there, never an administrator's", async () => {
    // `dual` administers Alpha and Charlie and is an ordinary member of Bravo.
    const alpha = await probeValue(db, who(f.users.dual, f.areas.alpha), "select public.is_app_admin()");
    const bravo = await probeValue(db, who(f.users.dual, f.areas.bravo), "select public.is_app_admin()");
    const charlie = await probeValue(db, who(f.users.dual, f.areas.charlie), "select public.is_app_admin()");
    assert.equal(alpha.value, true, "administers Alpha");
    assert.equal(bravo.value, false, "claiming Bravo does not carry Alpha's role into it");
    assert.equal(charlie.value, true, "administers Charlie too");
  });

  test("a login in several Areas that says nothing is refused rather than guessed at", async () => {
    const result = await probeValue(db, who(f.users.dual), "select public.is_app_admin()");
    assert.equal(result.value, false);
    const person = await probeValue(db, who(f.users.dual), "select public.current_person_id()");
    assert.equal(person.value, null);
  });

  test("and the answer follows the Area, not the login", async () => {
    const inAlpha = await probeValue(db, who(f.users.dual, f.areas.alpha), "select public.current_person_id()");
    const inBravo = await probeValue(db, who(f.users.dual, f.areas.bravo), "select public.current_person_id()");
    assert.equal(inAlpha.value, f.people.ada);
    assert.equal(inBravo.value, f.people.jo);
    assert.notEqual(inAlpha.value, inBravo.value);
  });

  test("a signed-out visitor cannot claim anything", async () => {
    const result = await probe(db, { user: null, area: f.areas.alpha }, "select public.is_area_member($1)", [f.areas.alpha]);
    assert.equal(result.ok, false, "anon must not be able to ask");
  });
});

// ===========================================================================
// 2. Reading across a family
// ===========================================================================

describe("no family can read another", () => {
  test("an Alpha member sees Alpha's people and nobody else's", async () => {
    assert.equal(await seen(db, who(f.users.mo, f.areas.alpha), "people", "area_id = $1", [f.areas.alpha]), 4);
    assert.equal(await seen(db, who(f.users.mo, f.areas.alpha), "people", "area_id = $1", [f.areas.bravo]), 0);
    assert.equal(await seen(db, who(f.users.mo, f.areas.alpha), "people", "area_id = $1", [f.areas.legacy]), 0);
  });

  test("and cannot reach a Bravo person by naming its id", async () => {
    const result = await probe(db, who(f.users.mo, f.areas.alpha),
      "select name from public.people where id = $1", [f.people.sam]);
    assert.equal(result.count, 0, "an id from another family finds nothing");
  });

  test("claiming Bravo does not let an Alpha-only member read Bravo", async () => {
    assert.equal(await seen(db, who(f.users.mo, f.areas.bravo), "people", "area_id = $1", [f.areas.bravo]), 0);
  });

  test("a login in both families sees each one when it is the one on screen", async () => {
    // Legitimately visible in both -- but the Area still decides which rows.
    assert.equal(await seen(db, who(f.users.dual, f.areas.alpha), "people", "area_id = $1", [f.areas.alpha]), 4);
    assert.equal(await seen(db, who(f.users.dual, f.areas.bravo), "people", "area_id = $1", [f.areas.bravo]), 4);
    // AND NEVER THE LEGACY FAMILY, which it does not belong to.
    assert.equal(await seen(db, who(f.users.dual, f.areas.alpha), "people", "area_id = $1", [f.areas.legacy]), 0);
  });

  test("the money is invisible across a family too", async () => {
    for (const table of ["purchases", "gift_ideas", "purchase_allocations", "recipient_contributions", "settlements"]) {
      const count = await seen(db, who(f.users.sam, f.areas.bravo), table);
      assert.equal(count, 0, `a Bravo member must see none of Alpha's ${table}`);
    }
  });

  test("an Area is only visible to the people in it", async () => {
    const dual = await probe(db, who(f.users.dual, f.areas.alpha), "select name from public.areas order by name");
    assert.deepEqual(dual.rows.map((r) => r.name), ["Alpha", "Bravo", "Charlie"]);
    const mo = await probe(db, who(f.users.mo, f.areas.alpha), "select name from public.areas order by name");
    assert.deepEqual(mo.rows.map((r) => r.name), ["Alpha"]);
  });

  test("a deactivated membership sees nothing at all", async () => {
    await asOwner(db);
    await db.query("update public.app_members set active = false where id = $1", [f.members.moAlpha]);
    assert.equal(await seen(db, who(f.users.mo, f.areas.alpha), "people", "area_id = $1", [f.areas.alpha]), 0);
    assert.equal((await probeValue(db, who(f.users.mo, f.areas.alpha), "select public.acting_area()")).value, null,
      "and cannot even claim the Area any more");
    await asOwner(db);
    await db.query("update public.app_members set active = true where id = $1", [f.members.moAlpha]);
  });
});

// ===========================================================================
// 3. MIGRATION 039 -- contributor eligibility, in one Area
// ===========================================================================

describe("is_area_contributor_member answers about one Area", () => {
  const ask = (user, area, subject) =>
    probeValue(db, who(user, area), "select public.is_area_contributor_member($1)", [subject]);

  test("a contributor in Alpha is one in Alpha", async () => {
    assert.equal((await ask(f.users.jade, f.areas.alpha, f.areas.alpha)).value, true);
  });

  test("and is NOT one in Bravo, where the same login is an ordinary member", async () => {
    // THE ESCALATION MIGRATION 039 EXISTS TO CLOSE. Before it, the question was
    // "is this login a contributor anywhere", and the answer was yes.
    assert.equal((await ask(f.users.jade, f.areas.bravo, f.areas.bravo)).value, false);
  });

  test("a plain member is not a contributor", async () => {
    assert.equal((await ask(f.users.mo, f.areas.alpha, f.areas.alpha)).value, false);
  });

  test("a deactivated membership is not a contributor", async () => {
    await asOwner(db);
    await db.query("update public.app_members set active = false where id = $1", [f.members.jadeAlpha]);
    assert.equal((await ask(f.users.jade, f.areas.alpha, f.areas.alpha)).value, false);
    await asOwner(db);
    await db.query("update public.app_members set active = true where id = $1", [f.members.jadeAlpha]);
  });

  test("being a contributor in Alpha cannot be spent in Bravo, whatever is claimed", async () => {
    // Ask about Alpha while acting in Bravo, and about Bravo while acting in
    // Alpha. The answer follows the Area asked about, not the one claimed.
    assert.equal((await ask(f.users.jade, f.areas.bravo, f.areas.alpha)).value, true);
    assert.equal((await ask(f.users.jade, f.areas.alpha, f.areas.bravo)).value, false);
  });
});

// ===========================================================================
// 4. MIGRATION 039 -- who may set a birthday
// ===========================================================================

describe("a birthday is edited by that Area's admin or that Area's contributors", () => {
  const setBirthday = (user, area, person, month = 5, day = 4) =>
    probe(db, who(user, area),
      "select id from public.set_person_birthday($1, $2::smallint, $3::smallint, $4::smallint)",
      [person, month, day, 1990]);

  test("this Area's administrator can", async () => {
    const result = await setBirthday(f.users.dual, f.areas.alpha, f.people.mo);
    assert.equal(result.ok, true, result.error);
  });

  test("this Area's contributor can", async () => {
    const result = await setBirthday(f.users.jade, f.areas.alpha, f.people.mo, 6, 7);
    assert.equal(result.ok, true, result.error);
    await asOwner(db);
    assert.equal(await value(db, "select birthday_month from public.people where id = $1", [f.people.mo]), 6);
  });

  test("a plain member cannot", async () => {
    const result = await setBirthday(f.users.mo, f.areas.alpha, f.people.jade);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
  });

  test("AN ALPHA ADMINISTRATOR CANNOT EDIT A BRAVO PERSON", async () => {
    // Even acting in Alpha, where they really are the administrator.
    const result = await setBirthday(f.users.dual, f.areas.alpha, f.people.sam);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
  });

  test("nor by claiming Bravo, where they are only a member", async () => {
    const result = await setBirthday(f.users.dual, f.areas.bravo, f.people.sam);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
  });

  test("AN ALPHA CONTRIBUTOR CANNOT EDIT A BRAVO PERSON", async () => {
    // The exact escalation: a contributor in one family, an ordinary member in
    // another, editing the other family's birthdays.
    for (const area of [f.areas.alpha, f.areas.bravo]) {
      const result = await setBirthday(f.users.jade, area, f.people.sam);
      assert.equal(result.ok, false, `claiming ${area} must not help`);
      assert.equal(result.code, "42501");
    }
  });

  test("Bravo's own administrator still can", async () => {
    const result = await setBirthday(f.users.bravoadmin, f.areas.bravo, f.people.jo);
    assert.equal(result.ok, true, result.error);
  });

  test("a person id that names nobody is refused exactly like one from another family", async () => {
    const nobody = await setBirthday(f.users.dual, f.areas.alpha, "00000000-0000-4000-8000-000000000000");
    const foreign = await setBirthday(f.users.dual, f.areas.alpha, f.people.sam);
    assert.equal(nobody.ok, false);
    assert.equal(foreign.ok, false);
    assert.equal(nobody.error, foreign.error, "the two must be indistinguishable");
  });

  test("a signed-out caller cannot reach it at all", async () => {
    const result = await probe(db, { user: null }, "select public.set_person_birthday($1, 1::smallint, 1::smallint, null)", [f.people.mo]);
    assert.equal(result.ok, false);
  });

  test("and the answer does not depend on the pre-request hook having run", async () => {
    // No header at all. `is_app_admin()` would refuse a login in three Areas --
    // 039 derives the Area from the PERSON instead, so this still works.
    const result = await setBirthday(f.users.dual, undefined, f.people.mo, 8, 9);
    assert.equal(result.ok, true, `deriving the Area must not need a claim: ${result.error ?? ""}`);
    await asOwner(db);
    assert.equal(await value(db, "select birthday_month from public.people where id = $1", [f.people.mo]), 8);
  });
});

// ===========================================================================
// 5. MIGRATION 039 -- the definer reader that used to leak
// ===========================================================================

describe("list_gift_ideas is Area-scoped and keeps the surprise", () => {
  const list = (user, area, recipient) =>
    probe(db, who(user, area), "select title from public.list_gift_ideas($1)", [recipient]);

  test("a planner in the right family sees the ideas", async () => {
    const result = await list(f.users.dual, f.areas.alpha, f.recipient);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.rows.map((r) => r.title), ["Surprise weekend away"]);
  });

  test("A CALLER FROM ANOTHER FAMILY IS REFUSED", async () => {
    // Before 039 this was a SECURITY DEFINER routine asking only "are you an
    // active member of anything", so any member of any family could read any
    // recipient's ideas: titles, prices, links, notes and who suggested them.
    const result = await list(f.users.sam, f.areas.bravo, f.recipient);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
  });

  test("and claiming the other family does not help", async () => {
    const result = await list(f.users.sam, f.areas.alpha, f.recipient);
    assert.equal(result.ok, false);
  });

  test("THE CELEBRANT GETS NO ROWS, AND NO ERROR", async () => {
    // No rows rather than a refusal: an error would confirm a recipient row for
    // their birthday exists, which they are told nowhere else.
    const result = await list(f.users.taylor, f.areas.alpha, f.recipient);
    assert.equal(result.ok, true, "it must not error");
    assert.equal(result.count, 0, "and it must return nothing");
  });

  test("the celebrant cannot read the idea directly either", async () => {
    assert.equal(await seen(db, who(f.users.taylor, f.areas.alpha), "gift_ideas", "id = $1", [f.secretIdea]), 0);
  });

  test("definer rights do not put a member of no family inside one", async () => {
    const result = await probe(db, { user: null }, "select * from public.list_gift_ideas($1)", [f.recipient]);
    assert.equal(result.ok, false);
  });
});

// ===========================================================================
// 6. MIGRATION 039 -- an idea is credited inside its own family
// ===========================================================================

describe("a gift idea cannot be credited to another family's membership", () => {
  test("the trigger refuses it, even written with owner rights", async () => {
    // Owner rights bypass row level security AND migration 037's barrier, which
    // exempts callers with no auth.uid(). A trigger is not bypassed, which is
    // the whole reason this rule is one.
    await asOwner(db);
    const result = await attempt(db, `
      insert into public.gift_ideas (christmas_recipient_id, title, suggested_by_app_member_id)
      values ($1, 'Smuggled', $2)`, [f.recipient, f.members.samBravo]);
    assert.equal(result.ok, false);
    assert.match(result.error, /different Area/u);
  });

  test("and accepts one credited inside the family", async () => {
    await asOwner(db);
    const result = await attempt(db, `
      insert into public.gift_ideas (christmas_recipient_id, title, suggested_by_app_member_id)
      values ($1, 'Legitimate', $2) returning id`, [f.recipient, f.members.jadeAlpha]);
    assert.equal(result.ok, true, result.error);
    await db.query("delete from public.gift_ideas where title = 'Legitimate'");
  });
});

// ===========================================================================
// 7. MIGRATION 040 -- the birthday person's own list
// ===========================================================================

describe("the celebrant keeps a wishlist, and learns nothing from it", () => {
  let wishId;

  test("they can add to their own list", async () => {
    const result = await probe(db, who(f.users.taylor, f.areas.alpha), `
      insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title, estimated_price_pennies)
      values ($1, 2027, 'AirPods', 12900) returning id`, [f.people.taylor]);
    assert.equal(result.ok, true, result.error);
    wishId = result.rows[0].id;
  });

  test("the Area and the author are DERIVED, not taken from the browser", async () => {
    await asOwner(db);
    const row = (await rows(db, `
      select area_id, created_by_app_member_id from public.birthday_wishlist_ideas where id = $1`, [wishId]))[0];
    assert.equal(row.area_id, f.areas.alpha);
    assert.equal(row.created_by_app_member_id, f.members.taylorAlpha);
  });

  test("and a browser that supplies somebody else's cannot make it stick", async () => {
    const result = await probe(db, who(f.users.taylor, f.areas.alpha), `
      insert into public.birthday_wishlist_ideas
        (person_id, occurrence_year, title, area_id, created_by_app_member_id)
      values ($1, 2027, 'Spoofed', $2, $3) returning area_id, created_by_app_member_id`,
    [f.people.taylor, f.areas.bravo, f.members.samBravo]);
    assert.equal(result.ok, false, "a membership that is not theirs must be refused");
  });

  test("AND NEITHER CAN A WRITER WHO SUPPLIES THEIR OWN -- FROM THE WRONG FAMILY", async () => {
    /*
     * THE CASE THE ANCHORING CHECK EXISTS FOR.
     *
     * `jade` holds a membership in Alpha and one in Bravo. Writing her own
     * Bravo list while crediting her ALPHA membership passes every other guard:
     * the row is hers, the person is hers, and `is_own_app_member` is true --
     * it is her membership. What would be wrong is the CREDIT, which would
     * record a Bravo wish as authored from Alpha.
     *
     * The trigger refuses it, because the author must be that person's
     * membership in THAT Area and active.
     */
    const wrongFamily = await probe(db, who(f.users.jade, f.areas.bravo), `
      insert into public.birthday_wishlist_ideas
        (person_id, occurrence_year, title, created_by_app_member_id)
      values ($1, 2027, 'Credited to the wrong family', $2)
      returning area_id, created_by_app_member_id`, [f.people.jem, f.members.jadeAlpha]);

    assert.equal(wrongFamily.ok, false,
      "a wish must be credited to the writer's membership in its own family");
    assert.equal(wrongFamily.code, "42501");

    // And supplying the RIGHT one is accepted, so the refusal is about the
    // family and not about supplying a value at all.
    const rightFamily = await probe(db, who(f.users.jade, f.areas.bravo), `
      insert into public.birthday_wishlist_ideas
        (person_id, occurrence_year, title, created_by_app_member_id)
      values ($1, 2027, 'Credited correctly', $2)
      returning area_id, created_by_app_member_id`, [f.people.jem, f.members.jemBravo]);
    assert.equal(rightFamily.ok, true, rightFamily.error);
    assert.equal(rightFamily.rows[0].area_id, f.areas.bravo);
    assert.equal(rightFamily.rows[0].created_by_app_member_id, f.members.jemBravo);
  });

  test("they can read, edit and remove it", async () => {
    const read = await probe(db, who(f.users.taylor, f.areas.alpha),
      "select title from public.birthday_wishlist_ideas where id = $1", [wishId]);
    assert.deepEqual(read.rows.map((r) => r.title), ["AirPods"]);

    const edit = await probe(db, who(f.users.taylor, f.areas.alpha),
      "update public.birthday_wishlist_ideas set title = 'AirPods Pro' where id = $1 returning title", [wishId]);
    assert.equal(edit.ok, true, edit.error);
    assert.equal(edit.rows[0].title, "AirPods Pro");
  });

  test("NOBODY ELSE MAY WRITE THEIR LIST -- not a member, not a contributor, not the admin", async () => {
    for (const [label, user] of [["a plain member", f.users.mo], ["a contributor", f.users.jade], ["the administrator", f.users.dual]]) {
      const insert = await probe(db, who(user, f.areas.alpha), `
        insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title)
        values ($1, 2027, 'Planted') returning id`, [f.people.taylor]);
      assert.equal(insert.ok, false, `${label} must not add to somebody else's wishlist`);

      const update = await probe(db, who(user, f.areas.alpha),
        "update public.birthday_wishlist_ideas set title = 'Tampered' where id = $1 returning id", [wishId]);
      assert.equal(update.count, 0, `${label} must not edit it`);

      const remove = await probe(db, who(user, f.areas.alpha),
        "delete from public.birthday_wishlist_ideas where id = $1 returning id", [wishId]);
      assert.equal(remove.count, 0, `${label} must not remove it`);
    }
  });

  test("but the family CAN read it -- that is what it is for", async () => {
    for (const user of [f.users.dual, f.users.jade, f.users.mo]) {
      const result = await probe(db, who(user, f.areas.alpha),
        "select title from public.birthday_wishlist_ideas where id = $1", [wishId]);
      assert.equal(result.count, 1);
      assert.equal(result.rows[0].title, "AirPods Pro");
    }
  });

  test("ANOTHER FAMILY CANNOT READ IT", async () => {
    for (const [user, area] of [[f.users.sam, f.areas.bravo], [f.users.sam, f.areas.alpha], [f.users.bravoadmin, f.areas.bravo]]) {
      assert.equal(await seen(db, who(user, area), "birthday_wishlist_ideas", "id = $1", [wishId]), 0);
    }
  });

  test("THE SAME LOGIN IN TWO FAMILIES RESOLVES EACH SEPARATELY", async () => {
    // `jade` is Jade in Alpha and Jem in Bravo. She may write Jem's Bravo list
    // and Jade's Alpha list, and neither membership reaches the other.
    const ownBravo = await probe(db, who(f.users.jade, f.areas.bravo), `
      insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title)
      values ($1, 2027, 'Bravo wish') returning area_id`, [f.people.jem]);
    assert.equal(ownBravo.ok, true, ownBravo.error);
    assert.equal(ownBravo.rows[0].area_id, f.areas.bravo);

    /*
     * AND THE CLAIMED AREA IS IRRELEVANT TO WHERE IT LANDS.
     *
     * Writing Jem's list while the browser says "Alpha" is not a boundary
     * crossing: it is still Jem writing Jem's own list, and the row is filed in
     * BRAVO because the Area is derived from the person rather than from the
     * request. That is the same property that stops `set_person_birthday`
     * depending on the pre-request hook, and it is what makes the identity in
     * one family unable to affect the other -- the Alpha membership is never
     * consulted, and never credited.
     */
    const claimedAlpha = await probe(db, who(f.users.jade, f.areas.alpha), `
      insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title)
      values ($1, 2027, 'Filed under Bravo') returning area_id, created_by_app_member_id`, [f.people.jem]);
    assert.equal(claimedAlpha.ok, true, claimedAlpha.error);
    assert.equal(claimedAlpha.rows[0].area_id, f.areas.bravo, "the row belongs to the person's family");
    assert.equal(claimedAlpha.rows[0].created_by_app_member_id, f.members.jemBravo,
      "and is credited to that family's membership, never the Alpha one");
  });

  test("and a member of neither family may write nothing", async () => {
    const result = await probe(db, who(f.users.mo, f.areas.alpha), `
      insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title)
      values ($1, 2027, 'Nope') returning id`, [f.people.sam]);
    assert.equal(result.ok, false);
  });

  test("a deactivated membership cannot write their own list either", async () => {
    await asOwner(db);
    await db.query("update public.app_members set active = false where id = $1", [f.members.taylorAlpha]);
    const result = await probe(db, who(f.users.taylor, f.areas.alpha), `
      insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title)
      values ($1, 2027, 'While disabled') returning id`, [f.people.taylor]);
    assert.equal(result.ok, false);
    await asOwner(db);
    await db.query("update public.app_members set active = true where id = $1", [f.members.taylorAlpha]);
  });

  test("the same wish twice is one wish", async () => {
    const again = await probe(db, who(f.users.taylor, f.areas.alpha), `
      insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title)
      values ($1, 2027, 'airpods pro') returning id`, [f.people.taylor]);
    assert.equal(again.ok, false);
    assert.equal(again.code, "23505");
  });

  test("BUYING WHAT THEY ASKED FOR CHANGES NOTHING ON THEIR LIST", async () => {
    // The family buys AirPods Pro through the normal planning path.
    const boughtIdea = await probe(db, who(f.users.jade, f.areas.alpha),
      "select id from public.save_gift_idea(null, $1, 'AirPods Pro', 12900, null, null, null)", [f.recipient]);
    assert.equal(boughtIdea.ok, true, boughtIdea.error);

    await asOwner(db);
    await db.query(`
      insert into public.purchases
        (christmas_recipient_id, description, actual_price_pennies,
         checkout_payer_contributor_id, created_by_app_member_id, originating_gift_idea_id, status)
      values ($1, 'AirPods Pro', 12900, $2, $3, $4, 'wrapped')`,
    [f.recipient, f.jadeContributor, f.members.jadeAlpha, boughtIdea.rows[0].id]);

    // The wish is untouched, and still says exactly what Taylor typed.
    const still = await probe(db, who(f.users.taylor, f.areas.alpha),
      "select * from public.birthday_wishlist_ideas where id = $1", [wishId]);
    assert.equal(still.count, 1);
    const row = still.rows[0];
    assert.equal(row.title, "AirPods Pro");
    // And there is no column on it that could have been marked.
    for (const key of Object.keys(row)) {
      assert.ok(!/purchase|status|bought|wrapped|spent|budget|contributor/iu.test(key),
        `the wishlist row must not carry a column called ${key}`);
    }
  });
});

// ===========================================================================
// 8. What the celebrant still cannot see -- attacked directly
// ===========================================================================

describe("the celebrant is refused every route into their own birthday", () => {
  const celebrant = () => who(f.users.taylor, f.areas.alpha);

  test("their own birthday event is invisible", async () => {
    assert.equal(await seen(db, celebrant(), "events", "id = $1", [f.birthday]), 0);
  });

  test("and every other family's event they may not see", async () => {
    assert.equal(await seen(db, celebrant(), "events", "id = $1", [f.bravoBirthday]), 0);
  });

  test("but somebody else's birthday in their own family is normal", async () => {
    // Nothing here has narrowed a birthday that is not theirs.
    const other = await probe(db, who(f.users.dual, f.areas.alpha),
      "select count(*)::int n from public.events where id = $1", [f.birthday]);
    assert.equal(other.rows[0].n, 1);
  });

  test("the recipient, the budget, the purchases and the allocations are all hidden", async () => {
    assert.equal(await seen(db, celebrant(), "christmas_recipients", "id = $1", [f.recipient]), 0);
    assert.equal(await seen(db, celebrant(), "purchases", "id = $1", [f.purchase]), 0);
    assert.equal(await seen(db, celebrant(), "purchase_allocations", "purchase_id = $1", [f.purchase]), 0);
    assert.equal(await seen(db, celebrant(), "recipient_contributions", "christmas_recipient_id = $1", [f.recipient]), 0);
    assert.equal(await seen(db, celebrant(), "contributors", "christmas_event_id = $1", [f.birthday]), 0);
    assert.equal(await seen(db, celebrant(), "settlements", "christmas_event_id = $1", [f.birthday]), 0);
    assert.equal(await seen(db, celebrant(), "payment_receipts", "christmas_event_id = $1", [f.birthday]), 0);
  });

  test("and so is the family's secret idea for them", async () => {
    assert.equal(await seen(db, celebrant(), "gift_ideas", "christmas_recipient_id = $1", [f.recipient]), 0);
  });

  test("ID TAMPERING GETS THEM NOWHERE", async () => {
    // Every id in the model, named directly by somebody who should not have it.
    const attempts = [
      ["events", "id = $1", f.birthday],
      ["christmas_recipients", "id = $1", f.recipient],
      ["gift_ideas", "id = $1", f.secretIdea],
      ["purchases", "id = $1", f.purchase],
      ["contributors", "id = $1", f.jadeContributor],
    ];
    for (const [table, where, id] of attempts) {
      assert.equal(await seen(db, celebrant(), table, where, [id]), 0, `${table} by id`);
    }
  });

  test("AN ADMINISTRATOR WHO IS THE CELEBRANT IS RESTRICTED EXACTLY THE SAME", async () => {
    // Ada administers Alpha, and Alpha is planning Ada's birthday. This is the
    // celebrant holding every permission the application has, and the surprise
    // rule outranking all of them. Nothing here consults a role, which is why.
    const admin = who(f.users.dual, f.areas.alpha);
    assert.equal((await probeValue(db, admin, "select public.is_app_admin()")).value, true,
      "they really are this family's administrator");

    assert.equal(await seen(db, admin, "events", "id = $1", [f.adminBirthday]), 0);
    assert.equal(await seen(db, admin, "christmas_recipients", "id = $1", [f.adminRecipient]), 0);
    assert.equal(await seen(db, admin, "gift_ideas", "id = $1", [f.adminSecretIdea]), 0);

    const listed = await probe(db, admin, "select * from public.list_gift_ideas($1)", [f.adminRecipient]);
    assert.equal(listed.count, 0, "even the administrator's own birthday shows them nothing");

    // And everybody else's birthday in the same family is still normal to them.
    assert.equal(await seen(db, admin, "events", "id = $1", [f.birthday]), 1);
  });

  test("they cannot write into their own birthday's planning either", async () => {
    const idea = await probe(db, celebrant(),
      "select id from public.save_gift_idea(null, $1, 'Sneaky', 100, null, null, null)", [f.recipient]);
    // Either refused, or -- if the routine lets it through -- still unreadable.
    if (idea.ok) {
      assert.equal(await seen(db, celebrant(), "gift_ideas", "id = $1", [idea.rows[0].id]), 0);
    }
  });
});

// ===========================================================================
// 9. Writing across a family
// ===========================================================================

describe("nothing writes into a family it does not belong to", () => {
  test("a member of Alpha cannot add a person to Bravo", async () => {
    const result = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.create_person($1, null, null, null)", ["Intruder"]);
    // It succeeds -- into ALPHA, which is where they said they were acting.
    assert.equal(result.ok, true, result.error);
    await asOwner(db);
    const where = await value(db, "select area_id from public.people where id = $1", [result.rows[0].id]);
    assert.equal(where, f.areas.alpha);
    await db.query("delete from public.people where id = $1", [result.rows[0].id]);
  });

  test("a recipient cannot name a person from another family", async () => {
    await asOwner(db);
    const result = await attempt(db, `
      insert into public.christmas_recipients (christmas_event_id, person_id, budget_pennies)
      values ($1, $2, 1000)`, [f.birthday, f.people.sam]);
    assert.equal(result.ok, false);
    assert.match(result.error, /different Area/u);
  });

  test("a membership cannot name a person from another family", async () => {
    await asOwner(db);
    const result = await attempt(db, `
      insert into public.app_members (area_id, person_id, role, active, email)
      values ($1, $2, 'member', true, 'x@example.test')`, [f.areas.alpha, f.people.sam]);
    assert.equal(result.ok, false);
  });

  test("and an authenticated caller cannot push a row into another family", async () => {
    const result = await probe(db, who(f.users.jade, f.areas.alpha), `
      insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title)
      values ($1, 2027, 'From Alpha') returning id`, [f.people.sam]);
    assert.equal(result.ok, false);
  });
});

// ===========================================================================
// 10. Per-family uniqueness
// ===========================================================================

describe("uniqueness is per family, not per application", () => {
  test("two families may each have their own Christmas for the same year", async () => {
    const alphaXmas = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.create_event($1, 'christmas', $2, null, null, $3::uuid[], $4::uuid[])",
      ["Christmas 2027", "2027-12-25", [f.people.mo], [f.people.jade]]);
    assert.equal(alphaXmas.ok, true, alphaXmas.error);

    const bravoXmas = await probe(db, who(f.users.bravoadmin, f.areas.bravo),
      "select id from public.create_event($1, 'christmas', $2, null, null, $3::uuid[], $4::uuid[])",
      ["Christmas 2027", "2027-12-25", [f.people.jo], [f.people.sam]]);
    assert.equal(bravoXmas.ok, true, `Bravo must be allowed its own Christmas 2027: ${bravoXmas.error ?? ""}`);
  });

  test("but one family may not have two", async () => {
    const again = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.create_event($1, 'christmas', $2, null, null, $3::uuid[], $4::uuid[])",
      ["Christmas 2027 again", "2027-12-25", [f.people.mo], [f.people.jade]]);
    assert.equal(again.ok, false);
  });

  test("each family keeps its own single administrator", async () => {
    await asOwner(db);
    const perArea = await rows(db, `
      select area_id, count(*)::int n from public.app_members
      where role = 'admin' and active group by area_id`);
    for (const row of perArea) assert.equal(row.n, 1, `${row.area_id} must have exactly one administrator`);
  });

  test("and a family cannot be left with none", async () => {
    await asOwner(db);
    const result = await attempt(db,
      "update public.app_members set active = false where id = $1", [f.members.beaBravo]);
    assert.equal(result.ok, false);
    assert.match(result.error, /at least one active administrator/u);
  });
});

// ===========================================================================
// 11. What "one administrator per Area" actually costs
//
// Found by running migrations 034-038 rather than reading them. Neither of
// these is a security hole -- both fail closed -- and neither is introduced by
// 039 or 040. They are recorded here so the behaviour is a documented fact
// rather than a surprise, and so a later migration that fixes them has a test
// that changes.
// ===========================================================================

describe("one administrator per Area, and -- since Q2 -- a way to change it", () => {
  /*
   * WHAT THIS BLOCK USED TO SAY.
   *
   * Until migration 041 it recorded two dead ends, found by running the
   * migrations rather than reading them: an Area's administrator could never
   * be changed, in any order, by any route; and because of that, the
   * administrator's own birthday could not be planned by anybody at all.
   *
   * Both are fixed. The tests that pinned the limitations now pin the fix,
   * which is what pinning a limitation is for.
   */

  test("the immediate one-admin rule is gone, and a deferred one replaces it", async () => {
    await asOwner(db);
    // The index made a swap illegal at every instant. The constraint trigger
    // asks the same question at COMMIT, where a swap is a whole thing.
    assert.equal(
      await value(db, "select to_regclass('public.app_members_single_admin_per_area_idx')::text"),
      null);
    const deferred = await rows(db, `
      select tgdeferrable, tginitdeferred from pg_trigger
      where tgname = 'app_members_exactly_one_admin' and not tgisinternal`);
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].tgdeferrable, true);
    assert.equal(deferred[0].tginitdeferred, true);
  });

  test("the halves of a handover are still each illegal on their own", async () => {
    await asOwner(db);
    // Nothing has been loosened. Promoting a second administrator on its own
    // still fails, and so does demoting the only one -- they are legal only
    // together, inside one transaction.
    const promote = await attempt(db,
      "update public.app_members set role = 'admin' where id = $1", [f.members.taylorAlpha]);
    assert.equal(promote.ok, false, "a second administrator must not survive a commit");

    const demote = await attempt(db,
      "update public.app_members set role = 'member' where id = $1", [f.members.adaAlpha]);
    assert.equal(demote.ok, false, "and the last one must not be able to stand down");
    assert.match(demote.error, /at least one active administrator/u);
  });

  test("but the routine does both at once, and the family is never without one", async () => {
    const done = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.taylorAlpha]);
    assert.equal(done.ok, true, done.error);

    await asOwner(db);
    const roles = await rows(db, `
      select p.name, m.role from public.app_members m
      join public.people p on p.id = m.person_id
      where m.area_id = $1 order by p.name`, [f.areas.alpha]);
    const admins = roles.filter((row) => row.role === 'admin');
    assert.equal(admins.length, 1, "exactly one, still");
    assert.equal(admins[0].name, "Taylor");

    // Hand it back so the rest of the suite finds the family it expects.
    const back = await probe(db, who(f.users.taylor, f.areas.alpha),
      "select public.transfer_area_admin($1, $2)", [f.areas.alpha, f.members.adaAlpha]);
    assert.equal(back.ok, true, back.error);
  });

  test("and the administrator's own birthday can now be planned -- by somebody else", async () => {
    // `start_birthday_planning` accepts this Area's contributors as well as
    // its administrator, so Ada's birthday has a caller at last. She still is
    // not one: migration 031's guard refuses the celebrant, and 043 made that
    // guard resolve the reader inside the event's own Area.
    const bySelf = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.start_birthday_planning($1, $2, $3, 0, '[]'::jsonb)",
      [f.people.ada, "Ada 2030", "2030-09-09"]);
    assert.equal(bySelf.ok, false);
    assert.match(bySelf.error, /your own birthday/u);

    const byContributor = await probe(db, who(f.users.jade, f.areas.alpha),
      "select id from public.start_birthday_planning($1, $2, $3, 0, '[]'::jsonb)",
      [f.people.ada, "Ada 2030", "2030-09-09"]);
    assert.equal(byContributor.ok, true, byContributor.error);

    // And she still cannot see a thing about it.
    await asOwner(db);
    const event = await value(db,
      "select id from public.events where celebrant_person_id = $1 and event_date = '2030-09-09'",
      [f.people.ada]);
    assert.equal(await seen(db, who(f.users.dual, f.areas.alpha), "events", "id = $1", [event]), 0);
  });
});
// ===========================================================================
// 12. Why the Family Access route has to scope itself by hand
//
// It runs as the SERVICE ROLE, because it creates Auth accounts. These are the
// two facts that make explicit scoping the only boundary that route has -- and
// `scripts/areas-and-tenancy.test.mjs` then checks, operation by operation,
// that every query it makes carries one.
// ===========================================================================

describe("the service role has no boundary of its own", () => {
  test("it reads every family, including ones nobody asked about", async () => {
    const everyone = await probe(db, { user: null, role: "service_role" },
      "select count(distinct area_id)::int as n from public.people");
    assert.equal(everyone.ok, true);
    assert.ok(everyone.rows[0].n >= 4, "row level security does not narrow the service role");
  });

  test("and migration 037's write barrier exempts it too", async () => {
    // The exemption is written as "no auth.uid()", which is exactly the set of
    // callers with no membership to check. It is deliberate -- the dispatcher
    // and the reminder job need it -- and it is why a route using this role
    // must carry its own Area.
    const barrier = await probe(db, { user: null, role: "service_role" }, `
      insert into public.people (area_id, name) values ($1, 'Written across a boundary') returning id`,
    [f.areas.bravo]);
    assert.equal(barrier.ok, true, "the service role writes anywhere, by design");
    await asOwner(db);
    await db.query("delete from public.people where name = 'Written across a boundary'");
  });

  test("an ordinary member gets neither of those things", async () => {
    const read = await probe(db, who(f.users.mo, f.areas.alpha),
      "select count(distinct area_id)::int as n from public.people");
    assert.equal(read.rows[0].n, 1, "a member sees one family");

    const write = await probe(db, who(f.users.mo, f.areas.alpha), `
      insert into public.people (area_id, name) values ($1, 'Nope') returning id`, [f.areas.bravo]);
    assert.equal(write.ok, false, "and writes into none but their own");
  });
});

// ===========================================================================
// 13. The areas table: what actually stops a browser writing one
//
// Referenced by `docs/PHASE-5-POST-APPLY-CHECKS.sql`, which reports the
// left-over grant as INFO rather than FAIL on the strength of these.
// ===========================================================================

describe("an Area cannot be created or renamed from a browser", () => {
  test("the only policy on areas is a read", async () => {
    await asOwner(db);
    const policies = await rows(db, `
      select policyname, cmd from pg_policies
      where schemaname = 'public' and tablename = 'areas' order by policyname`);
    assert.deepEqual(policies.map((p) => p.cmd), ["SELECT"]);
  });

  test("a member holds a leftover INSERT grant -- and it buys nothing", async () => {
    /*
     * Supabase grants ALL on every new public table by default. Migration 034
     * revoked that from `anon` and only ADDED select for `authenticated`, so the
     * default INSERT is still there. It is untidy, and it is not a way in:
     * with row level security on and no write policy, the insert is refused.
     */
    await asOwner(db);
    const granted = await value(db, "select has_table_privilege('authenticated', 'public.areas', 'insert')");

    const insert = await probe(db, who(f.users.dual, f.areas.alpha),
      "insert into public.areas (name) values ('Sneaky') returning id");
    assert.equal(insert.ok, false, "row level security must refuse the insert whatever the grant says");
    assert.match(insert.error, /row-level security/u);

    // And the grant really is there, so the refusal above is doing the work.
    assert.equal(granted, true, "if this ever flips, the leftover grant was tidied up");
  });

  test("and renaming one from a browser changes nothing", async () => {
    const update = await probe(db, who(f.users.dual, f.areas.alpha),
      "update public.areas set name = 'Renamed' where id = $1 returning id", [f.areas.alpha]);
    assert.equal(update.count, 0, "no write policy means no row is visible to update");

    await asOwner(db);
    const stillCalled = await value(db, "select name from public.areas where id = $1", [f.areas.alpha]);
    assert.equal(stillCalled, "Alpha");
  });

  test("renaming goes through the routine, which checks the role", async () => {
    const byMember = await probe(db, who(f.users.mo, f.areas.alpha),
      "select public.set_area_name($1, 'Member renamed it')", [f.areas.alpha]);
    assert.equal(byMember.ok, false);
    assert.match(byMember.error, /administrator/u);

    const byAdmin = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_area_name($1, 'Alpha')", [f.areas.alpha]);
    assert.equal(byAdmin.ok, true, byAdmin.error);
  });
});
