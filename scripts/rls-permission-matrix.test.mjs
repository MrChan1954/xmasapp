/**
 * THE PERMISSION MATRIX, EXECUTED RATHER THAN READ.
 *
 * Every other security suite here proves one rule deeply. This one proves the
 * WHOLE SURFACE shallowly and by CATALOGUE: it asks PostgreSQL which tables,
 * views, policies and functions exist, and then asks each of them the same
 * questions on behalf of each kind of caller. A table added by a future
 * migration joins these tests the moment it is created, because nothing here
 * names tables by hand where the catalogue can name them instead.
 *
 * WHAT A REFUSAL LOOKS LIKE, AND WHY IT MATTERS
 *
 *   allowed   the statement ran and returned rows
 *   hidden    the statement ran and returned NOTHING -- RLS filtered it away
 *   refused   the database raised, with a SQLSTATE
 *
 * These are three different outcomes and the tests below say which one they
 * expect. A DELETE that matches no rows is `hidden`, not `refused`; a missing
 * grant is `refused` with 42501. Collapsing them would let a setup mistake
 * masquerade as a security control, which is the failure mode this file exists
 * to avoid: A SETUP OR PARSE FAILURE IS NEVER AN RLS PASS.
 *
 * `docs/RLS-PERMISSION-MATRIX.md` is the human-readable summary of what is
 * asserted here. This file is the source of truth; the document follows it.
 */
import test, { before, describe } from "node:test";
import assert from "node:assert/strict";

import { asOwner, attempt, buildRehearsal, probe, rows, value } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

let db;
let f;
let outsider;      // authenticated, no membership anywhere
let charlie;       // content inside Charlie, built through the real routines
let settlement;    // a live payer/receiver scenario inside Alpha

/** Acting identities. `dual` is admin of Alpha AND Charlie, member of Bravo. */
const who = {};

// ---------------------------------------------------------------------------
// Outcome vocabulary
// ---------------------------------------------------------------------------

function outcome(result) {
  if (!result.ok) return "refused";
  return result.count > 0 ? "allowed" : "hidden";
}

function assertRefused(result, why) {
  assert.equal(
    outcome(result),
    "refused",
    `${why}: expected the database to raise, got ${outcome(result)}${result.ok ? "" : ` (${result.error})`}`,
  );
  assert.ok(result.code, `${why}: a refusal must carry a SQLSTATE`);
}

/** Refused outright, or filtered to nothing. Both are a "no"; neither is a leak. */
function assertDenied(result, why) {
  assert.notEqual(
    outcome(result),
    "allowed",
    `${why}: expected no rows and no effect, got ${result.count} row(s)`,
  );
}

function assertAllowed(result, why) {
  assert.equal(
    outcome(result),
    "allowed",
    `${why}: expected it to work, got ${outcome(result)}${result.ok ? "" : ` (${result.error})`}`,
  );
}

const P = (actor, sql, params) => probe(db, actor, sql, params);

async function owner(sql, params) {
  await asOwner(db);
  const result = await attempt(db, sql, params);
  await asOwner(db);
  return result;
}

async function count(actor, sql, params) {
  const result = await P(actor, sql, params);
  if (!result.ok) return `refused(${result.code})`;
  return result.rows[0] ? Number(Object.values(result.rows[0])[0]) : 0;
}

before(async () => {
  db = await buildRehearsal();
  f = await buildTwoFamilies(db);
  await asOwner(db);

  outsider = await value(
    db,
    `insert into auth.users (email, email_confirmed_at) values ('nobody@example.test', now()) returning id`,
  );
  await asOwner(db);

  Object.assign(who, {
    anon: { user: null, area: undefined },
    outsider: { user: outsider, area: f.areas.alpha },
    mo: { user: f.users.mo, area: f.areas.alpha },
    jade: { user: f.users.jade, area: f.areas.alpha },
    jadeInBravo: { user: f.users.jade, area: f.areas.bravo },
    taylor: { user: f.users.taylor, area: f.areas.alpha },
    sam: { user: f.users.sam, area: f.areas.bravo },
    dualAlpha: { user: f.users.dual, area: f.areas.alpha },
    dualBravo: { user: f.users.dual, area: f.areas.bravo },
    dualCharlie: { user: f.users.dual, area: f.areas.charlie },
    dualNowhere: { user: f.users.dual, area: undefined },
  });

  charlie = await buildCharlie();
  settlement = await buildSettlement();

  /**
   * The fixture's own-birthday purchase is written directly and carries no
   * allocation, so "the celebrant cannot see purchase_allocations" would pass
   * against an empty table and prove nothing. Give it the allocation it would
   * have had, so the assertion has something to fail on.
   */
  const allocated = await owner(
    `insert into public.purchase_allocations (purchase_id, contributor_id, responsibility_pennies)
     values ($1,$2,12900) returning id`,
    [f.purchase, f.jadeContributor]);
  assert.ok(allocated.ok, `the own-birthday allocation must exist: ${allocated.error}`);
});

/**
 * Content inside CHARLIE, created by the one account that administers it.
 *
 * Charlie is the sharp edge of the whole matrix. `dual` administers Alpha AND
 * Charlie, so when they stand in Alpha and reach for Charlie every ROLE check
 * passes -- `is_app_admin()` is true, `is_area_admin(charlie)` is true. Only a
 * check against the Area they are STANDING IN can refuse it. An Area rule that
 * asked "are you an admin of the target" instead of "is the target where you
 * are" would look perfectly correct until this fixture asked it.
 */
