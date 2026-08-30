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
import { readFileSync } from "node:fs";

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

  test("WITHOUT A CLAIM, A LOGIN IN SEVERAL FAMILIES IS ASKED WHICH ONE", async () => {
    /*
     * CHANGED BY MIGRATION 047, DELIBERATELY.
     *
     * 039 derived the Area from the PERSON so this worked with no acting-Area
     * header at all, and until 047 it did. 047 additionally requires the caller
     * to be STANDING in that Area, and `is_acting_area` answers the same way
     * `require_acting_area` has answered for the sixteen routines 045 hardened:
     * with no claim and more than one membership, there is no way to know which
     * family is meant, so the answer is no.
     *
     * In the browser this changes nothing -- the pre-request hook sets the
     * claim from the `gp_area` cookie on every request. What it closes is the
     * direct API call that carries no claim at all.
     */
    const result = await setBirthday(f.users.dual, undefined, f.people.mo, 8, 9);
    assert.equal(result.ok, false,
      "a login in two families, naming none, must not be guessed for");
  });

  test("but a login in exactly ONE family still needs no claim", async () => {
    // The other half of `is_acting_area`'s fallback, and the reason 047 does
    // not simply demand a header: where there is only one family it cannot be
    // ambiguous, and asking would be pedantry.
    const result = await setBirthday(f.users.bravoadmin, undefined, f.people.jo, 8, 9);
    assert.equal(result.ok, true, `one membership is not ambiguous: ${result.error ?? ""}`);
    await asOwner(db);
    assert.equal(await value(db, "select birthday_month from public.people where id = $1", [f.people.jo]), 8);
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

// ===========================================================================
// Q5. Removing a gift idea: the acting Area, and the purchase it paid for
// ===========================================================================

/*
 * MIGRATION 046, AND THE ONE WRITE 045 COULD NOT REACH.
 *
 * 045 put `require_acting_area()` at the top of sixteen routines. Removing a
 * gift idea was not one of them, because the application did not call a
 * routine -- it deleted the row directly, so its only boundary was this
 * table's DELETE policy, and that policy asked `is_area_member(...)`. That is
 * the right permission and the wrong question: a login belonging to two
 * families passes it in both. Measured on 001-045, the dual-Area account
 * standing in Bravo deleted Alpha's gift idea and nothing refused.
 *
 * The same delete cost history. `originating_gift_idea_id` is
 * `on delete set null`, so removing an idea somebody had already bought left
 * the purchase standing with its provenance quietly nulled.
 *
 * These are the direct-table attacks a browser can make against PostgREST,
 * not calls to the routine -- because a routine cannot defend a table.
 */
describe("Q5: a gift idea belongs to the family on screen", () => {
  /** A fresh idea in Alpha, owned by the fixture's Alpha recipient. */
  const freshIdea = async (title) => {
    const created = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.save_gift_idea(null, $1, $2, 500, null, null, null)", [f.recipient, title]);
    assert.equal(created.ok, true, created.error);
    return created.rows[0].id;
  };

  test("A DIRECT DELETE FROM THE WRONG FAMILY IS REFUSED", async () => {
    const idea = await freshIdea("Wrong-Area delete target");

    const attack = await probe(db, who(f.users.dual, f.areas.bravo),
      "delete from public.gift_ideas where id = $1 returning id", [idea]);

    assert.equal(attack.count, 0,
      "standing in Bravo deleted an Alpha gift idea: the acting Area is not being enforced");

    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.gift_ideas where id = $1", [idea]), 1);
  });

  test("A DIRECT UPDATE FROM THE WRONG FAMILY IS REFUSED", async () => {
    const idea = await freshIdea("Wrong-Area update target");

    const attack = await probe(db, who(f.users.dual, f.areas.bravo),
      "update public.gift_ideas set title = 'HIJACKED' where id = $1 returning id", [idea]);
    assert.equal(attack.count, 0, "standing in Bravo rewrote an Alpha gift idea");

    await asOwner(db);
    assert.equal(await value(db, "select title from public.gift_ideas where id = $1", [idea]),
      "Wrong-Area update target", "the title changed, so `using` let a foreign row be chosen");
  });

  test("AN UPDATE MAY NOT CARRY A ROW INTO ANOTHER FAMILY", async () => {
    /*
     * `with check`, not `using`. The two answer different questions -- which
     * rows may be chosen, and what they may become -- and a policy carrying
     * only the first would let a legitimate edit move a row into a family the
     * editor could never have selected it from.
     */
    const idea = await freshIdea("Stays in Alpha");

    const attack = await probe(db, who(f.users.dual, f.areas.alpha),
      "update public.gift_ideas set christmas_recipient_id = $2 where id = $1 returning id",
      [idea, f.bravoRecipient]);
    assert.equal(attack.count, 0, "an Alpha idea was moved into Bravo");

    await asOwner(db);
    assert.equal(
      await value(db, "select christmas_recipient_id from public.gift_ideas where id = $1", [idea]),
      f.recipient, "the idea changed family");
  });

  test("but the family it belongs to may still remove it", async () => {
    const idea = await freshIdea("Ordinary removal");

    const removed = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.remove_gift_idea($1)", [idea]);
    assert.equal(removed.ok, true, removed.error);

    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.gift_ideas where id = $1", [idea]), 0);
  });

  test("and the routine names the problem rather than failing silently", async () => {
    const idea = await freshIdea("Routine refusal");

    const refused = await probe(db, who(f.users.dual, f.areas.bravo),
      "select public.remove_gift_idea($1)", [idea]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /another family/u);
    assert.doesNotMatch(refused.error, /policy|row-level|constraint|relation/iu,
      "the refusal must read as a sentence, not as a database complaint");
  });
});

describe("Q5: an idea that was bought is the record of why", () => {
  test("A PURCHASED IDEA CANNOT BE DELETED, EVEN FROM ITS OWN FAMILY", async () => {
    await asOwner(db);
    const linkBefore = await value(db,
      "select originating_gift_idea_id from public.purchases where id = $1", [f.purchase]);
    assert.equal(linkBefore, f.secretIdea, "precondition: the fixture purchase came from the secret idea");

    const attack = await probe(db, who(f.users.dual, f.areas.alpha),
      "delete from public.gift_ideas where id = $1 returning id", [f.secretIdea]);
    assert.equal(attack.count, 0, "the idea a purchase came from was deleted");

    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.gift_ideas where id = $1", [f.secretIdea]), 1);
  });

  test("AND THE PURCHASE KEEPS ITS ORIGINATING IDEA", async () => {
    /*
     * The half of this that is easy to miss. `on delete set null` means the
     * purchase SURVIVES a deleted idea -- it just forgets what it was for.
     * Nothing raises; the money stays; the reason goes.
     */
    await asOwner(db);
    const link = await value(db,
      "select originating_gift_idea_id from public.purchases where id = $1", [f.purchase]);
    assert.equal(link, f.secretIdea,
      "the purchase lost its provenance, which is the history this rule exists to keep");
  });

  test("the routine explains the refusal in the product's own words", async () => {
    const refused = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.remove_gift_idea($1)", [f.secretIdea]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /already been bought/u);
    assert.doesNotMatch(refused.error, /SQLSTATE|constraint|foreign key|23503|relation/iu);
  });

  test("voiding the purchase releases the idea again", async () => {
    /*
     * The guard is about LIVE purchases. `void_purchase` is a soft reversal --
     * the row stays with `deleted_at` set -- so once the spending is withdrawn
     * the idea is an ordinary idea again. Anything stricter would strand it.
     */
    const created = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.save_gift_idea(null, $1, 'Releasable', 500, null, null, null)", [f.recipient]);
    assert.equal(created.ok, true, created.error);
    const newIdea = created.rows[0].id;

    await asOwner(db);
    const purchase = await value(db,
      "insert into public.purchases"
      + " (christmas_recipient_id, description, actual_price_pennies,"
      + "  checkout_payer_contributor_id, created_by_app_member_id, originating_gift_idea_id)"
      + " values ($1, 'Releasable buy', 500, $2, $3, $4) returning id",
      [f.recipient, f.jadeContributor, f.members.jadeAlpha, newIdea]);

    const blocked = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.remove_gift_idea($1)", [newIdea]);
    assert.equal(blocked.ok, false, "a live purchase must hold the idea in place");

    await asOwner(db);
    await db.query("update public.purchases set deleted_at = now() where id = $1", [purchase]);

    const allowed = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.remove_gift_idea($1)", [newIdea]);
    assert.equal(allowed.ok, true, allowed.error);
  });
});

describe("Q5: the celebrant cannot write the secrets they cannot read", () => {
  /** The fixture's own-birthday celebrant, standing in their own family. */
  const celebrant = () => who(f.users.taylor, f.areas.alpha);

  test("THEY CANNOT DELETE A SECRET IDEA BY NAMING ITS ID", async () => {
    const attack = await probe(db, celebrant(),
      "delete from public.gift_ideas where id = $1 returning id", [f.secretIdea]);
    assert.equal(attack.count, 0, "the celebrant deleted a secret for their own birthday");

    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.gift_ideas where id = $1", [f.secretIdea]), 1);
  });

  test("THEY CANNOT EDIT ONE EITHER", async () => {
    await asOwner(db);
    const before = await value(db, "select title from public.gift_ideas where id = $1", [f.secretIdea]);

    const attack = await probe(db, celebrant(),
      "update public.gift_ideas set title = 'Tell me' where id = $1 returning id", [f.secretIdea]);
    assert.equal(attack.count, 0, "the celebrant rewrote a secret for their own birthday");

    await asOwner(db);
    assert.equal(await value(db, "select title from public.gift_ideas where id = $1", [f.secretIdea]), before);
  });

  test("and the routine refuses without confirming the idea exists", async () => {
    const refused = await probe(db, celebrant(),
      "select public.remove_gift_idea($1)", [f.secretIdea]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /could not be found/u,
      "telling the celebrant it exists but is not theirs is itself the disclosure");
  });
});

// ===========================================================================
// Q5. The braces, tested without the belt
// ===========================================================================

/*
 * WHY THIS BLOCK EXISTS.
 *
 * 046 does two things to the raw delete path: it takes back the table GRANT
 * that made the path reachable, and it tightens the POLICY that governs it.
 * The grant is the belt and it is the one doing the work today -- which means
 * every test above passes whatever the policy says, because permission is
 * refused before a policy is ever consulted.
 *
 * That is a comfortable place for a mistake to hide. A future migration that
 * hands `delete` back -- to "fix" some other screen -- would silently restore
 * the original bug, and nothing here would have noticed, because nothing here
 * was ever asking the policy a question.
 *
 * So this block hands the grant back on purpose, asks the policy directly, and
 * takes it away again. Every assertion below is about the policy alone.
 */
describe("Q5: if the delete grant ever comes back, the policy still refuses", () => {
  before(async () => {
    await asOwner(db);
    await db.query("grant delete on table public.gift_ideas to authenticated");
  });

  after(async () => {
    await asOwner(db);
    await db.query("revoke delete on table public.gift_ideas from authenticated");
  });

  const freshIdea = async (title) => {
    const created = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.save_gift_idea(null, $1, $2, 500, null, null, null)", [f.recipient, title]);
    assert.equal(created.ok, true, created.error);
    return created.rows[0].id;
  };

  test("THE POLICY REFUSES A DELETE FROM THE WRONG FAMILY", async () => {
    const idea = await freshIdea("Policy: wrong family");

    // The grant is present, so this reaches the policy. Anything other than
    // zero rows means the acting Area is not in the policy any more.
    const attack = await probe(db, who(f.users.dual, f.areas.bravo),
      "delete from public.gift_ideas where id = $1 returning id", [idea]);
    assert.equal(attack.count, 0,
      "with the grant restored, the policy alone let a foreign delete through");

    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.gift_ideas where id = $1", [idea]), 1);
  });

  test("THE POLICY REFUSES A DELETE OF A PURCHASED IDEA", async () => {
    const attack = await probe(db, who(f.users.dual, f.areas.alpha),
      "delete from public.gift_ideas where id = $1 returning id", [f.secretIdea]);
    assert.equal(attack.count, 0, "the provenance guard is not in the policy");

    await asOwner(db);
    assert.equal(
      await value(db, "select originating_gift_idea_id from public.purchases where id = $1", [f.purchase]),
      f.secretIdea, "the purchase lost its reason");
  });

  test("THE POLICY REFUSES THE CELEBRANT DELETING THEIR OWN BIRTHDAY SECRET", async () => {
    /*
     * An UNBOUGHT idea, deliberately. The fixture's `secretIdea` has a purchase
     * hanging off it, so the provenance guard refuses it too -- and a test that
     * used it would pass even with the celebrant exclusion taken out, which is
     * exactly what it is supposed to be measuring. This one is refused by the
     * celebrant rule or not at all.
     */
    const idea = await freshIdea("Policy: celebrant, unbought");

    const attack = await probe(db, who(f.users.taylor, f.areas.alpha),
      "delete from public.gift_ideas where id = $1 returning id", [idea]);
    assert.equal(attack.count, 0, "the celebrant exclusion is not in the delete policy");

    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.gift_ideas where id = $1", [idea]), 1);
  });

  test("and still allows an ordinary delete in the right family", async () => {
    // The negative controls above are only worth something if the positive one
    // works: a policy that refuses everything would pass all three.
    const idea = await freshIdea("Policy: ordinary");
    const allowed = await probe(db, who(f.users.dual, f.areas.alpha),
      "delete from public.gift_ideas where id = $1 returning id", [idea]);
    assert.equal(allowed.count, 1, allowed.error ?? "the policy refuses a legitimate delete");
  });

  test("the grant really is the belt: without it, permission is refused first", async () => {
    /*
     * Proves the pairing rather than assuming it. With the grant taken away
     * again the same legitimate delete fails on permission, which is why the
     * four tests above had to hand it back to say anything about the policy.
     */
    const idea = await freshIdea("Policy: belt check");
    await asOwner(db);
    await db.query("revoke delete on table public.gift_ideas from authenticated");

    const refused = await probe(db, who(f.users.dual, f.areas.alpha),
      "delete from public.gift_ideas where id = $1 returning id", [idea]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /permission denied/u);

    await asOwner(db);
    await db.query("grant delete on table public.gift_ideas to authenticated");
  });
});

// ===========================================================================
// Q5. A purchase's allocation is history, and history does not move
// ===========================================================================

/*
 * THE INVARIANT EVERYTHING DOWNSTREAM RESTS ON.
 *
 * `purchase_allocations` is who owes what for one gift, decided at the moment
 * it was bought. Owed, the payment log and every settlement read it. So a
 * change to who contributes must apply to the NEXT purchase and never to one
 * already made -- otherwise last year's balances quietly rewrite themselves
 * when somebody joins or leaves the pool this year.
 *
 * The database already had the pieces: `save_purchase` refuses an inactive
 * contributor on a NEW purchase, and nothing anywhere updates an existing
 * allocation row. What was missing was a test that says so, run against a real
 * PostgreSQL rather than inferred from reading the routine.
 */
describe("Q5: contributor changes do not rewrite an existing purchase", () => {
  let event;
  let recipientForBuying;
  let jade;
  let mo;
  let firstPurchase;

  before(async () => {
    await asOwner(db);
    event = await value(db,
      "select christmas_event_id from public.christmas_recipients where id = $1", [f.recipient]);

    /*
     * Bought FOR the administrator's own birthday recipient rather than the
     * celebrant's: `f.recipient` is Taylor's own birthday, and the celebrant
     * privacy rules would (correctly) get in the way of reading back what was
     * written. This block is about money, not secrecy.
     */
    recipientForBuying = f.adminRecipient;
    event = await value(db,
      "select christmas_event_id from public.christmas_recipients where id = $1", [recipientForBuying]);

    // That event is set up deliberately with NO contributors, so this block
    // elects the one it needs. Jade is an ordinary Alpha family member.
    const elected = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.set_event_contributor($1, $2, true)", [event, f.people.jade]);
    assert.equal(elected.ok, true, elected.error);
    jade = elected.rows[0].id;
  });

  test("a purchase is made with the contributors active at the time", async () => {
    assert.ok(jade, "precondition: Jade contributes to this event");

    const made = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.save_purchase_with_location("
      + "null, $1, 'Bookshelf', 4000, $2, null, current_date, null, null,"
      + " 'purchased', 'custom', null, $3::jsonb)",
      [recipientForBuying, jade,
        JSON.stringify([{ contributor_id: jade, responsibility_pennies: 4000 }])]);
    assert.equal(made.ok, true, made.error);
    firstPurchase = made.rows[0].id;

    await asOwner(db);
    const split = await rows(db,
      "select contributor_id, responsibility_pennies from public.purchase_allocations where purchase_id = $1",
      [firstPurchase]);
    assert.deepEqual(split, [{ contributor_id: jade, responsibility_pennies: 4000 }]);
  });

  test("THEN SOMEBODY ELSE BECOMES A CONTRIBUTOR", async () => {
    const elected = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.set_event_contributor($1, $2, true)", [event, f.people.mo]);
    assert.equal(elected.ok, true, elected.error);
    mo = elected.rows[0].id;

    await asOwner(db);
    assert.equal(
      await value(db, "select active from public.contributors where id = $1", [mo]), true);
  });

  test("AND THE PURCHASE ALREADY MADE IS UNTOUCHED", async () => {
    await asOwner(db);
    const split = await rows(db,
      "select contributor_id, responsibility_pennies from public.purchase_allocations where purchase_id = $1",
      [firstPurchase]);
    assert.deepEqual(split, [{ contributor_id: jade, responsibility_pennies: 4000 }],
      "electing a contributor rewrote an allocation that had already been decided");
    assert.equal(
      await value(db, "select actual_price_pennies from public.purchases where id = $1", [firstPurchase]),
      4000, "and the price moved too");
  });

  test("while a NEW purchase may use the new contributor", async () => {
    const made = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.save_purchase_with_location("
      + "null, $1, 'Lamp', 3000, $2, null, current_date, null, null,"
      + " 'purchased', 'custom', null, $3::jsonb)",
      [recipientForBuying, jade,
        JSON.stringify([
          { contributor_id: jade, responsibility_pennies: 1000 },
          { contributor_id: mo, responsibility_pennies: 2000 },
        ])]);
    assert.equal(made.ok, true, made.error);

    await asOwner(db);
    const split = await rows(db,
      "select contributor_id, responsibility_pennies from public.purchase_allocations"
      + " where purchase_id = $1 order by responsibility_pennies", [made.rows[0].id]);
    assert.equal(split.length, 2, "the current contributor set applies to what happens next");
  });

  test("AND REMOVING A CONTRIBUTOR STILL DOES NOT REWRITE THE OLD ONE", async () => {
    /*
     * The direction that matters most. Somebody leaving the pool must not
     * evaporate their share of a gift that was already bought and may already
     * have been paid for.
     */
    const removed = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.set_event_contributor($1, $2, false)", [event, f.people.mo]);
    assert.equal(removed.ok, true, removed.error);

    await asOwner(db);
    const split = await rows(db,
      "select contributor_id, responsibility_pennies from public.purchase_allocations where purchase_id = $1",
      [firstPurchase]);
    assert.deepEqual(split, [{ contributor_id: jade, responsibility_pennies: 4000 }]);

    const stillOwed = await value(db,
      "select count(*)::int from public.purchase_allocations where contributor_id = $1", [mo]);
    assert.equal(stillOwed, 1,
      "deactivating a contributor deleted the share they had already taken on");
  });

  test("a NEW purchase may not name the contributor who has left", async () => {
    const made = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.save_purchase_with_location("
      + "null, $1, 'Rug', 2000, $2, null, current_date, null, null,"
      + " 'purchased', 'custom', null, $3::jsonb)",
      [recipientForBuying, jade,
        JSON.stringify([{ contributor_id: mo, responsibility_pennies: 2000 }])]);
    assert.equal(made.ok, false, "an inactive contributor took on new responsibility");
    assert.match(made.error, /belong to this Christmas|contributor/iu);
  });

  test("and money is only ever whole pennies", async () => {
    /*
     * The split must equal the price exactly, and both are integers. A float
     * anywhere in this chain is a rounding error that becomes somebody's debt.
     */
    const short = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.save_purchase_with_location("
      + "null, $1, 'Short split', 1000, $2, null, current_date, null, null,"
      + " 'purchased', 'custom', null, $3::jsonb)",
      [recipientForBuying, jade,
        JSON.stringify([{ contributor_id: jade, responsibility_pennies: 999 }])]);
    assert.equal(short.ok, false, "a split that does not add up to the price was accepted");
    assert.match(short.error, /equal the purchase price/u);

    const fractional = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.save_purchase_with_location("
      + "null, $1, 'Fractional', 1000, $2, null, current_date, null, null,"
      + " 'purchased', 'custom', null, $3::jsonb)",
      [recipientForBuying, jade,
        JSON.stringify([{ contributor_id: jade, responsibility_pennies: 999.5 }])]);
    assert.equal(fractional.ok, false, "a fractional penny was accepted");
  });
});

// ===========================================================================
// Q6. The person routines: entitled there, AND standing there
// ===========================================================================

/*
 * MIGRATION 047, AND WHY 044 WAS NOT ENOUGH.
 *
 * 044 hardened these routines by deriving the Area FROM THE PERSON and asking
 * `is_area_admin(target_area)`. That is the right question about permission
 * and the wrong question about place:
 *
 *     "Am I an administrator of this person's family?"  -> of Alpha, yes.
 *     "...and is Alpha the family I am STANDING IN?"    -> never asked.
 *
 * 045 closed exactly this gap for sixteen routines and did not revisit these,
 * because 044 had already made them Area-aware -- and Area-aware is not the
 * same as acting-Area-aware. Measured on 001-046, the account that administers
 * Alpha and merely belongs to Bravo renamed an Alpha person, made them a
 * contributor, archived them and changed their birthday, all from Bravo.
 *
 * These are direct RPC calls, which is the shape a browser makes against
 * PostgREST. Not privilege escalation -- that account really does administer
 * Alpha -- but a breach of the rule the whole application rests on.
 */
describe("Q6: a person is edited from the family you are standing in", () => {
  /** The four routines, each as the browser would call it. */
  const ROUTINES = [
    ["set_family_contributor", "select public.set_family_contributor($1, true)"],
    ["set_person_name", "select public.set_person_name($1, 'Renamed From Bravo')"],
    ["set_person_archived", "select public.set_person_archived($1, true)"],
    ["set_person_birthday", "select public.set_person_birthday($1, 3::smallint, 14::smallint, 1990::smallint)"],
  ];

  /** Undo anything a passing test leaves behind, so order cannot matter. */
  const restore = async () => {
    await asOwner(db);
    await db.query(
      "update public.people set name = 'Mo', is_family_contributor = false, archived_at = null,"
      + " birthday_month = null, birthday_day = null, birthday_year = null where id = $1",
      [f.people.mo]);
  };

  /*
   * TWO WRONG PLACES TO STAND, AND CHARLIE IS THE ONE THAT MATTERS.
   *
   * In BRAVO this login is an ordinary member, so a refusal there could be the
   * ADMIN check doing the work and prove nothing about place. In CHARLIE the
   * same login is a genuine ADMINISTRATOR -- `is_area_admin` is not what stops
   * it, because the caller is not asking about Charlie's rights at all. Only
   * the acting-Area question can refuse that one, which is why it is first.
   */
  const WRONG_PLACES = [
    ["CHARLIE, where this login is a real ADMINISTRATOR", () => f.areas.charlie],
    ["BRAVO, where it is only a member", () => f.areas.bravo],
  ];

  for (const [name, sql] of ROUTINES) {
    for (const [where, area] of WRONG_PLACES) {
      test(`${name.toUpperCase()} IS REFUSED FROM ${where}`, async () => {
        await restore();

        const attack = await probe(db, who(f.users.dual, area()), sql, [f.people.mo]);
        assert.equal(attack.ok, false,
          `${name} wrote to Alpha while the caller was standing in ${where}`);
        assert.match(attack.error, /administrator|contributors/u,
          "and it must come back as the routine own refusal, not a new sentence");
        assert.doesNotMatch(attack.error, /another family/u,
          "a distinct message would turn any uuid into a question about other families");

        await asOwner(db);
        const person = await value(db,
          "select json_build_object('name', name, 'contributor', is_family_contributor,"
          + " 'archived', archived_at is not null, 'month', birthday_month)::text"
          + " from public.people where id = $1", [f.people.mo]);
        assert.equal(person,
          '{"name" : "Mo", "contributor" : false, "archived" : false, "month" : null}',
          "the Alpha person changed");
      });
    }
  }

  test("A REFUSED CROSS-AREA CALL WRITES NOTHING TO THE AUDIT LOG", async () => {
    // A refusal that logged would itself be a way to write into another
    // family's log from outside it.
    await restore();
    await asOwner(db);
    const before = await value(db, "select count(*)::int from public.audit_log");
    await probe(db, who(f.users.dual, f.areas.charlie),
      "select public.set_person_birthday($1, 7::smallint, 7::smallint, null)", [f.people.mo]);
    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.audit_log"), before,
      "a refused cross-Area call left a row in the audit log");
  });

  test("and a legitimate birthday change is still audited exactly as before", async () => {
    // 026's `audit_people_birthday` fires on update of the birthday columns.
    // 047 must not have moved the guard somewhere that suppresses it.
    await restore();
    await asOwner(db);
    const before = await value(db, "select count(*)::int from public.audit_log");
    const ok = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_birthday($1, 4::smallint, 2::smallint, null)", [f.people.mo]);
    assert.equal(ok.ok, true, ok.error);
    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.audit_log"), before + 1,
      "the birthday audit row stopped being written");
    await restore();
  });

  test("BUT ALL FOUR STILL WORK FROM THE FAMILY THE PERSON IS IN", async () => {
    await restore();
    for (const [name, sql] of ROUTINES) {
      const allowed = await probe(db, who(f.users.dual, f.areas.alpha), sql, [f.people.mo]);
      assert.equal(allowed.ok, true, `${name} refused a legitimate call: ${allowed.error}`);
    }
    await restore();
  });

  test("BELONGING TO BOTH FAMILIES DOES NOT WEAKEN IT", async () => {
    /*
     * The difficulty of this defect in one test. This login is an ADMINISTRATOR
     * of Alpha -- `is_area_admin(alpha)` is true for them, legitimately, and
     * that is exactly what 044 was asking. Being entitled in Alpha is not
     * permission to act on Alpha while standing in Bravo.
     */
    await restore();
    await asOwner(db);
    const adminsAlpha = await value(db,
      "select count(*)::int from public.app_members where user_id = $1 and area_id = $2 and role = 'admin' and active",
      [f.users.dual, f.areas.alpha]);
    assert.equal(adminsAlpha, 1, "precondition: this login really does administer Alpha");

    const attack = await probe(db, who(f.users.dual, f.areas.bravo),
      "select public.set_family_contributor($1, true)", [f.people.mo]);
    assert.equal(attack.ok, false);
    await restore();
  });

  test("and an ordinary member is still refused the administrator's routines", async () => {
    // 047 adds a place check above the role check; it must not have replaced it.
    await restore();
    for (const [name, sql] of ROUTINES.filter(([n]) => n !== "set_person_birthday")) {
      const asMember = await probe(db, who(f.users.mo, f.areas.alpha), sql, [f.people.mo]);
      assert.equal(asMember.ok, false, `${name} let a plain member through`);
      assert.match(asMember.error, /administrator/u);
    }
    await restore();
  });

  test("validation and the returned row are unchanged", async () => {
    await restore();
    const emptyName = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_name($1, '   ')", [f.people.mo]);
    assert.equal(emptyName.ok, false);
    assert.match(emptyName.error, /Enter a valid name/u);

    const badMonth = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_birthday($1, 13::smallint, 1::smallint, null)", [f.people.mo]);
    assert.equal(badMonth.ok, false);
    assert.match(badMonth.error, /between January and December/u);

    const nullFlag = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_family_contributor($1, null)", [f.people.mo]);
    assert.equal(nullFlag.ok, false);
    assert.match(nullFlag.error, /Choose whether this person may contribute/u);

    const shape = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.set_person_name($1, 'Mo')).name as n", [f.people.mo]);
    assert.equal(shape.ok, true, shape.error);
    assert.equal(shape.rows[0].n, "Mo", "the routine still returns the people row");
    await restore();
  });

  test("a person who does not exist gets the same answer as one you may not touch", async () => {
    /*
     * `is_acting_area(null)` returns TRUE, deliberately -- mirroring
     * `require_acting_area`, which returns rather than raising on a null Area.
     * So "no such person" falls through to the routine's own conflated refusal
     * instead of gaining a sentence of its own. Distinguishing the two would
     * let somebody enumerate other families by id.
     */
    const missing = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_person_name($1, 'Ghost')", ["00000000-0000-4000-8000-000000000000"]);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /administrator/u);
    assert.doesNotMatch(missing.error, /another family/u,
      "a missing person must not be reported as belonging elsewhere");
  });
});

