/**
 * Q4: AN EVENT IS AN OCCASION; A RECIPIENT IS A ROLE SOMEBODY HOLDS IN ONE.
 *
 * The distinction this file defends, in one line each:
 *
 *   PERSON     durable, family-wide. Their name, their birthday, their history.
 *   RECIPIENT  a person's place in ONE event: a budget and a contributor plan.
 *              The same person holds the role again, separately, in every event
 *              they receive something in.
 *   EVENT      an occasion, belonging to exactly one family.
 *
 * Blurring recipient into person is the bug this quarter found: the event
 * screen carried a Name field, and saving it renamed the DURABLE PERSON in
 * every event, every purchase and the whole family history -- from a panel that
 * reads as "this event's entry for them". Proven against a real database before
 * it was removed, and pinned below so it cannot come back.
 *
 * THE DATABASE HALF IS RUN, NOT READ. Uniqueness, cross-Area refusal and
 * history preservation are driven against a real PostgreSQL 18 with all
 * forty-five migrations applied, through the same shape a browser request has.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { describe, before, after } from "node:test";

import { ROOT, asOwner, buildRehearsal, probe, probeValue, rows, seen, value } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/gu, "\n");
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\{\/\*[\s\S]*?\*\/\}/gu, "").replace(/^\s*\/\/.*$/gmu, "");

const APP = ["src", "app"];
const EVENT_DIR = [...APP, "events", "[eventId]"];

let db;
let f;
const who = (user, area) => ({ user, area });

before(async () => { db = await buildRehearsal({}); f = await buildTwoFamilies(db); });
after(async () => { await db?.close(); });

// ===========================================================================
// 1. An event belongs to one family, and titles do not collide across families
// ===========================================================================

describe("the same occasion can exist in two families at once", () => {
  test("A CUSTOM EVENT WITH THE SAME TITLE IS FINE IN BOTH", async () => {
    /*
     * There is no global uniqueness on an event title, and there must not be:
     * two unrelated families both having a "Summer BBQ" is not a conflict, it
     * is two families. Uniqueness is per Area (migration 035's
     * `events_name_and_date_per_area_idx`).
     */
    const alpha = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.create_event('Summer BBQ','other','2027-07-01',null,null,null,null)).id as id");
    assert.ok(alpha.ok, alpha.error);

    const bravo = await probe(db, who(f.users.bravoadmin, f.areas.bravo),
      "select (public.create_event('Summer BBQ','other','2027-07-01',null,null,null,null)).id as id");
    assert.ok(bravo.ok, "the same title on the same date must be allowed in another family");

    await asOwner(db);
    const areas = await rows(db,
      "select area_id from public.events where name = 'Summer BBQ' order by area_id");
    assert.equal(areas.length, 2, "two events, one per family");
    assert.notEqual(areas[0].area_id, areas[1].area_id);
  });

  test("but the SAME family cannot hold the same title on the same day twice", async () => {
    const again = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.create_event('Summer BBQ','other','2027-07-01',null,null,null,null)");
    assert.equal(again.ok, false, "within one family that is a duplicate, not a second occasion");
  });

  test("CHRISTMAS IS UNIQUE PER FAMILY PER YEAR -- not globally per year", async () => {
    /*
     * The index is on (area_id, year) for christmas rows. A second family's
     * Christmas 2027 is a different Christmas, and the app was built when that
     * distinction did not exist.
     */
    const alpha = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.create_event('Christmas 2027','christmas','2027-12-25',null,null,null,null)).id as id");
    assert.ok(alpha.ok, alpha.error);

    const bravo = await probe(db, who(f.users.bravoadmin, f.areas.bravo),
      "select (public.create_event('Christmas 2027','christmas','2027-12-25',null,null,null,null)).id as id");
    assert.ok(bravo.ok, "each family gets its own Christmas 2027");

    const duplicate = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.create_event('Another Christmas 2027','christmas','2027-12-24',null,null,null,null)");
    assert.equal(duplicate.ok, false, "one Christmas per family per year");
  });

  test("an event created in one family appears in NO other family's list", async () => {
    await asOwner(db);
    const alphaEvents = await rows(db,
      "select name from public.events where area_id = $1 and name = 'Summer BBQ'", [f.areas.alpha]);
    const charlieEvents = await rows(db,
      "select name from public.events where area_id = $1", [f.areas.charlie]);
    assert.equal(alphaEvents.length, 1);
    assert.ok(!charlieEvents.some((row) => row.name === "Summer BBQ"),
      "creating in Alpha must not touch Charlie");
  });

  test("and a member of another family cannot read it at all", async () => {
    const seen = await probe(db, who(f.users.bravoadmin, f.areas.bravo),
      "select id from public.events where area_id = $1", [f.areas.alpha]);
    assert.deepEqual(seen.rows, [], "row level security, not a filter in a screen");
  });
});

// ===========================================================================
// 2. Recipients: a role in an event, never a second person
// ===========================================================================