async function buildCharlie() {
  const person = await probeValue(who.dualCharlie, `select id from public.create_person($1,null,null,null)`, ["Cid"]);
  const event = await probeValue(
    who.dualCharlie,
    `select id from public.create_event($1,'christmas','2027-12-25',null,null,$2::uuid[],$3::uuid[])`,
    ["Charlie Christmas", [person, f.people.cass], [person, f.people.cass]],
  );
  const recipient = await value(
    db,
    `select id from public.christmas_recipients where christmas_event_id=$1 and person_id=$2`,
    [event, person],
  );
  await asOwner(db);
  const idea = await probeValue(
    who.dualCharlie,
    `select id from public.save_gift_idea(null,$1,'charlie idea',500,null,null,null)`,
    [recipient],
  );
  const contributors = await rows(
    db,
    `select c.id, p.name from public.contributors c join public.people p on p.id=c.person_id
      where c.christmas_event_id=$1 order by p.name`,
    [event],
  );
  await asOwner(db);

  assert.ok(person && event && recipient && idea, "Charlie fixture must exist or every attack below is vacuous");
  return { person, event, recipient, idea, contributors };
}

/**
 * A real debt inside Alpha: Jade pays 5000 for Mo's gift, Mo owes all of it.
 * Taylor is made a contributor too, so "a contributor from OUTSIDE the pair"
 * is a caller that actually exists.
 */
async function buildSettlement() {
  for (const person of [f.people.mo, f.people.taylor]) {
    await probeValue(who.dualAlpha, `select public.set_family_contributor($1,true)`, [person]);
  }
  const event = await probeValue(
    who.dualAlpha,
    `select id from public.create_event($1,'christmas','2027-12-25',null,null,$2::uuid[],$3::uuid[])`,
    ["Alpha Christmas", [f.people.mo, f.people.jade], [f.people.jade, f.people.mo, f.people.taylor]],
  );
  const recipient = await value(
    db,
    `select id from public.christmas_recipients where christmas_event_id=$1 and person_id=$2`,
    [event, f.people.mo],
  );
  await asOwner(db);
  const contributors = await rows(
    db,
    `select c.id, p.name from public.contributors c join public.people p on p.id=c.person_id
      where c.christmas_event_id=$1 order by p.name`,
    [event],
  );
  await asOwner(db);
  const by = Object.fromEntries(contributors.map((c) => [c.name, c.id]));

  const purchase = await P(
    who.jade,
    `select id from public.save_purchase_with_location(
       null,$1,'gift',5000,$2,null,current_date,null,null,'purchased','custom',null,$3::jsonb)`,
    [recipient, by.Jade, JSON.stringify([{ contributor_id: by.Mo, responsibility_pennies: 5000 }])],
  );
  assert.ok(purchase.ok, `the debt must exist or every settlement test is vacuous: ${purchase.error}`);

  /**
   * One payment recorded BY THE RECEIVER, purely so a receipt exists before the
   * append-only test runs. The receiver's own record self-confirms and writes an
   * `auto_receipt`, which is the cheapest way to put real evidence in the table.
   */
  const seeded = await P(who.jade, `select id from public.record_settlement($1,$2,$3,100,current_date,null)`,
    [event, by.Mo, by.Jade]);
  assert.ok(seeded.ok, `a receipt must exist before evidence can be tested: ${seeded.error}`);

  return { event, recipient, contributors: by };
}

async function probeValue(actor, sql, params) {
  const result = await P(actor, sql, params);
  return result.ok && result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
}

// ---------------------------------------------------------------------------

describe("the surface itself", () => {
  test("every table in public has row level security enabled", async () => {
    const open = await rows(db, `
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`);
    assert.deepEqual(open.map((r) => r.relname), [], "a table without RLS is open to every authenticated caller");
  });

  test("a table with RLS and no policy is closed, not open", async () => {
    const silent = await rows(db, `
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
        and not exists (select 1 from pg_policy p where p.polrelid = c.oid) order by 1`);
    // These are the service-role queues. PostgreSQL denies everything to a
    // non-owner when RLS is on and no policy admits them, which is the
    // fail-closed direction -- but only if no grant lets a client in first.
    for (const { relname } of silent) {
      assert.equal(
        await count(who.mo, `select count(*)::int from public.${relname}`),
        "refused(42501)",
        `${relname} has no policy, so no client may reach it at all`,
      );
    }
  });

  test("every view runs with the caller's own rights, not its owner's", async () => {
    const views = await rows(db, `
      select c.relname,
        coalesce((select option_value from pg_options_to_table(c.reloptions)
                  where option_name = 'security_invoker'), 'not set') as invoker
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v','m') order by 1`);
    for (const v of views) {
      assert.equal(
        v.invoker, "true",
        `view ${v.relname} without security_invoker reads its OWNER's rows and bypasses RLS entirely`,
      );
    }
  });

  test("anon holds no grant on any table or view in public", async () => {
    const granted = await rows(db, `
      select distinct table_name from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon' order by 1`);
    assert.deepEqual(granted.map((r) => r.table_name), []);
  });
});

describe("A. the signed-out visitor", () => {
  test("cannot read or write any table or view, and is refused by grant", async () => {
    const tables = await rows(db, `
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','v') order by 1`);
    assert.ok(tables.length >= 20, "the catalogue query itself must find the schema");

    for (const { relname } of tables) {
      const read = await P(who.anon, `select count(*)::int n from public.${relname}`);
      assertRefused(read, `anon reading ${relname}`);
      const write = await P(who.anon, `delete from public.${relname} where false`);
      assertRefused(write, `anon deleting from ${relname}`);
    }
  });

  test("may execute nothing but the pre-request hook and its own acting Area", async () => {
    const callable = await rows(db, `
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype
        and has_function_privilege('anon', p.oid, 'EXECUTE')
        and p.proname not similar to
            '(armor|crypt|dearmor|decrypt%|digest|encrypt%|fips_mode|gen_random%|gen_salt|hmac|pgp_%)'
      order by 1`);
    assert.deepEqual(
      callable.map((r) => r.proname),
      ["acting_area", "claim_active_area"],
      "PostgREST must be able to run the pre-request hook as anon; nothing else belongs here",
    );
  });

  test("the trigger functions anon still holds EXECUTE on cannot be invoked", async () => {
    const triggers = await rows(db, `
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prorettype = 'trigger'::regtype
        and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1`);
    assert.ok(triggers.length > 0, "this test is about the ones that ARE granted");
    for (const { proname } of triggers) {
      const result = await P(who.anon, `select public.${proname}()`);
      assertRefused(result, `anon calling trigger function ${proname}`);
      assert.equal(result.code, "0A000", "PostgreSQL refuses a direct trigger invocation");
    }
  });
});