describe("Q6: the routines deliberately left unguarded", () => {
  /*
   * Recorded so the classification is executable rather than a claim in a
   * migration header. Each of these lacks `require_acting_area` on purpose.
   */
  test("start_birthday_planning refuses a cross-Area celebrant in its own words", async () => {
    const r = await probe(db, who(f.users.dual, f.areas.bravo),
      "select public.start_birthday_planning($1, 'X', '2028-03-14', 1000, $2::jsonb)",
      [f.people.jade, JSON.stringify([{ person_id: f.people.jade, pennies: 1000 }])]);
    assert.equal(r.ok, false);
    assert.match(r.error, /different Area/u);
  });

  test("the creators are gated by the ACTING Area's admin question", async () => {
    // `is_app_admin()` has answered about the acting Area since 038, so a
    // creator needs no target guard: there is no existing object to target.
    for (const sql of [
      "select public.create_person('Probe', null, null, null)",
      "select public.create_event('Probe','other','2029-01-01',null,null,'{}'::uuid[],'{}'::uuid[])",
    ]) {
      const r = await probe(db, who(f.users.dual, f.areas.bravo), sql, []);
      assert.equal(r.ok, false, `${sql.slice(0, 40)} was allowed in a family the caller does not administer`);
      assert.match(r.error, /Global Admin access required/u);
    }
  });

  test("and a creator cannot NAME another family's people either", async () => {
    /*
     * The sharp version of the question. Standing in CHARLIE, where this login
     * really is an administrator, `is_app_admin()` says yes -- so if anything
     * refuses an event built out of ALPHA people, it is 035's
     * `refuse_cross_area_person` trigger and not the role check. That is why
     * the creators need no acting-Area guard of their own: the integrity
     * trigger already refuses to let a created row reach across.
     */
    for (const [what, sql, params] of [
      ["recipient", "select public.create_event('Probe','other','2029-01-01',null,null,$1::uuid[],'{}'::uuid[])", [[f.people.mo]]],
      ["contributor", "select public.create_event('Probe','other','2029-01-01',null,null,'{}'::uuid[],$1::uuid[])", [[f.people.jade]]],
      ["celebrant", "select public.create_event('Probe','birthday','2029-01-01',null,$1,'{}'::uuid[],'{}'::uuid[])", [f.people.taylor]],
    ]) {
      const r = await probe(db, who(f.users.dual, f.areas.charlie), sql, params);
      assert.equal(r.ok, false, `create_event pulled an Alpha ${what} into a Charlie event`);
      assert.match(r.error, /different Area/u);
    }

    // The control: the same call with Charlie's own person must still work, or
    // the assertions above would pass for the wrong reason.
    const ownFamily = await probe(db, who(f.users.dual, f.areas.charlie),
      "select public.create_event('Probe','other','2029-01-01',null,null,$1::uuid[],'{}'::uuid[])", [[f.people.cass]]);
    assert.equal(ownFamily.ok, true, `a legitimate Charlie event was refused: ${ownFamily.error}`);
  });

  test("claim_app_member takes no id, and must stay reachable from anywhere", async () => {
    /*
     * It matches only the caller's OWN email on an unclaimed row. Guarding it
     * by acting Area would break the thing it exists for: claiming an
     * invitation to a family you are not yet standing in.
     */
    const r = await probe(db, who(f.users.dual, f.areas.bravo), "select public.claim_app_member()", []);
    assert.equal(r.ok, true, "claiming an invitation must not depend on where you are standing");
  });
});