describe("adding a recipient adds a ROLE, not a person", () => {
  let event;

  before(async () => {
    const created = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.create_event('Recipient Tests','other','2027-05-05',null,null,null,null)).id as id");
    event = created.rows[0].id;
  });

  test("it links the EXISTING person and creates nobody", async () => {
    await asOwner(db);
    const before = await value(db, "select count(*)::int from public.people where area_id = $1", [f.areas.alpha]);

    const added = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.add_event_recipient($1,$2)).person_id as person_id", [event, f.people.mo]);
    assert.ok(added.ok, added.error);
    assert.equal(added.rows[0].person_id, f.people.mo, "the same person, not a copy");

    await asOwner(db);
    assert.equal(
      await value(db, "select count(*)::int from public.people where area_id = $1", [f.areas.alpha]),
      before, "NOT ONE new person row");
  });

  test("and gives them no account, no contributor flag and no role", async () => {
    await asOwner(db);
    assert.equal(
      await value(db, "select count(*)::int from public.app_members where person_id = $1 and area_id = $2",
        [f.people.mo, f.areas.alpha]), 1, "their existing membership is untouched, and no new one appears");
    const person = (await rows(db,
      "select is_family_contributor from public.people where id = $1", [f.people.mo]))[0];
    assert.equal(person.is_family_contributor, false, "being a recipient is not contributing");
  });

  test("ADDING THE SAME PERSON TWICE RETURNS THE SAME ROW -- it does not duplicate", async () => {
    /*
     * IDEMPOTENT, WHICH IS BETTER THAN REFUSING. A double-tap on "Add", a
     * retried request, or two admins doing the same thing at once all converge
     * on ONE recipient row rather than on an error somebody has to interpret.
     * There is exactly one recipient per (event, person) either way.
     */
    const first = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.add_event_recipient($1,$2)).id as id", [event, f.people.mo]);
    const again = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.add_event_recipient($1,$2)).id as id", [event, f.people.mo]);
    assert.ok(again.ok, again.error);
    assert.equal(again.rows[0].id, first.rows[0].id, "the same recipient row comes back");

    await asOwner(db);
    assert.equal(
      await value(db, "select count(*)::int from public.christmas_recipients where christmas_event_id = $1 and person_id = $2",
        [event, f.people.mo]), 1, "and there is still exactly one");
  });

  test("and re-adding a REMOVED recipient reactivates them rather than making a second", async () => {
    const existing = await value(db,
      "select id from public.christmas_recipients where christmas_event_id = $1 and person_id = $2",
      [event, f.people.mo]);
    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_christmas_recipient_active($1,false)", [existing]);

    const readded = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.add_event_recipient($1,$2)).id as id", [event, f.people.mo]);
    assert.ok(readded.ok, readded.error);
    assert.equal(readded.rows[0].id, existing, "the SAME row, so its history comes back with it");

    await asOwner(db);
    assert.equal(await value(db, "select active from public.christmas_recipients where id = $1", [existing]), true);
    assert.equal(
      await value(db, "select count(*)::int from public.christmas_recipients where christmas_event_id = $1 and person_id = $2",
        [event, f.people.mo]), 1);
  });

  test("A PERSON FROM ANOTHER FAMILY CANNOT BE A RECIPIENT HERE", async () => {
    const foreign = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.add_event_recipient($1,$2)", [event, f.people.jem]);
    assert.equal(foreign.ok, false, "Jem is in Bravo");

    await asOwner(db);
    assert.equal(
      await value(db, "select count(*)::int from public.christmas_recipients where christmas_event_id = $1 and person_id = $2",
        [event, f.people.jem]), 0);
  });

  test("and a FOREIGN EVENT cannot be added to from here (migration 045)", async () => {
    const foreignEvent = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.add_event_recipient($1,$2)", [f.bravoBirthday, f.people.jo]);
    assert.equal(foreignEvent.ok, false);
    assert.equal(foreignEvent.code, "42501", "the Area guard, not a business rule");
  });

  test("the same person IS a recipient in several events, independently", async () => {
    const second = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.create_event('Second Occasion','other','2027-05-06',null,null,null,null)).id as id");
    const added = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.add_event_recipient($1,$2)", [second.rows[0].id, f.people.mo]);
    assert.ok(added.ok, added.error);

    await asOwner(db);
    assert.equal(
      await value(db, "select count(*)::int from public.christmas_recipients where person_id = $1", [f.people.mo]),
      2, "one person, two roles, two events");
  });
});

// ===========================================================================
// 3. Removing a recipient keeps the history
// ===========================================================================