describe("B. an authenticated stranger", () => {
  test("sees nothing at all, in any Area, however they name it", async () => {
    for (const table of ["people", "events", "audit_log", "app_members", "gift_ideas", "purchases", "settlements"]) {
      assert.equal(await count(who.outsider, `select count(*)::int from public.${table}`), 0,
        `a non-member read ${table}`);
    }
  });

  test("claiming an Area they do not belong to leaves them with no acting Area", async () => {
    const claimed = await P(who.outsider, `select public.acting_area() a`);
    assert.equal(claimed.rows[0].a, null, "a hostile x-area-id must not become an acting Area");
  });

  test("cannot reach a routine even with a real id from a real family", async () => {
    assertRefused(
      await P(who.outsider, `select id from public.save_gift_idea(null,$1,'x',100,null,null,null)`, [f.recipient]),
      "a stranger writing into Alpha",
    );
  });
});

describe("C. the acting Area is a claim, and it is checked", () => {
  test("it resolves to the Area named, for each membership in turn", async () => {
    assert.equal(await probeValue(who.dualAlpha, `select public.acting_area() a`), f.areas.alpha);
    assert.equal(await probeValue(who.dualBravo, `select public.acting_area() a`), f.areas.bravo);
    assert.equal(await probeValue(who.dualCharlie, `select public.acting_area() a`), f.areas.charlie);
  });

  test("a member of one Area cannot claim another, and gets nothing rather than something", async () => {
    const claimed = await P(who.mo, `select public.acting_area() a`, undefined);
    assert.equal(claimed.rows[0].a, f.areas.alpha, "Mo's own Area still resolves");
    const hostile = await P({ user: f.users.mo, area: f.areas.bravo }, `select public.acting_area() a`);
    assert.equal(hostile.rows[0].a, null, "claiming Bravo without membership must yield NO acting Area");
  });

  test("several memberships and no choice is answered with none, never with a guess", async () => {
    const none = await P(who.dualNowhere, `select public.acting_area() a`);
    assert.equal(none.rows[0].a, null,
      "an account in three families must not have one picked for it");
  });

  test("membership answers about the account, acting answers about the request", async () => {
    for (const [area, expected] of [[f.areas.alpha, true], [f.areas.bravo, true], [f.areas.charlie, true]]) {
      assert.equal(await probeValue(who.dualAlpha, `select public.is_area_member($1) v`, [area]), expected);
    }
    assert.equal(await probeValue(who.dualAlpha, `select public.is_acting_area($1) v`, [f.areas.alpha]), true);
    assert.equal(await probeValue(who.dualAlpha, `select public.is_acting_area($1) v`, [f.areas.bravo]), false);
    assert.equal(await probeValue(who.dualAlpha, `select public.is_acting_area($1) v`, [f.areas.charlie]), false,
      "administering Charlie does not mean standing in it");
  });
});

describe("D. no client writes a domain table directly", () => {
  /**
   * The write surface a browser actually has is far smaller than the policy
   * list suggests: most domain tables grant `authenticated` nothing but SELECT,
   * so their INSERT/UPDATE/DELETE policies are unreachable and every write goes
   * through a SECURITY DEFINER routine instead. This proves the grant, because
   * a future migration that handed out a write grant would open a door that no
   * policy here was written to guard.
   */
  test("the domain tables refuse a direct write from their own Area's administrator", async () => {
    const cases = [
      ["people", `insert into public.people (area_id,name) values ($1,'X') returning id`, [f.areas.alpha]],
      ["people", `update public.people set name='x' where id=$1 returning id`, [f.people.mo]],
      ["people", `delete from public.people where id=$1 returning id`, [f.people.mo]],
      ["gift_ideas", `delete from public.gift_ideas where id=$1 returning id`, [f.secretIdea]],
      ["purchases", `delete from public.purchases where id=$1 returning id`, [f.purchase]],
      ["settlements", `insert into public.settlements
         (christmas_event_id,payer_contributor_id,payee_contributor_id,amount_pennies,recorded_by_app_member_id)
         values ($1,$2,$3,1,$4) returning id`,
        [settlement.event, settlement.contributors.Mo, settlement.contributors.Jade, f.members.jadeAlpha]],
      ["audit_log", `insert into public.audit_log (area_id,table_name,record_id,action,summary)
         values ($1,'people',gen_random_uuid(),'added','x') returning id`, [f.areas.alpha]],
    ];
    for (const [table, sql, params] of cases) {
      assertRefused(await P(who.dualAlpha, sql, params), `direct write to ${table}`);
    }
  });

  test("payment evidence is append-only to every client, administrator included", async () => {
    const receipt = await value(db, `select id from public.payment_receipts limit 1`);
    await asOwner(db);
    assert.ok(receipt, "there must be a receipt or this test proves nothing");
    for (const actor of ["jade", "dualAlpha"]) {
      assertRefused(
        await P(who[actor], `update public.payment_receipts set amount_pennies=1 where id=$1 returning id`, [receipt]),
        `${actor} rewriting a receipt`,
      );
      assertRefused(
        await P(who[actor], `delete from public.payment_receipts where id=$1 returning id`, [receipt]),
        `${actor} deleting a receipt`,
      );
    }
  });

  test("an Area row cannot be created, renamed or removed by hand", async () => {
    assertRefused(await P(who.dualAlpha, `insert into public.areas (name) values ('Rogue') returning id`),
      "inserting an Area directly");
    assertDenied(await P(who.dualAlpha, `update public.areas set name='x' where id=$1 returning id`, [f.areas.bravo]),
      "renaming another Area by hand");
    assertDenied(await P(who.dualAlpha, `delete from public.areas where id=$1 returning id`, [f.areas.bravo]),
      "deleting another Area by hand");
  });
});

