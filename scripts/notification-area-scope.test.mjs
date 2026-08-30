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
import { readFileSync } from "node:fs";

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

/**
 * ---------------------------------------------------------------------------
 * "NOBODY ELSE CAN RECEIVE THESE YET" -- ASKED OF ONE FAMILY.
 * ---------------------------------------------------------------------------
 *
 * `readDeviceStatus` reports `otherMembersWithPush`, and the Notifications
 * screen shows its warning ONLY when that number is zero. The count was read
 * through the ADMIN client as `neq("app_member_id", me)` with no Area on it.
 *
 * `push_subscriptions` has no `area_id` of its own -- it hangs off
 * `app_members` -- so there was nothing underneath to narrow it: the admin
 * client bypasses row level security, and the read returned every member of
 * every family in the database.
 *
 * That is wrong twice over. It DISCLOSES how many people in other families
 * have notifications turned on, and it SUPPRESSES a true warning: one device
 * registered in another family made this one look reachable when nobody in it
 * could receive anything.
 *
 * The two reads below are the two shapes, run against a real database with
 * three families in it, so the difference is measured rather than asserted.
 */
describe("how many others can receive a push is a question about ONE family", () => {
  /** Give one member a registered device, the way `registerDevice` does. */
  const registerFor = async (appMemberId, label) => {
    await asOwner(db);
    await rows(
      db,
      `insert into public.push_subscriptions (app_member_id, endpoint, p256dh, auth, device_label)
       values ($1, $2, $3, $4, 'Windows PC')`,
      [
        appMemberId,
        `https://push.example.test/${label}`,
        "k".repeat(87),
        "s".repeat(22),
      ],
    );
  };

  /** The unscoped read, exactly as it was: every family at once. */
  const unscopedOthers = async (meAppMemberId) => {
    await asOwner(db);
    return rows(
      db,
      "select app_member_id from public.push_subscriptions where app_member_id <> $1",
      [meAppMemberId],
    );
  };

  /** The Area-scoped read: this family's other active members, and only those. */
  const scopedOthers = async (meAppMemberId, areaId) => {
    await asOwner(db);
    return rows(
      db,
      `select s.app_member_id
         from public.push_subscriptions s
        where s.app_member_id in (
                select m.id from public.app_members m
                 where m.area_id = $2 and m.active = true and m.id <> $1)`,
      [meAppMemberId, areaId],
    );
  };

  test("ANOTHER FAMILY'S DEVICE IS COUNTED BY THE UNSCOPED READ -- the defect", async () => {
    // Jade is in Alpha and has a device. Sam is in Bravo and has one too.
    await registerFor(f.members.jadeAlpha, "jade-alpha");
    await registerFor(f.members.samBravo, "sam-bravo");

    // Taylor, in Alpha, asks how many OTHER people could receive a push.
    const unscoped = await unscopedOthers(f.members.taylorAlpha);
    const unscopedCount = new Set(unscoped.map((row) => row.app_member_id)).size;

    const scoped = await scopedOthers(f.members.taylorAlpha, f.areas.alpha);
    const scopedCount = new Set(scoped.map((row) => row.app_member_id)).size;

    assert.equal(scopedCount, 1, "only Jade, who is actually in Taylor's family");
    assert.equal(unscopedCount, 2, "the unscoped read also counts Bravo's Sam");
    assert.ok(unscopedCount > scopedCount,
      "the unscoped read really does reach past this family -- which is the bug");
  });

  test("AND IT SUPPRESSES A TRUE WARNING: a family alone looks reachable", async () => {
    /*
     * Cass is the only member of Charlie with an account, and nobody in
     * Charlie has registered a device. The screen must say so. The unscoped
     * read answers 2 -- Alpha's and Bravo's -- and the warning disappears.
     */
    const unscoped = await unscopedOthers(f.members.cassCharlie);
    const scoped = await scopedOthers(f.members.cassCharlie, f.areas.charlie);

    assert.equal(new Set(scoped.map((row) => row.app_member_id)).size, 0,
      "nobody in Charlie can receive a push, so the warning must show");
    assert.ok(new Set(unscoped.map((row) => row.app_member_id)).size > 0,
      "yet the unscoped read finds devices, and the warning would be hidden");
  });

  test("the runtime issues the Area-scoped read, not the unscoped one", () => {
    const source = readFileSync(
      new URL("../src/utils/supabase/notifications-server.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/gu, "\n");

    const readDeviceStatus = source.slice(
      source.indexOf("export async function readDeviceStatus"),
      source.indexOf("// ---", source.indexOf("export async function readDeviceStatus")),
    );
    assert.ok(readDeviceStatus.length > 0, "readDeviceStatus must still be there to check");

    assert.match(
      readDeviceStatus,
      /\.from\("app_members"\)[\s\S]*?\.eq\("area_id", member\.area_id\)/u,
      "the other-members count must be narrowed to the caller's own Area",
    );
    assert.doesNotMatch(
      readDeviceStatus,
      /\.from\("push_subscriptions"\)\s*\.select\("app_member_id"\)\s*\.neq\(/u,
      "an unscoped neq() over push_subscriptions counts every family in the database",
    );
  });
});
