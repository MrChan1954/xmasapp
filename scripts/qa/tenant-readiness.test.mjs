/**
 * IS THE TENANT BOUNDARY GOOD ENOUGH TO HOST A TEST TENANT IN THE REAL DATABASE?
 *
 * This is the question the same-database QA strategy rests on, and it deserves
 * to be asked in one place rather than inferred from sixty tests spread across
 * five files.
 *
 * The strategy is: put the synthetic Areas in the SAME database as the real
 * family, and let the product's own tenant boundary keep them apart. That is
 * only safe if the boundary is complete -- not "mostly", and not "for the
 * tables anybody thought to check". A single category that leaks turns every
 * destructive QA journey into a risk to real data.
 *
 * SO THIS SWEEPS RATHER THAN SAMPLES. For every table protected by row level
 * security, it collects the ids that genuinely belong to Bravo -- read with
 * OWNER rights, so the list is the truth rather than what somebody can already
 * see -- and then asks an ordinary member of Alpha to count them. The answer
 * must be zero, every time.
 *
 * AND THE LIST OF TABLES IS CHECKED AGAINST THE DATABASE'S OWN CATALOGUE, so a
 * table added later cannot quietly go unswept. `birthday_wishlist_ideas`
 * arrived in migration 040 exactly that way.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: relax anything to make QA easier. If a
 * category cannot be proven separate, the correct outcome is that the QA plan
 * does not proceed.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";

import { asOwner, attempt, buildRehearsal, probe, rows, value } from "../pg/rehearsal.mjs";
import { buildTwoFamilies } from "../pg/fixtures.mjs";

let db;
let f;

const who = (user, area) => ({ user, area });

/**
 * GIVE BRAVO SOMETHING IN EVERY CATEGORY, so the sweep below has something to
 * prove with.
 *
 * The shared fixture builds Bravo as a lightly-populated second family, which
 * is right for the tests that use it but leaves most tables with no Bravo rows
 * at all -- and a sweep over an empty table proves nothing whatsoever. Each
 * insert here is the minimum row the constraints accept.
 */
async function seedBravoBreadth() {
  await asOwner(db);
  const one = async (sql, params) => (await attempt(db, sql, params)).rows?.[0]?.id ?? null;

  const recipient = await value(db,
    "select r.id from public.christmas_recipients r"
    + " join public.events e on e.id = r.christmas_event_id where e.area_id = $1 limit 1", [f.areas.bravo]);
  const contributor = await value(db,
    "select c.id from public.contributors c"
    + " join public.events e on e.id = c.christmas_event_id where e.area_id = $1 limit 1", [f.areas.bravo]);
  const member = await value(db,
    "select id from public.app_members where area_id = $1 limit 1", [f.areas.bravo]);

  await one(`insert into public.gift_ideas (christmas_recipient_id, title, suggested_by_app_member_id)
             values ($1, 'QA idea', $2) returning id`, [recipient, member]);

  const purchase = await one(`
    insert into public.purchases
      (christmas_recipient_id, description, actual_price_pennies,
       checkout_payer_contributor_id, created_by_app_member_id)
    values ($1, 'QA purchase', 1000, $2, $3) returning id`, [recipient, contributor, member]);

  if (purchase) {
    await one(`insert into public.purchase_allocations (purchase_id, contributor_id, responsibility_pennies)
               values ($1, $2, 1000) returning id`, [purchase, contributor]);
    await one(`insert into public.item_photos (purchase_id, storage_path, uploaded_by_app_member_id)
               values ($1, 'qa/bravo.jpg', $2) returning id`, [purchase, member]);
  }

  await one(`insert into public.notifications (app_member_id, category, title, body, target_url)
             values ($1, 'purchases', 'QA', 'QA', '/') returning id`, [member]);
  await one("insert into public.notification_preferences (app_member_id) values ($1) returning app_member_id",
    [member]);
  await one(`insert into public.push_subscriptions (app_member_id, endpoint, p256dh, auth)
             values ($1, 'https://qa.invalid/endpoint',
                     'BJ0000000000000000000000000000000000000000000',
                     'AAAAAAAAAAAAAAAAAAAAAA') returning id`, [member]);

  // The wishlist refuses anybody but the birthday person, so it is written the
  // only way it can be: as Sam, whose birthday it is, through a real request.
  await probe(db, who(f.users.sam, f.areas.bravo),
    "insert into public.birthday_wishlist_ideas (person_id, occurrence_year, title) values ($1, 2099, 'QA wish')",
    [f.people.sam]);

  await asOwner(db);
}