describe("removing somebody from an event deletes nothing", () => {
  test("DEACTIVATING KEEPS THE RECIPIENT ROW, ITS ID AND EVERYTHING HANGING OFF IT", async () => {
    await asOwner(db);
    const before = await rows(db, `
      select
        (select count(*) from public.purchases where christmas_recipient_id = $1) as purchases,
        (select count(*) from public.gift_ideas where christmas_recipient_id = $1) as ideas,
        (select count(*) from public.recipient_contributions where christmas_recipient_id = $1) as plans,
        (select count(*) from public.purchase_allocations a
           join public.purchases p on p.id = a.purchase_id
           where p.christmas_recipient_id = $1) as allocations`, [f.recipient]);

    const off = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_christmas_recipient_active($1,false)", [f.recipient]);
    assert.ok(off.ok, off.error);

    await asOwner(db);
    const still = (await rows(db,
      "select id, person_id, active, budget_pennies from public.christmas_recipients where id = $1", [f.recipient]))[0];
    assert.ok(still, "THE ROW IS STILL THERE. Removing from an event is not deletion.");
    assert.equal(still.id, f.recipient, "and keeps its id, so every purchase still resolves");
    assert.equal(still.active, false, "only the flag moved");

    assert.deepEqual(await rows(db, `
      select
        (select count(*) from public.purchases where christmas_recipient_id = $1) as purchases,
        (select count(*) from public.gift_ideas where christmas_recipient_id = $1) as ideas,
        (select count(*) from public.recipient_contributions where christmas_recipient_id = $1) as plans,
        (select count(*) from public.purchase_allocations a
           join public.purchases p on p.id = a.purchase_id
           where p.christmas_recipient_id = $1) as allocations`, [f.recipient]),
      before, "not one purchase, idea, plan or allocation moved");
  });

  test("and the PERSON is entirely untouched", async () => {
    await asOwner(db);
    const person = (await rows(db,
      "select id, name, birthday_month, archived_at from public.people where id = $1", [f.people.taylor]))[0];
    assert.ok(person, "removing a recipient does not remove a person");
    assert.equal(person.archived_at, null, "nor archive them");
    assert.ok(person.birthday_month, "nor forget their birthday");
  });

  test("REACTIVATING RESTORES THE SAME ROW -- it does not make a second one", async () => {
    const on = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_christmas_recipient_active($1,true)", [f.recipient]);
    assert.ok(on.ok, on.error);

    await asOwner(db);
    const all = await rows(db,
      "select id, active from public.christmas_recipients where christmas_event_id = $1 and person_id = $2",
      [f.birthday, f.people.taylor]);
    assert.equal(all.length, 1, "one recipient row, not a duplicate");
    assert.equal(all[0].id, f.recipient, "the same id it always had");
    assert.equal(all[0].active, true);
  });

  test("a recipient in ANOTHER family cannot be deactivated from here", async () => {
    const foreign = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_christmas_recipient_active($1,false)", [f.bravoRecipient]);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, "42501");
    await asOwner(db);
    assert.equal(await value(db, "select active from public.christmas_recipients where id = $1", [f.bravoRecipient]), true);
  });
});

// ===========================================================================
// 4. THE BUG THIS QUARTER FOUND: an event renaming the family's person
// ===========================================================================

describe("an event may change what somebody GETS, never who they ARE", () => {
  test("THE DATABASE ROUTINE STILL WRITES THE PERSON'S NAME -- which is why the screen must not offer it", async () => {
    /*
     * `save_christmas_recipient_with_contributions` takes a name and writes it
     * to `people`. That is long-standing behaviour with purchases and history
     * depending on the routine, so Q4 does not rewrite it in a migration --
     * it removes the only screen that fed it a CHANGED name.
     *
     * This test exists so the hazard stays documented and measured: if the
     * routine ever stops renaming, the UI note below can be relaxed on purpose
     * rather than by accident.
     */
    await asOwner(db);
    const before = await value(db, "select name from public.people where id = $1", [f.people.taylor]);

    const renamed = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.save_christmas_recipient_with_contributions($1,$2,'RENAMED VIA EVENT',9000,$3::jsonb)",
      [f.recipient, f.birthday, JSON.stringify([{ contributor_id: f.jadeContributor, planned_amount_pennies: 9000 }])]);
    assert.ok(renamed.ok, renamed.error);

    await asOwner(db);
    assert.equal(
      await value(db, "select name from public.people where id = $1", [f.people.taylor]),
      "RENAMED VIA EVENT",
      "the routine does rename the person -- measured, not assumed");

    // Put the family back.
    await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.save_christmas_recipient_with_contributions($1,$2,$3,9000,$4::jsonb)",
      [f.recipient, f.birthday, before, JSON.stringify([{ contributor_id: f.jadeContributor, planned_amount_pennies: 9000 }])]);
  });

  test("SO THE EVENT SCREEN NO LONGER OFFERS A NAME FIELD", () => {
    const modal = read(...APP, "people", "person-modal.tsx");
    const editor = modal.slice(modal.indexOf("function PersonEditor"));

    assert.ok(!/<Input[\s\S]{0,200}value=\{name\}/u.test(editor),
      "an editable name here renames the person in every event they appear in");
    assert.match(editor, /Budget/u, "the budget IS this event's business");
    assert.match(editor, /href=\{`\/people\/\$\{personId\}`\}/u,
      "and it points at the profile, which is where a name is corrected");
  });

  test("and it sends the person's name back unchanged", () => {
    const modal = withoutComments(read(...APP, "people", "person-modal.tsx"));
    const start = modal.indexOf("const savePerson");
    assert.ok(start > 0, "savePerson must exist");
    const save = modal.slice(start, start + 700);
    assert.match(save, /name: person\.name/u,
      "the routine requires the argument; this screen must have no opinion about it");
    assert.ok(!save.includes("validName"), "there is no name to validate here any more");
    // And the state it used to edit is gone, so nothing can feed it a new name.
    assert.ok(!modal.includes("const [name, setName]"),
      "an editable name state here is how the person got renamed family-wide");
  });

  test("the profile is still where a name IS changed, so nothing was merely removed", () => {
    const panel = read(...APP, "people", "[id]", "person-admin-panel.tsx");
    assert.match(panel, /set_person_name/u);
    assert.match(panel, /title="Name"/u);
  });
});

// ===========================================================================
// 5. Contributors are not recipients
// ===========================================================================

