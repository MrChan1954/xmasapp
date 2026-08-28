/**
 * WHO GETS TOLD, AND WHY IT IS NOT EVERYBODY.
 *
 * THE BUG THIS FILE EXISTS FOR. `loadFamilyContext` builds a notification
 * audience through the ADMIN client, deliberately: row level security would
 * hide the very memberships the dispatcher needs in order to work out who to
 * leave OUT. That makes its `areaId` argument the only thing standing between
 * one family's news and every other family's phones -- and it defaults to
 * `null`, which means "every membership in the database".
 *
 * Both dispatch paths omitted it. Measured against the real production
 * database on 2026-08-28: two gift ideas added inside one QA Area produced
 * FIFTEEN notifications across FOUR Areas -- eight of them delivered to a
 * different family's members, titled "New gift idea for <person>", naming
 * somebody those readers have no relationship to and linking to an event they
 * cannot open.
 *
 * `notification-security.test.mjs` pins the CALL SITES: every call passes an
 * Area. This file pins the PREDICATE: that the Area, once passed, actually
 * excludes the other families -- and that the Area is derived from the subject
 * rather than from whoever happened to be acting.
 *
 * RUN, NOT READ. Every assertion below executes against a real PostgreSQL with
 * all forty-five migrations applied and two families in it.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";

import { buildRehearsal, asOwner, rows } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

let db;
let f;

before(async () => { db = await buildRehearsal({}); f = await buildTwoFamilies(db); });
after(async () => { await db?.close(); });

/**
 * The audience read, exactly as `loadFamilyContext` issues it.
 *
 *   areaId ? ...eq("active", true).eq("area_id", areaId)
 *          : ...eq("active", true)
 *
 * Passing `null` here reproduces the defaulted argument, which is the bug.
 */
const audience = async (areaId) => {
  await asOwner(db);
  return rows(
    db,
    areaId
      ? "select id, person_id, area_id from public.app_members where active = true and area_id = $1"
      : "select id, person_id, area_id from public.app_members where active = true",
    areaId ? [areaId] : undefined,
  );
};

/** Where a gift idea really lives: idea -> recipient -> event -> Area. */
const areaOfGiftIdea = async (giftIdeaId) => {
  await asOwner(db);
  const found = await rows(
    db,
    `select e.area_id
       from public.gift_ideas g
       join public.christmas_recipients r on r.id = g.christmas_recipient_id
       join public.events e on e.id = r.christmas_event_id
      where g.id = $1`,
    [giftIdeaId],
  );
  return found[0] ? found[0].area_id : null;
};

describe("a notification audience is one family, and the subject chooses which", () => {
  test("THE AREA COMES FROM THE SUBJECT, never from whoever is acting", async () => {
    /*
     * The idea was written by Jade, acting in Alpha, about an Alpha event. The
     * interesting part is not that it resolves to Alpha -- it is that the
     * resolution walks the DATA, so no claim made by a caller can move it.
     */
    const area = await areaOfGiftIdea(f.secretIdea);
    assert.equal(area, f.areas.alpha, "a gift idea resolves to the Area of its own event");

    assert.notEqual(area, f.areas.bravo, "and never the Area of an unrelated family");
    assert.notEqual(area, f.areas.charlie, "nor another Area the author happens to administer");
  });

  test("SCOPED TO THAT AREA, THE OTHER FAMILIES ARE NOT IN THE AUDIENCE", async () => {
    const area = await areaOfGiftIdea(f.secretIdea);
    const scoped = await audience(area);

    assert.ok(scoped.length > 0, "the subject's own family is still told");
    for (const member of scoped) {
      assert.equal(member.area_id, f.areas.alpha,
        "every member of a scoped audience belongs to the subject's Area");
    }

    const foreign = scoped.filter((m) => m.area_id === f.areas.bravo || m.area_id === f.areas.charlie);
    assert.deepEqual(foreign, [], "no Bravo or Charlie membership is in an Alpha audience");
  });

  test("THE REGRESSION ITSELF: unscoped, the audience is every family there is", async () => {
    /*
     * This is what the defaulted argument did. It is asserted rather than
     * merely described, so that if somebody ever makes the unscoped read safe
     * by some other means, this test fails and gets re-thought rather than
     * quietly protecting nothing.
     */
    const unscoped = await audience(null);
    const areasReached = new Set(unscoped.map((m) => m.area_id));

    assert.ok(areasReached.size > 1,
      "an unscoped audience reaches more than one family -- which is the bug");
    assert.ok(areasReached.has(f.areas.bravo),
      "including a family with no connection to the subject at all");

    const scoped = await audience(f.areas.alpha);
    assert.ok(unscoped.length > scoped.length,
      `unscoped (${unscoped.length}) must be strictly larger than scoped (${scoped.length})`);
  });

  test("AN ACTOR WHO BELONGS TO SEVERAL FAMILIES DOES NOT WIDEN THE AUDIENCE", async () => {
    /*
     * `users.dual` administers Alpha AND Charlie and is a member of Bravo. The
     * realistic accident is an audience drawn from "the Areas this account can
     * see" rather than "the Area this row is in" -- which for a real
     * administrator means the whole database.
     */
    await asOwner(db);
    const dualMemberships = await rows(
      db,
      "select area_id from public.app_members where user_id = $1 and active = true",
      [f.users.dual],
    );
    const dualAreas = new Set(dualMemberships.map((m) => m.area_id));
    assert.ok(dualAreas.size >= 2,
      "the fixture account really does belong to more than one family");

    // The audience for an Alpha subject is Alpha's, no matter who acted.
    const scoped = await audience(f.areas.alpha);
    const reached = new Set(scoped.map((m) => m.area_id));
    assert.deepEqual([...reached], [f.areas.alpha],
      "the actor's other memberships add nobody to the audience");
  });

  test("A THIRD FAMILY IS NEVER TOLD merely because the actor also belongs there", async () => {
    const scoped = await audience(f.areas.alpha);
    const charlieMembers = scoped.filter((m) => m.area_id === f.areas.charlie);
    assert.deepEqual(charlieMembers, [],
      "Charlie hears nothing about Alpha's planning, though the actor administers both");
  });

  test("and a Bravo subject tells Bravo, not Alpha -- the rule is symmetric", async () => {
    const scoped = await audience(f.areas.bravo);
    assert.ok(scoped.length > 0, "Bravo's own members are told");
    for (const member of scoped) {
      assert.equal(member.area_id, f.areas.bravo,
        "and only Bravo's, so this is a rule rather than a special case for Alpha");
    }
  });
});