before(async () => {
  db = await buildRehearsal({});
  f = await buildTwoFamilies(db);
  await seedBravoBreadth();
});
after(async () => { await db?.close(); });

// The four roots that carry `area_id` themselves. Everything else reaches an
// Area through one of these, which is the shape migration 034 chose.
const PEOPLE = "select id from public.people where area_id = $1";
const MEMBERS = "select id from public.app_members where area_id = $1";
const EVENTS = "select id from public.events where area_id = $1";

const RECIPIENTS =
  "select r.id from public.christmas_recipients r"
  + " join public.events e on e.id = r.christmas_event_id where e.area_id = $1";

const PURCHASES =
  "select pu.id from public.purchases pu where pu.christmas_recipient_id in (" + RECIPIENTS + ")";

/** Every RLS-protected table, and how one of its rows is traced to an Area. */
const TRACED_TO_AREA = [
  ["people", PEOPLE],
  ["events", EVENTS],
  ["app_members", MEMBERS],
  ["audit_log", "select id from public.audit_log where area_id = $1"],
  ["birthday_wishlist_ideas", "select id from public.birthday_wishlist_ideas where area_id = $1"],
  ["christmas_recipients", RECIPIENTS],
  ["contributors",
    "select c.id from public.contributors c join public.events e on e.id = c.christmas_event_id where e.area_id = $1"],
  ["gift_ideas",
    "select g.id from public.gift_ideas g where g.christmas_recipient_id in (" + RECIPIENTS + ")"],
  ["purchases", PURCHASES],
  ["purchase_allocations",
    "select a.id from public.purchase_allocations a where a.purchase_id in (" + PURCHASES + ")"],
  ["recipient_contributions",
    "select rc.id from public.recipient_contributions rc"
    + " where rc.christmas_recipient_id in (" + RECIPIENTS + ")"],
  ["settlements",
    "select s.id from public.settlements s join public.events e on e.id = s.christmas_event_id where e.area_id = $1"],
  ["payment_receipts",
    "select r.id from public.payment_receipts r join public.events e on e.id = r.christmas_event_id where e.area_id = $1"],
  ["item_photos",
    "select ip.id from public.item_photos ip where ip.purchase_id in (" + PURCHASES + ")"],
  ["notifications",
    "select n.id from public.notifications n where n.app_member_id in (" + MEMBERS + ")"],
  ["push_subscriptions",
    "select ps.id from public.push_subscriptions ps where ps.app_member_id in (" + MEMBERS + ")"],
  ["notification_preferences",
    "select p.app_member_id as id from public.notification_preferences p"
    + " where p.app_member_id in (" + MEMBERS + ")"],
  ["birthday_reminders",
    "select b.id from public.birthday_reminders b where b.person_id in (" + PEOPLE + ")"],
  ["birthday_budget_summaries",
    "select b.id from public.birthday_budget_summaries b where b.contributor_person_id in (" + PEOPLE + ")"],
  ["notification_events",
    "select n.id from public.notification_events n where n.actor_app_member_id in (" + MEMBERS + ")"],
  ["notification_outbox",
    "select n.id from public.notification_outbox n where n.actor_app_member_id in (" + MEMBERS + ")"],
];