describe("E. the acting Area governs every routine that changes something", () => {
  /**
   * The same call, twice: once aimed at a family where the caller is a mere
   * member (BRAVO), once aimed at a family the caller ADMINISTERS (CHARLIE).
   * Both must be refused while standing in Alpha, and the Charlie half is the
   * one that matters -- it is the only way to tell an Area check apart from a
   * role check.
   */
  function attacks() {
    const b = { event: f.bravoBirthday, recipient: f.bravoRecipient, person: f.people.jo, area: f.areas.bravo };
    const c = { event: charlie.event, recipient: charlie.recipient, person: charlie.person, area: f.areas.charlie };
    const build = (t, label) => [
      [`set_person_name (${label})`, `select public.set_person_name($1,'hacked')`, [t.person]],
      [`set_person_archived (${label})`, `select public.set_person_archived($1,true)`, [t.person]],
      [`set_family_contributor (${label})`, `select public.set_family_contributor($1,true)`, [t.person]],
      [`set_person_birthday (${label})`, `select id from public.set_person_birthday($1,1::smallint,1::smallint,2000::smallint)`, [t.person]],
      [`update_event (${label})`, `select id from public.update_event($1,'hacked',null,null)`, [t.event]],
      [`set_event_status (${label})`, `select public.set_event_status($1,'archived')`, [t.event]],
      [`delete_event_if_empty (${label})`, `select public.delete_event_if_empty($1)`, [t.event]],
      [`add_event_recipient (${label})`, `select public.add_event_recipient($1,$2)`, [t.event, t.person]],
      [`set_event_contributor (${label})`, `select public.set_event_contributor($1,$2,true)`, [t.event, t.person]],
      [`set_christmas_recipient_active (${label})`, `select public.set_christmas_recipient_active($1,false)`, [t.recipient]],
      [`save_gift_idea (${label})`, `select id from public.save_gift_idea(null,$1,'x',100,null,null,null)`, [t.recipient]],
      [`save_purchase_with_location (${label})`, `select id from public.save_purchase_with_location(
         null,$1,'x',100,$2,null,current_date,null,null,'purchased','automatic',null,null)`,
        [t.recipient, t === b ? null : charlie.contributors[0]?.id]],
      [`save_christmas_recipient_with_contributions (${label})`,
        `select id from public.save_christmas_recipient_with_contributions($1,$2,null,0,'[]'::jsonb)`, [t.recipient, t.event]],
      [`set_area_name (${label})`, `select public.set_area_name($1,'hacked')`, [t.area]],
      [`set_area_archived (${label})`, `select public.set_area_archived($1,true)`, [t.area]],
      [`leave_area (${label})`, `select public.leave_area($1)`, [t.area]],
      [`start_birthday_planning (${label})`, `select id from public.start_birthday_planning($1,'x','2027-06-02',0,'[]'::jsonb)`, [t.person]],
    ];
    return [...build(b, "Bravo: a mere membership"), ...build(c, "Charlie: ALSO administered")];
  }

  test("every mutating routine refuses a target outside the acting Area", async () => {
    const allowed = [];
    for (const [label, sql, params] of attacks()) {
      const result = await P(who.dualAlpha, sql, params);
      if (outcome(result) === "allowed") allowed.push(label);
    }
    assert.deepEqual(allowed, [], "these routines changed another family's data from Alpha");
  });

  test("and the identical calls succeed when the caller stands in the right Area", async () => {
    // Without this the test above would pass just as well if the routines were
    // broken, or the ids were nonsense.
    assertAllowed(await P(who.dualCharlie, `select public.set_person_name($1,'Cid renamed')`, [charlie.person]),
      "renaming a Charlie person while standing in Charlie");
    assertAllowed(
      await P(who.dualCharlie, `select id from public.save_gift_idea(null,$1,'ok',100,null,null,null)`, [charlie.recipient]),
      "adding a Charlie gift idea while standing in Charlie");
    assertAllowed(await P(who.dualCharlie, `select public.set_area_name($1,'Charlie renamed')`, [f.areas.charlie]),
      "renaming Charlie while standing in Charlie");
  });

  test("belonging to both families is not permission to act across them", async () => {
    // Jade is Jade in Alpha and Jem in Bravo. Both memberships are real.
    assertRefused(
      await P(who.jade, `select id from public.save_gift_idea(null,$1,'x',100,null,null,null)`, [f.bravoRecipient]),
      "an Alpha-acting member writing into Bravo",
    );
    assertAllowed(
      await P(who.jadeInBravo, `select id from public.save_gift_idea(null,$1,'x',100,null,null,null)`, [f.bravoRecipient]),
      "the same person, standing in Bravo",
    );
  });

  test("with no Area claimed at all, a routine refuses rather than picking one", async () => {
    assertRefused(
      await P(who.dualNowhere, `select id from public.save_gift_idea(null,$1,'x',100,null,null,null)`, [f.recipient]),
      "a routine called with no acting Area",
    );
  });
});