describe("who chips in and who receives are different lists", () => {
  test("a contributor is not thereby a recipient", async () => {
    const event = (await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.create_event('Contributor Split','other','2027-09-09',null,null,null,null)).id as id")).rows[0].id;

    const added = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_event_contributor($1,$2,true)", [event, f.people.jade]);
    assert.ok(added.ok, added.error);

    await asOwner(db);
    assert.equal(
      await value(db, "select count(*)::int from public.contributors where christmas_event_id = $1 and person_id = $2",
        [event, f.people.jade]), 1, "she contributes");
    assert.equal(
      await value(db, "select count(*)::int from public.christmas_recipients where christmas_event_id = $1 and person_id = $2",
        [event, f.people.jade]), 0, "AND RECEIVES NOTHING from it");
  });

  test("nor does contributing give an account or an admin role", async () => {
    await asOwner(db);
    const membership = (await rows(db,
      "select role, active from public.app_members where person_id = $1 and area_id = $2",
      [f.people.jade, f.areas.alpha]))[0];
    assert.equal(membership.role, "member", "still an ordinary member");
  });

  test("A PERSON FROM ANOTHER FAMILY CANNOT BE AN EVENT CONTRIBUTOR", async () => {
    const event = (await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.create_event('Foreign Contributor','other','2027-09-10',null,null,null,null)).id as id")).rows[0].id;
    const foreign = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_event_contributor($1,$2,true)", [event, f.people.jem]);
    assert.equal(foreign.ok, false);
  });

  test("and a foreign EVENT cannot have its contributors edited from here", async () => {
    const foreign = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_event_contributor($1,$2,true)", [f.bravoBirthday, f.people.jo]);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, "42501");
  });
});

// ===========================================================================
// 6. Archive is a state; past is a date; delete is neither
// ===========================================================================

describe("archiving, deleting, and the difference between them", () => {
  test("AN EVENT WITH HISTORY CANNOT BE DELETED", async () => {
    const refused = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.delete_event_if_empty($1)", [f.birthday]);
    assert.equal(refused.ok, false, "Taylor's birthday has a purchase behind it");

    /*
     * AND IT IS REFUSED BY THE ROUTINE, NOT BY A FOREIGN KEY.
     *
     * Both end with the event intact, so "did it survive" cannot tell them
     * apart -- but the person on the other end of it reads two very different
     * things. The routine counts what is in the way and says so, and names
     * the safe alternative. A raw constraint violation says
     * "update or delete on table events violates foreign key constraint" and
     * leaves them nowhere. If the emptiness check were ever removed, the event
     * would still be there and only this assertion would notice.
     */
    assert.match(refused.error, /cannot be deleted. Archive it instead/u,
      "the refusal must explain itself and offer archiving");
    assert.match(refused.error, /has 1 purchases/u,
      "and count what is actually in the way");

    await asOwner(db);
    assert.ok(await value(db, "select id from public.events where id = $1", [f.birthday]),
      "and the event is still there");
  });

  test("but an empty one may be, which is what makes archive the SAFE default", async () => {
    const empty = (await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.create_event('Delete Me','other','2027-11-11',null,null,null,null)).id as id")).rows[0].id;
    const deleted = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.delete_event_if_empty($1)", [empty]);
    assert.ok(deleted.ok, deleted.error);
    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.events where id = $1", [empty]), 0);
  });

  test("ARCHIVING KEEPS EVERYTHING, and is reversible", async () => {
    await asOwner(db);
    const before = await rows(db, `
      select
        (select count(*) from public.christmas_recipients where christmas_event_id = $1) as recipients,
        (select count(*) from public.contributors where christmas_event_id = $1) as contributors,
        (select count(*) from public.purchases p join public.christmas_recipients r
           on r.id = p.christmas_recipient_id where r.christmas_event_id = $1) as purchases`, [f.birthday]);

    const archived = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_event_status($1,'archived')", [f.birthday]);
    assert.ok(archived.ok, archived.error);

    await asOwner(db);
    assert.equal(await value(db, "select status from public.events where id = $1", [f.birthday]), "archived");
    assert.deepEqual(await rows(db, `
      select
        (select count(*) from public.christmas_recipients where christmas_event_id = $1) as recipients,
        (select count(*) from public.contributors where christmas_event_id = $1) as contributors,
        (select count(*) from public.purchases p join public.christmas_recipients r
           on r.id = p.christmas_recipient_id where r.christmas_event_id = $1) as purchases`, [f.birthday]),
      before, "archiving is one word on one row");

    const back = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_event_status($1,'active')", [f.birthday]);
    assert.ok(back.ok, back.error);
  });

  test("and a foreign event can be neither archived nor deleted from here", async () => {
    for (const [what, sql] of [
      ["archive", "select public.set_event_status($1,'archived')"],
      ["delete", "select public.delete_event_if_empty($1)"],
    ]) {
      const refused = await probe(db, who(f.users.dual, f.areas.alpha), sql, [f.bravoBirthday]);
      assert.equal(refused.ok, false, what);
      assert.equal(refused.code, "42501", what);
    }
    await asOwner(db);
    assert.equal(await value(db, "select status from public.events where id = $1", [f.bravoBirthday]), "active");
  });
});

// ===========================================================================
// 7. What the screens say
// ===========================================================================