/**
 * `areas` is swept differently and on purpose: an Area's own row is not traced
 * to an Area, it IS one, so the assertion is that Bravo's row is invisible in
 * Alpha rather than that its children are.
 */
const NOT_TRACED = new Set(["areas"]);

describe("every category of family data is separate between two Areas", () => {
  test("NOT ONE ROW OF BRAVO'S IS VISIBLE TO A MEMBER OF ALPHA", async () => {
    /*
     * The whole strategy in one assertion. `mo` is an ordinary active member of
     * Alpha and of nothing else -- the least privileged real reader there is.
     */
    const leaks = [];
    const swept = [];

    for (const [table, sql] of TRACED_TO_AREA) {
      await asOwner(db);
      const bravoIds = (await rows(db, sql, [f.areas.bravo])).map((row) => row.id);
      if (bravoIds.length === 0) continue;
      swept.push(table);

      const key = table === "notification_preferences" ? "app_member_id" : "id";
      const seen = await probe(db, who(f.users.mo, f.areas.alpha),
        `select count(*)::int as n from public.${table} where ${key} = any($1::uuid[])`, [bravoIds]);

      // A refusal is a pass: the boundary answering loudly rather than quietly.
      // Rows coming back is the failure.
      const visible = seen.ok ? seen.rows[0].n : 0;
      if (visible > 0) {
        leaks.push(`${table}: ${visible} of Bravo's ${bravoIds.length} rows visible in Alpha`);
      }
    }

    assert.deepEqual(leaks, []);

    /*
     * AND THE SWEEP MUST HAVE HAD TEETH. A table with no Bravo rows proves
     * nothing, so the categories that matter most to a destructive QA tenant --
     * the people, the money, and the things a test would create -- are named
     * and required to have been swept rather than merely listed above.
     */
    for (const category of [
      "people", "events", "app_members", "audit_log",
      "christmas_recipients", "contributors", "recipient_contributions",
      "gift_ideas", "purchases", "purchase_allocations",
      "notifications", "birthday_wishlist_ideas",
    ]) {
      assert.ok(swept.includes(category),
        `${category} had no Bravo rows, so its separation was not actually proven`);
    }
  });

  test("and the sweep covers every table row level security protects", async () => {
    await asOwner(db);
    const known = new Set(TRACED_TO_AREA.map(([table]) => table));
    const protectedTables = (await rows(db, `
      select c.relname as name from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity
      order by c.relname`)).map((row) => row.name);

    const unswept = protectedTables.filter((name) => !known.has(name) && !NOT_TRACED.has(name));
    assert.deepEqual(unswept, [],
      "a protected table nobody sweeps is where the next leak will be");
  });

  test("an Area's own row is invisible from outside it", async () => {
    const seen = await probe(db, who(f.users.mo, f.areas.alpha),
      "select id from public.areas where id = $1", [f.areas.bravo]);
    assert.equal(seen.rows.length, 0, "Bravo is not even visible as an Area to somebody outside it");
  });
});