describe("F. reading across the Area boundary", () => {
  test("a member of one family sees none of another's rows", async () => {
    for (const table of ["people", "events", "audit_log"]) {
      assert.equal(await count(who.mo, `select count(*)::int from public.${table} where area_id=$1`, [f.areas.bravo]), 0,
        `Mo read Bravo's ${table}`);
    }
    assert.equal(await count(who.sam, `select count(*)::int from public.settlements`), 0,
      "Sam, in Bravo, read Alpha's settlements");
  });

  test("an id from another family is simply not there", async () => {
    assert.equal(await count(who.mo, `select count(*)::int from public.people where id=$1`, [f.people.jo]), 0);
    assert.equal(await count(who.sam, `select count(*)::int from public.gift_ideas where id=$1`, [f.secretIdea]), 0);
  });

  test("the account-global surfaces stay per-account, not per-Area", async () => {
    const notification = await owner(
      `insert into public.notifications (app_member_id,category,title,body,target_url)
       values ($1,'purchases','t','b','/x') returning id`, [f.members.moAlpha]);
    assert.ok(notification.ok, "setup");
    const id = notification.rows[0].id;

    assert.equal(await count(who.mo, `select count(*)::int from public.notifications where id=$1`, [id]), 1);
    assert.equal(await count(who.jade, `select count(*)::int from public.notifications where id=$1`, [id]), 0,
      "another member read someone's notification");
    assert.equal(await count(who.dualAlpha, `select count(*)::int from public.notifications where id=$1`, [id]), 0,
      "the Area administrator read someone's notification");

    assertDenied(await P(who.jade, `update public.notifications set read_at=now() where id=$1 returning id`, [id]),
      "another member marking someone's notification read");
    assertAllowed(await P(who.mo, `update public.notifications set read_at=now() where id=$1 returning id`, [id]),
      "the owner marking their own notification read");
    assertRefused(await P(who.mo, `update public.notifications set title='rewritten' where id=$1 returning id`, [id]),
      "rewriting the CONTENT of a notification");
    assertRefused(await P(who.mo, `delete from public.notifications where id=$1 returning id`, [id]),
      "deleting a notification");

    assertRefused(
      await P(who.jade, `insert into public.notification_preferences (app_member_id) values ($1) returning app_member_id`,
        [f.members.moAlpha]),
      "creating preferences for another member");
    assertDenied(
      await P(who.jade, `select app_member_id from public.notification_preferences where app_member_id=$1`,
        [f.members.moAlpha]),
      "reading another member's preferences");
  });
});

describe("G. the birthday celebrant", () => {
  test("cannot read their own planning through any domain table", async () => {
    const hidden = [
      ["events", `select count(*)::int from public.events where id=$1`, [f.birthday]],
      ["christmas_recipients", `select count(*)::int from public.christmas_recipients where id=$1`, [f.recipient]],
      ["gift_ideas", `select count(*)::int from public.gift_ideas where christmas_recipient_id=$1`, [f.recipient]],
      ["purchases", `select count(*)::int from public.purchases where christmas_recipient_id=$1`, [f.recipient]],
      ["purchase_allocations", `select count(*)::int from public.purchase_allocations where purchase_id=$1`, [f.purchase]],
      ["recipient_contributions", `select count(*)::int from public.recipient_contributions where christmas_recipient_id=$1`, [f.recipient]],
      ["contributors", `select count(*)::int from public.contributors where christmas_event_id=$1`, [f.birthday]],
    ];
    for (const [table, sql, params] of hidden) {
      assert.equal(await count(who.taylor, sql, params), 0, `the celebrant read their own ${table}`);
      assert.notEqual(await count(who.mo, sql, params), 0,
        `${table} is invisible to everyone, so the test above proves nothing`);
    }
  });

  test("self-privacy outranks administering the family", async () => {
    // Ada administers Alpha and Alpha is planning Ada's birthday.
    for (const [label, sql, params] of [
      ["her own birthday event", `select count(*)::int from public.events where id=$1`, [f.adminBirthday]],
      ["her own recipient row", `select count(*)::int from public.christmas_recipients where id=$1`, [f.adminRecipient]],
      ["the idea recorded for her", `select count(*)::int from public.gift_ideas where id=$1`, [f.adminSecretIdea]],
    ]) {
      assert.equal(await count(who.dualAlpha, sql, params), 0, `the administrator read ${label}`);
      assert.notEqual(await count(who.mo, sql, params), 0, `${label} is invisible to everyone`);
    }
    assert.equal(await count(who.dualAlpha, `select count(*)::int from public.list_gift_ideas($1)`, [f.adminRecipient]), 0,
      "the routine handed the administrator her own surprise");
  });

  test("their own wishlist is theirs, and only theirs, to write", async () => {
    const mine = await P(who.taylor,
      `insert into public.birthday_wishlist_ideas (area_id,person_id,occurrence_year,title,created_by_app_member_id)
       values ($1,$2,2027,'socks',$3) returning id`,
      [f.areas.alpha, f.people.taylor, f.members.taylorAlpha]);
    assertAllowed(mine, "the celebrant writing their own wishlist");
    const id = mine.rows[0].id;

    assertRefused(
      await P(who.mo, `insert into public.birthday_wishlist_ideas
         (area_id,person_id,occurrence_year,title,created_by_app_member_id)
         values ($1,$2,2027,'forged',$3) returning id`,
        [f.areas.alpha, f.people.taylor, f.members.moAlpha]),
      "another member writing into the celebrant's wishlist");
    assertDenied(await P(who.mo, `update public.birthday_wishlist_ideas set title='x' where id=$1 returning id`, [id]),
      "another member editing the wishlist");
    assertDenied(await P(who.mo, `delete from public.birthday_wishlist_ideas where id=$1 returning id`, [id]),
      "another member deleting the wishlist");
    assert.equal(await count(who.sam, `select count(*)::int from public.birthday_wishlist_ideas where id=$1`, [id]), 0,
      "another family read the wishlist");
    // The family may READ it -- that is the entire point of a wishlist.
    assert.equal(await count(who.mo, `select count(*)::int from public.birthday_wishlist_ideas where id=$1`, [id]), 1);
  });
});