/**
 * ---------------------------------------------------------------------------
 * Q10: THE ACTIVITY LOG IS ABOUT THE FAMILY YOU ARE STANDING IN.
 * ---------------------------------------------------------------------------
 *
 * `audit_log`'s policy is `is_active_app_member() AND is_area_member(area_id)`.
 * That asks which families you BELONG to -- not which one you are STANDING IN.
 * For a login with one family the two questions have the same answer, which is
 * why this went unnoticed; for a login with several they diverge completely.
 *
 * `/more/activity` asked only the policy, with no Area on the query, and its
 * comment said so: "RLS on audit_log returns rows to active members and nobody
 * else, so the database is the whole enforcement." True about tenancy, and the
 * wrong question about place.
 *
 * MEASURED IN LIVE Q10 BROWSER QA, with the acting-Area cookie asserted at the
 * moment of each read: standing in the real family and standing in a QA Area
 * both returned the SAME three hundred entries, byte for byte -- zero unique to
 * either. QA rows appeared in the real family's Activity screen and the real
 * family's rows appeared in QA's.
 *
 * NOT A CROSS-TENANT LEAK, and the first test below is what says so: a member
 * of one family alone still sees nothing of the other. The defect is the
 * acting-Area rule being skipped for an account that belongs to both.
 */