describe("the event screens", () => {
  test("THE EVENTS INDEX NAMES THE FAMILY IT IS LISTING", () => {
    /*
     * Somebody in several families reads an identical layout in each, and
     * "Christmas 2026" exists in more than one of them. Without the name the
     * only clue is a two-letter avatar in the corner.
     */
    const dashboard = read(...APP, "events-dashboard.tsx");
    assert.match(dashboard, /eyebrow=\{areaName\}/u);
    assert.match(dashboard, /areaName: string;/u);

    const page = read(...APP, "page.tsx");
    assert.match(page, /areaName=\{areaLabel\(active\)\}/u,
      "and it comes from the selected Area, not from anywhere else");
  });

  test("an event card says how many people it is for", () => {
    const dashboard = read(...APP, "events-dashboard.tsx");
    assert.match(dashboard, /recipientSummary\(event\.activeRecipientCount\)/u);

    const loader = read("src", "utils", "supabase", "events-server.ts");
    assert.match(loader, /activeRecipientCount: recipientCountByEvent/u);
    // ACTIVE recipients, the same population the budget and spend are summed
    // over, so a card cannot disagree with the screen it opens.
    assert.match(loader, /const recipients = \(recipientResult\.data \?\? \[\]\)\.filter\(\(row\) => row\.active\)/u);
  });

  test("the events list is scoped to the family on screen", () => {
    const loader = read("src", "utils", "supabase", "events-server.ts");
    assert.match(loader, /\.from\("events"\)\.select\(EVENT_COLUMNS\)\.eq\("area_id", areaId\)/u);
    // And one event, reached by id, is scoped the same way.
    assert.match(loader, /\.eq\("id", validId\.value\)\.eq\("area_id", areaId\)/u);
  });

  test("EVENT SETTINGS CARRIES NOTHING GLOBAL OR FAMILY-LEVEL", () => {
    const screen = withoutComments(read(...EVENT_DIR, "settings", "settings-screen.tsx"));
    for (const forbidden of [
      "Falling snow", "Account & security", "Family access", "Family settings",
      "Your settings", "Your families", "Create new family", "Global Admin",
    ]) {
      assert.ok(!screen.includes(forbidden), `${forbidden} is not a setting of one event`);
    }
  });

  test("and neither does the event More screen", () => {
    const screen = withoutComments(read(...EVENT_DIR, "more", "event-more-screen.tsx"));
    for (const forbidden of [
      "Falling snow", "Account & security", "Family access", "Family settings",
      "Your settings", "Your families", "Create new family", "Global Admin",
    ]) {
      assert.ok(!screen.includes(forbidden), `${forbidden} is not a setting of one event`);
    }
    assert.match(screen, /eventSettingsFor\(/u, "it builds its list from the scope model");
  });

  test("every event route is gated by requireEvent, which 404s indistinguishably", () => {
    const dir = join(ROOT, ...EVENT_DIR);
    const pages = [];
    const walk = (relative) => {
      for (const entry of readdirSync(join(dir, relative || "."), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(child);
        else if (entry.name === "page.tsx") pages.push(child);
      }
    };
    walk("");
    assert.ok(pages.length >= 6, `expected the event sections, found ${pages.length}`);

    for (const page of pages) {
      const source = read(...EVENT_DIR, ...page.split("/"));
      assert.match(source, /requireEvent\(/u, `${page} must resolve its event through the gate`);
    }

    const loader = read("src", "utils", "supabase", "events-server.ts");
    assert.match(loader, /notFound\(\)/u);
  });
});

// ===========================================================================
// 8. Sweeps -- the shapes that would undo the above
// ===========================================================================

describe("no event or recipient read can go Area-blind", () => {
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

  test("a single-row read of events or recipients names an Area or a unique id", () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      const source = withoutComments(read(file));
      for (const table of ["events", "christmas_recipients", "contributors"]) {
        for (const chunk of source.split(`.from("${table}")`).slice(1)) {
          const statement = chunk.split(/;|\.from\(/u)[0];
          if (!statement.includes(".maybeSingle()") && !statement.includes(".single()")) continue;
          const scoped = /\.eq\("id",/u.test(statement)
            || /\.eq\("area_id",/u.test(statement)
            || statement.includes(".limit(1)");
          if (!scoped) offenders.push(`${file}: ${table} resolved to one row without an Area`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("no event screen hard-codes an id, a family name or a year-only lookup", () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;
    const offenders = [];
    for (const file of sourceFiles().filter((name) => /events|people/u.test(name))) {
      const source = withoutComments(read(file));
      if (uuid.test(source)) offenders.push(`${file} hard-codes an id`);
      if (/Our family/u.test(source)) offenders.push(`${file} names a real family`);
    }
    assert.deepEqual(offenders, []);
  });

  test("NO API ROUTE MUTATES AN EVENT OR A RECIPIENT", () => {
    /*
     * Worth pinning rather than assuming. Event and recipient changes go
     * through the caller's own session and the Area-bound routines migration
     * 045 hardened -- there is no service-role path to review, and adding one
     * would need this test changed on purpose.
     */
    const routes = [];
    const walk = (relative) => {
      for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (entry.name === "route.ts") routes.push(child);
      }
    };
    walk("src/app/api");
    assert.ok(routes.length >= 8, "the API routes should still be there to sweep");

    for (const route of routes) {
      const source = withoutComments(read(route));
      for (const routine of [
        "add_event_recipient", "create_event", "update_event", "set_event_status",
        "save_christmas_recipient", "set_christmas_recipient_active",
        "delete_event_if_empty", "set_event_contributor",
      ]) {
        assert.ok(!source.includes(routine),
          `${route} mutates events or recipients; it would need its own Area audit`);
      }
    }
  });
});

// ===========================================================================
// 9. A birthday happens once a year, for one person, in one family
// ===========================================================================

describe("birthday occurrences are unique per person per year", () => {
  /*
   * WHY THIS IS RUN AND NOT READ. Until now this rule was asserted by a regular
   * expression looking for `events_one_birthday_per_person_per_year_idx` in the
   * text of migration 026. That proves the index was WRITTEN. It cannot tell a
   * key of (person, year) from a key of (person, date) -- and the second one
   * looks identical at a glance while allowing twelve birthdays a year. Every
   * assertion below is a real INSERT against a real PostgreSQL with all
   * forty-five migrations applied.
   *
   * THE INDEX IS PARTIAL, on `status = 'active'`, which migration 026 chose on
   * purpose: "Archived events are excluded so a mistake can be archived and
   * redone." That escape hatch is behaviour, so it is tested as behaviour.
   */
  const alphaAdmin = () => who(f.users.dual, f.areas.alpha);
  const bravoAdmin = () => who(f.users.bravoadmin, f.areas.bravo);
  const birthdayFor = (person, name, date) => probe(db, alphaAdmin(),
    "select (public.create_event($1,'birthday',$2,null,$3,null,null)).id as id", [name, date, person]);

  let moFirst;

  test("one birthday is created for somebody who has none", async () => {
    const created = await birthdayFor(f.people.mo, "Mo's birthday 2028", "2028-04-01");
    assert.ok(created.ok, created.error);
    moFirst = created.rows[0].id;
  });

  test("A SECOND ONE FOR THE SAME PERSON IN THE SAME YEAR IS REFUSED", async () => {
    /*
     * DIFFERENT NAME AND DIFFERENT DATE, deliberately. Migration 035's
     * `events_name_and_date_per_area_idx` already refuses the same title on the
     * same day, so a duplicate sharing either one would be refused by the wrong
     * rule and prove nothing about birthdays. This one can only be refused by
     * the birthday key itself.
     */
    const again = await probe(db, alphaAdmin(),
      "select public.create_event('Mo birthday party','birthday','2028-09-30',null,$1,null,null)", [f.people.mo]);
    assert.equal(again.ok, false, "a person has one birthday occurrence in a year, whatever it is called");
    assert.equal(again.code, "23505", "refused by the uniqueness key, not by a rule somewhere else");

    await asOwner(db);
    assert.equal(
      await value(db, `select count(*)::int from public.events
        where celebrant_person_id = $1 and extract(year from event_date) = 2028 and status = 'active'`,
        [f.people.mo]), 1, "and exactly one survives");
  });

  test("but the SAME PERSON may have one in a different year", async () => {
    const next = await birthdayFor(f.people.mo, "Mo's birthday 2029", "2029-04-01");
    assert.ok(next.ok, next.error);

    await asOwner(db);
    assert.equal(
      await value(db, "select count(*)::int from public.events where celebrant_person_id = $1", [f.people.mo]),
      2, "one per year, and a person has many years");
  });

  test("and a DIFFERENT PERSON in the SAME family may have one in the SAME year", async () => {
    /*
     * The mutation this catches is the smallest possible one: a key of (year)
     * rather than (person, year) would refuse this, and a whole family would be
     * able to plan exactly one birthday a year between all of them.
     */
    const jade = await birthdayFor(f.people.jade, "Jade's birthday 2028", "2028-06-15");
    assert.ok(jade.ok, jade.error);

    await asOwner(db);
    assert.equal(
      await value(db, `select count(*)::int from public.events
        where area_id = $1 and event_type = 'birthday'
          and extract(year from event_date) = 2028 and status = 'active'`, [f.areas.alpha]),
      2, "two people, two birthdays, one year, one family");
  });

  test("A PERSON WITH THE SAME NAME IN ANOTHER FAMILY DOES NOT COLLIDE", async () => {
    /*
     * There is no global uniqueness here and there must not be. Two families
     * can both contain a Mo, and both can plan his birthday in the same year on
     * the same day. The key is the PERSON id, and a person belongs to exactly
     * one Area -- so the rule is Area-scoped by construction rather than by a
     * column that could be left off.
     */
    const otherMo = await probe(db, bravoAdmin(),
      "select id from public.create_person('Mo', null::smallint, null::smallint, null::smallint)");
    assert.ok(otherMo.ok, otherMo.error);
    const otherMoId = otherMo.rows[0].id;
    assert.notEqual(otherMoId, f.people.mo, "a different person who happens to share a name");

    const theirs = await probe(db, bravoAdmin(),
      "select public.create_event($1,'birthday','2028-04-01',null,$2,null,null)",
      ["Mo's birthday 2028", otherMoId]);
    assert.ok(theirs.ok, "the other family's Mo has his own birthday, on the very same day");

    await asOwner(db);
    const both = await rows(db, `select area_id from public.events
      where event_type = 'birthday' and event_date = '2028-04-01' order by area_id`);
    assert.equal(both.length, 2, "two birthdays, same date, different families");
    assert.notEqual(both[0].area_id, both[1].area_id);
  });

  test("ARCHIVING ONE FREES THE YEAR AGAIN, which is how a mistake is undone", async () => {
    // The index is `where status = 'active'`. Migration 026 wrote it that way so
    // a birthday entered wrongly can be archived and redone, rather than leaving
    // the family locked out of that person's year.
    const blocked = await probe(db, alphaAdmin(),
      "select public.create_event('Mo redo 2028','birthday','2028-04-02',null,$1,null,null)", [f.people.mo]);
    assert.equal(blocked.ok, false, "still blocked while the first one is active");

    const archived = await probe(db, alphaAdmin(), "select public.set_event_status($1,'archived')", [moFirst]);
    assert.ok(archived.ok, archived.error);

    const redone = await probe(db, alphaAdmin(),
      "select public.create_event('Mo redo 2028','birthday','2028-04-02',null,$1,null,null)", [f.people.mo]);
    assert.ok(redone.ok, "with the mistake archived, the year is free again");

    await asOwner(db);
    assert.equal(
      await value(db, `select count(*)::int from public.events
        where celebrant_person_id = $1 and extract(year from event_date) = 2028 and status = 'active'`,
        [f.people.mo]), 1, "and there is still only ONE active one");
  });
});

// ===========================================================================
// 10. The celebrant cannot see the planning for their own birthday event
// ===========================================================================

describe("a birthday event is invisible to the person it is for", () => {
  /*
   * THE EVENT LEVEL, not one row of it.
   *
   * That a celebrant cannot read one gift idea is proven elsewhere. What an
   * EVENT PAGE loads is more than that: the event itself, its recipients and
   * their budgets, who is contributing and how much, what has been bought and
   * by whom, how the cost was split, what was paid between people afterwards,
   * and photographs of any of it. A gap in any one of those is the surprise
   * gone -- and the money half of it had no test at all.
   *
   * The rows below are created for that reason: an assertion that the celebrant
   * sees nothing is worth nothing unless there is something to see.
   */
  const celebrant = () => who(f.users.taylor, f.areas.alpha);
  const planner = () => who(f.users.jade, f.areas.alpha);

  let moContributor;
  let settlement;
  let receipt;
  let allocation;

  before(async () => {
    await asOwner(db);
    // A second contributor, so a payment can exist between two people.
    moContributor = await value(db, `
      insert into public.contributors (christmas_event_id, person_id, active)
      values ($1, $2, true) returning id`, [f.birthday, f.people.mo]);

    allocation = await value(db, `
      insert into public.purchase_allocations (purchase_id, contributor_id, responsibility_pennies)
      values ($1, $2, 12900) returning id`, [f.purchase, f.jadeContributor]);

    settlement = await value(db, `
      insert into public.settlements
        (christmas_event_id, payer_contributor_id, payee_contributor_id, amount_pennies, recorded_by_app_member_id)
      values ($1, $2, $3, 2500, $4) returning id`,
      [f.birthday, moContributor, f.jadeContributor, f.members.jadeAlpha]);

    receipt = await value(db, `
      insert into public.payment_receipts
        (settlement_id, christmas_event_id, payer_contributor_id, payee_contributor_id,
         action, amount_pennies, reviewed_by_app_member_id, reviewer_contributor_id)
      values ($1, $2, $3, $4, 'confirm', 2500, $5, $6) returning id`,
      [settlement, f.birthday, moContributor, f.jadeContributor, f.members.jadeAlpha, f.jadeContributor]);

    await value(db, `
      insert into public.item_photos (gift_idea_id, storage_path)
      values ($1, 'qa/secret-idea.jpg') returning id`, [f.secretIdea]);
    await value(db, `
      insert into public.item_photos (purchase_id, storage_path)
      values ($1, 'qa/wrapped-purchase.jpg') returning id`, [f.purchase]);
  });

  /** Every surface an event page reads, named once. */
  const EVENT_SURFACE = () => [
    ["events", "id = $1", f.birthday],
    ["christmas_recipients", "id = $1", f.recipient],
    ["contributors", "christmas_event_id = $1", f.birthday],
    ["recipient_contributions", "christmas_recipient_id = $1", f.recipient],
    ["gift_ideas", "christmas_recipient_id = $1", f.recipient],
    ["purchases", "christmas_recipient_id = $1", f.recipient],
    ["purchase_allocations", "id = $1", allocation],
    ["settlements", "id = $1", settlement],
    ["payment_receipts", "id = $1", receipt],
    ["item_photos", "gift_idea_id = $1", f.secretIdea],
    ["item_photos", "purchase_id = $1", f.purchase],
  ];

  test("THE PLANNING IS REALLY THERE -- so nothing below passes by being empty", async () => {
    for (const [table, where, id] of EVENT_SURFACE()) {
      const count = await seen(db, planner(), table, where, [id]);
      assert.ok(count > 0, `${table} must be visible to somebody who is NOT the celebrant (saw ${count})`);
    }
  });

  test("THE CELEBRANT SEES NONE OF IT -- event, budget, plan, purchase, split, payment, receipt, photo", async () => {
    for (const [table, where, id] of EVENT_SURFACE()) {
      assert.equal(await seen(db, celebrant(), table, where, [id]), 0,
        `${table} leaks the celebrant's own birthday planning`);
    }
  });

  test("AND NOT THE BUYER'S IDENTITY, which is a column rather than a row", async () => {
    // Who paid at the till, and who owes whom afterwards, are single columns on
    // rows the celebrant must not have at all. Asked for directly they come
    // back empty rather than partially filled.
    const payer = await probe(db, celebrant(),
      "select checkout_payer_contributor_id from public.purchases where id = $1", [f.purchase]);
    assert.equal(payer.ok, true, "no error: an error would confirm the purchase exists");
    assert.equal(payer.count, 0, "and no row");

    const owed = await probe(db, celebrant(),
      "select payer_contributor_id, payee_contributor_id, amount_pennies from public.settlements where id = $1",
      [settlement]);
    assert.equal(owed.count, 0, "the Owed and Payment Log figures are planning too");
  });

  test("THE EVENT IS NOT IN THEIR LIST AT ALL, which is the shape the index loads", async () => {
    /*
     * The dashboard's own query. `listEvents` selects the family's events
     * through the caller's session, so the birthday is not filtered out by a
     * screen -- it never arrives. The planner's identical query returns it.
     */
    await asOwner(db);
    const all = (await rows(db,
      "select id from public.events where area_id = $1", [f.areas.alpha])).map((row) => row.id);
    const theirOwn = (await rows(db,
      `select id from public.events
       where area_id = $1 and event_type = 'birthday' and celebrant_person_id = $2`,
      [f.areas.alpha, f.people.taylor])).map((row) => row.id);

    const mine = await probe(db, celebrant(),
      "select id from public.events where area_id = $1", [f.areas.alpha]);
    const theirs = await probe(db, planner(),
      "select id from public.events where area_id = $1", [f.areas.alpha]);

    assert.ok(!mine.rows.some((row) => row.id === f.birthday), "their own birthday is absent");
    assert.ok(theirs.rows.some((row) => row.id === f.birthday), "and present for everybody else");

    /*
     * EXACTLY THEIR OWN BIRTHDAYS ARE MISSING, AND NOTHING ELSE.
     *
     * Counting the difference against another member would be wrong: everybody
     * has a birthday, so the planner is hiding one of their own too, and two
     * equal-length lists would look like nothing was hidden at all. The set
     * subtraction is compared against the truth read with owner rights.
     */
    const hidden = all.filter((id) => !mine.rows.some((row) => row.id === id)).sort();
    assert.deepEqual(hidden, [...theirOwn].sort(),
      "their own birthday events are hidden, and the rest of the family's list is intact");
    assert.ok(hidden.includes(f.birthday), "including the one with the planning behind it");
    assert.ok(all.length > hidden.length, "and they can still see a dashboard");
  });

  test("SO THE EVENT PAGE 404s, because requireEvent resolves through the same RLS", () => {
    // The server half of the same fact: the loader has no service-role path to
    // fall back on, and answers `notFound()` when the row does not arrive.
    const loader = read("src", "utils", "supabase", "events-server.ts");
    const gate = loader.slice(loader.indexOf("export async function requireEvent"));
    assert.match(gate, /notFound\(\)/u);
    assert.ok(!/service|SERVICE_ROLE/iu.test(gate.slice(0, 800)),
      "a service-role read here would bypass the surprise rule entirely");
  });

  test("what is NOT a secret stays visible: their own name, and their birthday DATE", async () => {
    /*
     * Migration 031 is explicit that `people` and `app_members` are left alone:
     * "a birthday DATE is not a secret; the planning is." Over-hiding would be
     * its own bug -- the celebrant would lose their own profile.
     */
    assert.equal(await seen(db, celebrant(), "people", "id = $1", [f.people.taylor]), 1);
    const me = await probe(db, celebrant(),
      "select name, birthday_month, birthday_day from public.people where id = $1", [f.people.taylor]);
    assert.equal(me.count, 1);
    assert.ok(me.rows[0].birthday_month, "they can still see when their own birthday is");
    assert.equal(await seen(db, celebrant(), "app_members", "person_id = $1", [f.people.taylor]), 1);
  });

  test("and SOMEBODY ELSE'S birthday in the same family is perfectly normal to them", async () => {
    // The rule is about their own event, not about birthdays.
    assert.equal(await seen(db, celebrant(), "events", "id = $1", [f.adminBirthday]), 1);
  });

  test("AN ADMINISTRATOR WHO IS THE CELEBRANT IS BLOCKED FROM THE EVENT TOO", async () => {
    // Ada administers Alpha and Alpha is planning Ada's birthday. Every
    // permission the application has, and the surprise rule still wins on read.
    const admin = who(f.users.dual, f.areas.alpha);
    assert.equal((await probeValue(db, admin, "select public.is_app_admin()")).value, true);
    assert.equal(await seen(db, admin, "events", "id = $1", [f.adminBirthday]), 0,
      "their own birthday event is not theirs to open");
    assert.equal(await seen(db, admin, "events", "id = $1", [f.birthday]), 1,
      "and everybody else's still is");
  });

  test("A PLANNER ACTION ON THEIR OWN BIRTHDAY IS REFUSED EVEN FOR THE ADMINISTRATOR", async () => {
    /*
     * Migration 031's `refuse_celebrant_as_own_contributor`. Being financially
     * entangled with your own surprise is refused at the table, so it holds for
     * the one caller who passes every permission check above it.
     */
    const admin = who(f.users.dual, f.areas.alpha);
    const refused = await probe(db, admin,
      "select public.set_event_contributor($1,$2,true)", [f.adminBirthday, f.people.ada]);
    assert.equal(refused.ok, false, "the celebrant cannot be made to chip in for their own present");

    await asOwner(db);
    assert.equal(
      await value(db, "select count(*)::int from public.contributors where christmas_event_id = $1 and person_id = $2",
        [f.adminBirthday, f.people.ada]), 0);
  });
});