describe("H. money moves only between the two people it is between", () => {
  test("only the payer or the receiver may record a payment", async () => {
    const { event, contributors } = settlement;
    assertRefused(
      await P(who.taylor, `select id from public.record_settlement($1,$2,$3,1000,current_date,null)`,
        [event, contributors.Mo, contributors.Jade]),
      "a contributor from outside the pair recording it");
    assertRefused(
      await P(who.dualAlpha, `select id from public.record_settlement($1,$2,$3,1000,current_date,null)`,
        [event, contributors.Mo, contributors.Jade]),
      "the Area administrator recording someone else's payment");
    assertRefused(
      await P(who.sam, `select id from public.record_settlement($1,$2,$3,1000,current_date,null)`,
        [event, contributors.Mo, contributors.Jade]),
      "another family recording it");
  });

  test("the payer's claim is pending until the receiver says otherwise", async () => {
    const { event, contributors } = settlement;
    const recorded = await P(who.mo, `select id from public.record_settlement($1,$2,$3,1000,current_date,null)`,
      [event, contributors.Mo, contributors.Jade]);
    assertAllowed(recorded, "the payer recording their own payment");
    const id = recorded.rows[0].id;

    const state = await owner(
      `select amount_pennies a, confirmed_amount_pennies c, status from public.settlements where id=$1`, [id]);
    assert.deepEqual(state.rows[0], { a: 1000, c: 0, status: "pending" },
      "a payer's word must not confirm anything by itself");

    for (const actor of ["mo", "taylor", "dualAlpha"]) {
      assertRefused(await P(who[actor], `select id from public.review_payment($1,'confirm',1000,null)`, [id]),
        `${actor} confirming a payment they are not the receiver of`);
    }
    assertRefused(await P(who.sam, `select id from public.review_payment($1,'confirm',1000,null)`, [id]),
      "another family confirming it");

    assertAllowed(await P(who.jade, `select id from public.review_payment($1,'confirm',400,null)`, [id]),
      "the receiver confirming part of it");
    const partial = await owner(`select confirmed_amount_pennies c, status from public.settlements where id=$1`, [id]);
    assert.deepEqual(partial.rows[0], { c: 400, status: "partially_confirmed" });

    assertRefused(await P(who.jade, `select id from public.review_payment($1,'confirm',5000,null)`, [id]),
      "confirming more than was claimed");
    assertAllowed(await P(who.jade, `select id from public.review_payment($1,'confirm',600,null)`, [id]),
      "the receiver confirming the rest");
    const full = await owner(`select confirmed_amount_pennies c, status from public.settlements where id=$1`, [id]);
    assert.deepEqual(full.rows[0], { c: 1000, status: "confirmed" });
    assertRefused(await P(who.jade, `select id from public.review_payment($1,'confirm',100,null)`, [id]),
      "confirming a payment that is already settled in full");
  });

  test("a rejection is the receiver's to make, and it is final", async () => {
    const { event, contributors } = settlement;
    const recorded = await P(who.mo, `select id from public.record_settlement($1,$2,$3,500,current_date,null)`,
      [event, contributors.Mo, contributors.Jade]);
    assertAllowed(recorded, "setup");
    const id = recorded.rows[0].id;

    assertRefused(await P(who.mo, `select id from public.review_payment($1,'reject',null,'nope')`, [id]),
      "the payer rejecting their own payment");
    assertAllowed(await P(who.jade, `select id from public.review_payment($1,'reject',null,'never arrived')`, [id]),
      "the receiver rejecting it");
    const state = await owner(`select confirmed_amount_pennies c, status from public.settlements where id=$1`, [id]);
    assert.deepEqual(state.rows[0], { c: 0, status: "rejected" });
    assertRefused(await P(who.jade, `select id from public.review_payment($1,'confirm',100,null)`, [id]),
      "confirming a payment already rejected");
  });

  test("when the receiver records it themselves it is confirmed on the spot", async () => {
    const { event, contributors } = settlement;
    const recorded = await P(who.jade, `select id from public.record_settlement($1,$2,$3,500,current_date,null)`,
      [event, contributors.Mo, contributors.Jade]);
    assertAllowed(recorded, "the receiver recording money they have already had");
    const state = await owner(
      `select amount_pennies a, confirmed_amount_pennies c, status from public.settlements where id=$1`,
      [recorded.rows[0].id]);
    assert.deepEqual(state.rows[0], { a: 500, c: 500, status: "confirmed" });
  });

  test("the admin override exists, is admin-only, and cannot cross a family line", async () => {
    const { event, contributors } = settlement;
    assertAllowed(
      await P(who.dualAlpha, `select id from public.admin_record_confirmed_payment($1,$2,$3,100,current_date,'admin fix')`,
        [event, contributors.Mo, contributors.Jade]),
      "the Area administrator using the audited override");
    for (const actor of ["mo", "taylor"]) {
      assertRefused(
        await P(who[actor], `select id from public.admin_record_confirmed_payment($1,$2,$3,100,current_date,'x')`,
          [event, contributors.Mo, contributors.Jade]),
        `${actor} using the administrator's override`);
    }
    assertRefused(
      await P(who.sam, `select id from public.admin_record_confirmed_payment($1,$2,$3,100,current_date,'x')`,
        [event, contributors.Mo, contributors.Jade]),
      "another family using the override");
  });

  test("every override leaves a receipt behind", async () => {
    const receipts = await owner(
      `select count(*)::int n from public.payment_receipts where source <> 'review'`);
    assert.ok(receipts.rows[0].n > 0, "an override that wrote no evidence would be unauditable");
  });
});