describe("the things a QA tenant needs, one by one", () => {
  const inAlpha = (sql, params) => probe(db, who(f.users.mo, f.areas.alpha), sql, params);

  test("separate People", async () => {
    assert.equal((await inAlpha("select name from public.people where area_id = $1", [f.areas.bravo])).rows.length, 0);
  });

  test("separate memberships, and separate ROLES for one login", async () => {
    // `dual` administers Alpha and is an ordinary member of Bravo.
    const alpha = await probe(db, who(f.users.dual, f.areas.alpha), "select public.is_area_admin($1) as a", [f.areas.alpha]);
    const bravo = await probe(db, who(f.users.dual, f.areas.bravo), "select public.is_area_admin($1) as a", [f.areas.bravo]);
    assert.equal(alpha.rows[0].a, true);
    assert.equal(bravo.rows[0].a, false, "one login, two Areas, two different roles");
  });

  test("separate events and birthdays", async () => {
    assert.equal((await inAlpha("select id from public.events where area_id = $1", [f.areas.bravo])).rows.length, 0);
    assert.equal((await inAlpha("select id from public.events where id = $1", [f.bravoBirthday])).rows.length, 0);
  });

  test("separate gift ideas", async () => {
    await asOwner(db);
    const bravoIdeas = (await rows(db,
      "select g.id from public.gift_ideas g where g.christmas_recipient_id in (" + RECIPIENTS + ")",
      [f.areas.bravo])).map((row) => row.id);
    if (bravoIdeas.length > 0) {
      const seen = await inAlpha("select count(*)::int as n from public.gift_ideas where id = any($1::uuid[])", [bravoIdeas]);
      assert.equal(seen.ok ? seen.rows[0].n : 0, 0);
    }
    // Alpha's own ideas are still readable by Alpha's planners -- the boundary
    // is between families, not a blanket refusal.
    assert.ok((await inAlpha("select id from public.gift_ideas")).ok);
  });

  test("separate purchases and balances", async () => {
    const seen = await inAlpha(
      "select count(*)::int as n from public.purchases where christmas_recipient_id in (" + RECIPIENTS + ")",
      [f.areas.bravo]);
    assert.equal(seen.ok ? seen.rows[0].n : 0, 0, "Alpha must see none of Bravo's purchases");
  });

  test("separate notifications", async () => {
    const seen = await inAlpha(
      "select count(*)::int as n from public.notifications where app_member_id in (" + MEMBERS + ")",
      [f.areas.bravo]);
    assert.equal(seen.ok ? seen.rows[0].n : 0, 0);
  });

  test("separate settings -- an Area's name is its own", async () => {
    assert.equal((await inAlpha("select id from public.areas where id = $1", [f.areas.bravo])).rows.length, 0);
  });

  test("and Area switching resolves identity per Area, not per login", async () => {
    for (const [area, expected] of [[f.areas.alpha, f.people.ada], [f.areas.bravo, f.people.jo]]) {
      const person = await probe(db, who(f.users.dual, area), "select public.current_person_id() as p");
      assert.equal(person.rows[0].p, expected);
    }
  });
});

describe("what this means for putting a test tenant in the real database", () => {
  test("a third Area is invisible to the others", async () => {
    // The plan is two synthetic Areas beside the real one. Charlie stands in
    // for that arrangement: `dual` administers it, and Alpha's other members
    // cannot see that it exists.
    assert.equal((await probe(db, who(f.users.mo, f.areas.alpha),
      "select id from public.areas where id = $1", [f.areas.charlie])).rows.length, 0);
    assert.equal((await probe(db, who(f.users.jade, f.areas.alpha),
      "select count(*)::int as n from public.people where area_id = $1", [f.areas.charlie])).rows[0].n, 0);
  });

  test("AND A WRITE IN ONE AREA CANNOT REACH ANOTHER", async () => {
    /*
     * Migration 037's barrier, and the reason a synthetic tenant is safe to be
     * destructive in. Moving a row between Areas is the sharpest form of the
     * question: the caller administers Charlie, owns the row, and is asking for
     * it to become Alpha's.
     */
    await asOwner(db);
    const charliePerson = await value(db,
      "select id from public.people where area_id = $1 limit 1", [f.areas.charlie]);
    assert.ok(charliePerson, "Charlie must have somebody in it for this to mean anything");

    const moved = await probe(db, who(f.users.dual, f.areas.charlie),
      "update public.people set area_id = $1 where id = $2 returning id", [f.areas.alpha, charliePerson]);
    assert.equal(moved.ok, false, "a write naming another Area must be refused");

    await asOwner(db);
    assert.equal(
      await value(db, "select area_id from public.people where id = $1", [charliePerson]),
      f.areas.charlie, "and the row must not have moved");
  });
});