describe("Q10: the activity log answers about the acting Area, not every membership", () => {
  test("a member of ONE family still sees only that family -- no tenant leak", async () => {
    // `users.taylor` belongs to Alpha and nowhere else.
    const result = await probe(db, who(f.users.taylor, f.areas.alpha),
      "select distinct area_id from public.audit_log");
    assert.ok(result.ok, "the read itself is allowed");
    assert.ok(result.rows.length > 0, "there is activity in Alpha to see");
    const areas = new Set(result.rows.map((row) => row.area_id));
    assert.deepEqual([...areas], [f.areas.alpha],
      "a single-family member sees their own family's activity and nothing else");
  });

  test("THE DEFECT: an unscoped read by a DUAL member spans both families", async () => {
    /*
     * `users.dual` administers Alpha and belongs to Bravo. This is the query
     * the screen used to send -- no Area on it, exactly as written.
     */
    const unscoped = await probe(db, who(f.users.dual, f.areas.alpha),
      "select distinct area_id from public.audit_log");
    assert.ok(unscoped.ok, "the read itself is allowed");
    const areas = new Set(unscoped.rows.map((row) => row.area_id));
    assert.ok(areas.size > 1,
      "with no Area on the query a dual member sees more than one family -- the defect");
    assert.ok(areas.has(f.areas.bravo),
      "including Bravo, while standing in Alpha");
  });

  test("AND THE FIX: the same reader, narrowed to the acting Area, sees one", async () => {
    const scoped = await probe(db, who(f.users.dual, f.areas.alpha),
      "select distinct area_id from public.audit_log where area_id = $1", [f.areas.alpha]);
    assert.ok(scoped.ok, "the read itself is allowed");
    assert.ok(scoped.rows.length > 0, "Alpha's own activity is still there");
    const areas = new Set(scoped.rows.map((row) => row.area_id));
    assert.deepEqual([...areas], [f.areas.alpha],
      "and nothing from the family they are not standing in");
  });

  test("the rule is symmetric: standing in Bravo shows Bravo", async () => {
    const scoped = await probe(db, who(f.users.dual, f.areas.bravo),
      "select distinct area_id from public.audit_log where area_id = $1", [f.areas.bravo]);
    assert.ok(scoped.ok, "the read itself is allowed");
    const areas = new Set(scoped.rows.map((row) => row.area_id));
    assert.ok(areas.size <= 1, "one family at most");
    if (areas.size === 1) {
      assert.deepEqual([...areas], [f.areas.bravo],
        "so this is a rule, not a special case for Alpha");
    }
  });

  test("and the screen really does send the Area now", () => {
    const source = readFileSync(
      new URL("../src/app/more/activity/activity-client.tsx", import.meta.url),
      "utf8",
    ).replace(/\r\n/gu, "\n");

    assert.match(
      source,
      /\.from\("audit_log"\)[\s\S]{0,400}?\.eq\("area_id", activeAreaId\)/u,
      "the activity read must be narrowed to the acting Area",
    );
    assert.match(
      source,
      /if \(!activeAreaId\) \{/u,
      "and must not read at all before the Area is known, or it renders the wrong family first",
    );
  });
});