describe("I. the audit log", () => {
  test("a deletion by an account in several families is stamped with the one it acted in", async () => {
    // This is migration 049. Before it, `area_of_record` could not answer for a
    // row that had already gone, and the fallback refused to choose between
    // memberships -- so the entry was written with no Area at all.
    const idea = await probeValue(who.jade,
      `select id from public.save_gift_idea(null,$1,'to be deleted',100,null,null,null)`, [f.recipient]);
    const before = await value(db, `select count(*)::int from public.audit_log where area_id is null`);
    await asOwner(db);

    assertAllowed(await P(who.dualAlpha, `select public.remove_gift_idea($1)`, [idea]), "the deletion itself");

    const after = await value(db, `select count(*)::int from public.audit_log where area_id is null`);
    const stamped = await rows(db,
      `select (area_id = $1) as acting from public.audit_log
        where table_name='gift_ideas' and action='removed' order by occurred_at desc limit 1`, [f.areas.alpha]);
    await asOwner(db);

    assert.equal(after, before, "a deletion must not add an Area-less entry");
    assert.equal(stamped[0].acting, true, "the entry must carry the Area the actor was standing in");
  });

  test("an Area-less entry is visible to nobody, and is left where it is", async () => {
    await owner(`insert into public.audit_log (area_id,table_name,record_id,action,summary)
                 values (null,'gift_ideas',gen_random_uuid(),'removed','orphan')`);
    assert.equal(await count(who.mo, `select count(*)::int from public.audit_log where area_id is null`), 0);
    assert.equal(await count(who.dualAlpha, `select count(*)::int from public.audit_log where area_id is null`), 0,
      "not even an administrator sees an entry with no Area");
  });

  test("history does not cross a family line", async () => {
    assert.equal(await count(who.mo, `select count(*)::int from public.audit_log where area_id=$1`, [f.areas.bravo]), 0);
    assert.notEqual(await count(who.mo, `select count(*)::int from public.audit_log where area_id=$1`, [f.areas.alpha]), 0);
  });
});

/**
 * ---------------------------------------------------------------------------
 * J. OPEN FINDINGS
 *
 * These three tests state the rule the application is supposed to keep, and
 * they FAIL against the database as it stands today. They are written first, and
 * deliberately left failing, because a suite that went green around a known leak
 * would be worth less than no suite at all.
 *
 * Each one needs a change to a policy or a routine body, so each one waits on
 * migration 050. None of them can be repaired in application code: the rule has
 * to hold for anything holding a session key, not merely for the screens this
 * repository happens to draw.
 * ---------------------------------------------------------------------------
 */
describe("J. open findings, waiting on migration 050", () => {
  /**
   * RLS-1. `audit_log`'s SELECT policy is `is_active_app_member() AND
   * is_area_member(area_id)`. Every other table that can carry birthday
   * planning also asks `NOT is_own_birthday_...`; this one never did. The rows
   * carry `subject` and `amount_pennies`, and More -> Activity renders both --
   * so the celebrant is shown the name and the price of their own present.
   */
  test("RLS-1: the celebrant is not told about their own birthday by the audit log", async () => {
    const mine = await owner(
      `select l.id from public.audit_log l
        where l.record_id in (select id from public.gift_ideas where christmas_recipient_id = $1)
           or l.record_id in (select id from public.purchases   where christmas_recipient_id = $1)
           or l.record_id = $1`,
      [f.recipient]);
    const ids = mine.rows.map((r) => r.id);
    assert.ok(ids.length > 0, "there must be own-birthday audit rows or this proves nothing");

    const leaked = await P(who.taylor,
      `select table_name, action, subject, amount_pennies from public.audit_log where id = any($1::bigint[])`,
      [ids]);
    assert.equal(leaked.count, 0,
      `the celebrant can read ${leaked.count} audit entries about their own birthday, including ` +
      leaked.rows.map((r) => `${r.subject} (${r.amount_pennies})`).join(", "));
  });

  /**
   * RLS-2. `set_purchase_status` and `void_purchase` are SECURITY DEFINER, so
   * definer rights bypass the RLS that hides an own-birthday purchase, and both
   * RETURN the row. The celebrant gets back the description and the price of
   * the present bought for them -- the exact figure `purchases`' own policy is
   * written to withhold.
   */
  test("RLS-2: the purchase routines do not hand the celebrant their own present", async () => {
    const made = await owner(
      `insert into public.purchases
         (christmas_recipient_id,description,actual_price_pennies,checkout_payer_contributor_id,
          created_by_app_member_id,status)
       values ($1,'Secret bicycle',45000,$2,$3,'purchased') returning id`,
      [f.recipient, f.jadeContributor, f.members.jadeAlpha]);
    assert.ok(made.ok, `setup: ${made.error}`);
    const id = made.rows[0].id;

    assert.equal(await count(who.taylor, `select count(*)::int from public.purchases where id=$1`, [id]), 0,
      "the row itself is correctly hidden, which is what makes the routines below a leak");

    const status = await P(who.taylor,
      `select description, actual_price_pennies from public.set_purchase_status($1,'wrapped')`, [id]);
    assertDenied(status, "set_purchase_status returned the celebrant their own present");

    const voided = await P(who.taylor,
      `select description, actual_price_pennies from public.void_purchase($1)`, [id]);
    assertDenied(voided, "void_purchase returned the celebrant their own present");
  });

  /**
   * RLS-3. `save_gift_idea` refuses a recipient in another Area, but never asks
   * whether the recipient is the CALLER'S OWN birthday. The celebrant can
   * therefore overwrite the idea somebody recorded for them -- destroying the
   * title, price and notes -- and the row it returns names the member who
   * suggested it.
   */
  test("RLS-3: the celebrant cannot overwrite an idea recorded for their own birthday", async () => {
    const existing = await owner(
      `select id, title from public.gift_ideas where christmas_recipient_id=$1 order by created_at limit 1`,
      [f.recipient]);
    assert.ok(existing.rows[0], "there must be an idea for the celebrant or this proves nothing");
    const { id, title } = existing.rows[0];

    const edit = await P(who.taylor,
      `select title, suggested_by_app_member_id from public.save_gift_idea($1,$2,'MINE NOW',1,null,null,null)`,
      [id, f.recipient]);
    assertDenied(edit, "the celebrant rewrote a gift idea recorded for their own birthday");

    const after = await owner(`select title from public.gift_ideas where id=$1`, [id]);
    assert.equal(after.rows[0].title, title, "the original idea must survive untouched");
  });
});

/**
 * ---------------------------------------------------------------------------
 * K. MIGRATION 050 -- the birthday privacy subject
 *
 * Section J proves the three leaks are shut. This section proves the mechanism
 * that shuts them behaves the way it was designed to, including in the cases
 * where it must refuse to answer rather than guess.
 * ---------------------------------------------------------------------------
 */
describe("K. migration 050, the birthday privacy subject", () => {
  test("a birthday entry is stamped with its celebrant, deterministically", async () => {
    const stamped = await owner(
      `select celebrant_person_id, birthday_privacy_unknown
         from public.audit_log
        where table_name = 'gift_ideas' and record_id = $1`,
      [f.secretIdea]);
    assert.equal(stamped.rows.length, 1, "the secret idea must have an audit entry");
    assert.equal(stamped.rows[0].celebrant_person_id, f.people.taylor,
      "the entry for a gift idea on Taylor's birthday must name Taylor");
    assert.equal(stamped.rows[0].birthday_privacy_unknown, false);
  });

  test("a Christmas entry is not stamped, and is not marked unknown either", async () => {
    // `settlement.recipient` belongs to the Alpha Christmas event, which has no
    // celebrant at all -- so it must come out (null, false): known to need no
    // birthday privacy, rather than unresolved.
    const xmas = await owner(
      `select l.celebrant_person_id, l.birthday_privacy_unknown
         from public.audit_log l
         join public.purchases p on p.id = l.record_id
        where l.table_name = 'purchases' and p.christmas_recipient_id = $1`,
      [settlement.recipient]);
    assert.ok(xmas.rows.length > 0, "the Christmas purchase must have an audit entry");
    for (const row of xmas.rows) {
      assert.equal(row.celebrant_person_id, null, "a Christmas entry must never name a celebrant");
      assert.equal(row.birthday_privacy_unknown, false, "and must not be marked unresolved");
    }
  });

  test("an entry whose subject could not be determined is hidden from everybody", async () => {
    const made = await owner(
      `insert into public.audit_log (area_id, table_name, record_id, action, summary, subject,
                                     amount_pennies, birthday_privacy_unknown)
       values ($1, 'gift_ideas', gen_random_uuid(), 'removed', 'gift_ideas removed',
               'an unresolvable secret', 9999, true)
       returning id`, [f.areas.alpha]);
    assert.ok(made.ok, `setup: ${made.error}`);
    const id = made.rows[0].id;

    for (const actor of ["mo", "jade", "taylor", "dualAlpha"]) {
      assert.equal(
        await count(who[actor], `select count(*)::int from public.audit_log where id=$1`, [id]),
        0,
        `${actor} could read an entry whose birthday subject is unknown`,
      );
    }
  });

  test("but a non-celebrant's Activity is otherwise untouched", async () => {
    // The fix must not be a blunt instrument: Mo is nobody's celebrant here and
    // must still see the family's ordinary history.
    assert.ok(
      await count(who.mo, `select count(*)::int from public.audit_log where table_name = 'gift_ideas'`) > 0,
      "gift idea history vanished for an ordinary member");
    assert.ok(
      await count(who.mo, `select count(*)::int from public.audit_log where area_id = $1`, [f.areas.alpha]) > 0,
      "Alpha's history vanished for an ordinary member");
  });

  test("a row cannot both name a celebrant and admit it does not know one", async () => {
    const incoherent = await owner(
      `insert into public.audit_log (area_id, table_name, record_id, action, summary,
                                     celebrant_person_id, birthday_privacy_unknown)
       values ($1, 'gift_ideas', gen_random_uuid(), 'added', 'x', $2, true) returning id`,
      [f.areas.alpha, f.people.taylor]);
    assert.equal(incoherent.ok, false, "the CHECK must refuse an incoherent privacy subject");
    assert.equal(incoherent.code, "23514");
  });

  test("a planning write whose chain cannot resolve fails closed, on its own", async () => {
    /*
     * The case a future cascade or reordering could reintroduce. Deleting the
     * recipient cascades to its gift ideas; the gift idea's AFTER DELETE
     * trigger then runs with the recipient already gone, so the chain from
     * `payload` cannot reach an event. That entry must mark itself unknown
     * rather than default to "no privacy needed".
     */
    const recipient = await owner(
      `insert into public.christmas_recipients (christmas_event_id, person_id, budget_pennies, active)
       values ($1, $2, 0, true) returning id`, [settlement.event, f.people.ada]);
    assert.ok(recipient.ok, `setup: ${recipient.error}`);
    const idea = await owner(
      `insert into public.gift_ideas (christmas_recipient_id, title, estimated_price_pennies,
                                      suggested_by_app_member_id)
       values ($1, 'orphan by cascade', 100, $2) returning id`,
      [recipient.rows[0].id, f.members.jadeAlpha]);
    assert.ok(idea.ok, `setup: ${idea.error}`);

    await owner(`delete from public.christmas_recipients where id = $1`, [recipient.rows[0].id]);

    const entry = await owner(
      `select celebrant_person_id, birthday_privacy_unknown
         from public.audit_log
        where table_name = 'gift_ideas' and record_id = $1 and action = 'removed'`,
      [idea.rows[0].id]);
    assert.equal(entry.rows.length, 1, "the cascade must still have been audited");
    assert.equal(entry.rows[0].celebrant_person_id, null);
    assert.equal(entry.rows[0].birthday_privacy_unknown, true,
      "an unresolvable planning write must fail closed, not default to visible");
  });
});
