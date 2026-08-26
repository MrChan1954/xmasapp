/**
 * ONE FAMILY AT A TIME -- PROVED AGAINST A REAL DATABASE, ROUTINE BY ROUTINE.
 *
 * THE CLASS OF BUG THIS FILE EXISTS FOR
 *
 *   Almost every mutation in this database was written when there was one
 *   family, and follows two steps:
 *
 *       if not public.is_app_admin() then raise ... end if;   -- may I?
 *       update public.<table> ... where id = p_target_id;     -- do it
 *
 *   Migration 038 taught `is_app_admin()` to answer about the Area the caller
 *   SAID they are acting in. It could not teach these routines which Area they
 *   are WRITING to, because they never ask. Migration 037's write barrier does
 *   not close the gap either: it refuses somebody who is not a MEMBER of the
 *   row's Area, which is no help against a person who belongs to both families.
 *
 *   MEASURED BEFORE IT WAS FIXED. Sixteen routines were pointed at another
 *   family's rows by an account that administers Alpha and merely belongs to
 *   Bravo. Not one refused with 42501. Eight wrote to Bravo outright; the other
 *   eight passed authorisation and were stopped only by a rule about their
 *   arguments.
 *
 * HOW THIS FILE JUDGES A REFUSAL
 *
 *   By ERROR CODE, not by whether the row happened to change. 42501 is the
 *   authorization refusal. Anything else -- a validation complaint, "no
 *   outstanding balance", "choose a split type" -- means the call got PAST
 *   authorization, and a different set of arguments would have written. A test
 *   that only checked "did the row change" would have called eight of these
 *   safe.
 *
 * AND IT PROVES THE OTHER HALF TOO. A guard that refuses everything is not a
 * fix, so every routine is also driven successfully inside its own family.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";

import { asOwner, buildRehearsal, probe, rows, value } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

let db;
let f;
/** Bravo rows to aim at, and the Bravo contributors a settlement needs. */
let bravo;

const who = (user, area) => ({ user, area });

before(async () => {
  db = await buildRehearsal({});
  f = await buildTwoFamilies(db);

  await asOwner(db);
  const beaContributor = await value(db,
    "select id from public.contributors where christmas_event_id = $1 and person_id = $2",
    [f.bravoBirthday, f.people.bea]);
  // A second Bravo contributor, so a settlement has a distinct payer and payee.
  const joContributor = await value(db,
    "insert into public.contributors (christmas_event_id, person_id, active) values ($1, $2, true) returning id",
    [f.bravoBirthday, f.people.jo]);
  const purchase = await value(db, `
    insert into public.purchases (christmas_recipient_id, description, actual_price_pennies,
      checkout_payer_contributor_id, created_by_app_member_id, status)
    values ($1, 'Bravo gift', 5000, $2, $3, 'purchased') returning id`,
    [f.bravoRecipient, beaContributor, f.members.beaBravo]);
  const settlement = await value(db, `
    insert into public.settlements (christmas_event_id, payer_contributor_id, payee_contributor_id,
      amount_pennies, payment_date, recorded_by_app_member_id)
    values ($1, $2, $3, 1000, '2027-01-01', $4) returning id`,
    [f.bravoBirthday, beaContributor, joContributor, f.members.beaBravo]);
  const idea = await value(db, `
    insert into public.gift_ideas (christmas_recipient_id, title, suggested_by_app_member_id)
    values ($1, 'Bravo idea', $2) returning id`, [f.bravoRecipient, f.members.beaBravo]);

  bravo = { beaContributor, joContributor, purchase, settlement, idea };
});
after(async () => { await db?.close(); });

/**
 * Every targeted mutation, with an argument set that would SUCCEED if the call
 * were made inside Bravo. Anything that gets past the Area guard therefore
 * writes, which is what makes "reached business logic" a real finding rather
 * than a curiosity.
 */
const CROSS_AREA_ATTEMPTS = () => [
  ["set_event_status", "select public.set_event_status($1, 'archived')", [f.bravoBirthday]],
  ["update_event", "select public.update_event($1, 'PWNED', '2027-06-02', null)", [f.bravoBirthday]],
  ["delete_event_if_empty", "select public.delete_event_if_empty($1)", [f.bravoBirthday]],
  ["add_event_recipient", "select public.add_event_recipient($1, $2)", [f.bravoBirthday, f.people.jo]],
  ["set_event_contributor", "select public.set_event_contributor($1, $2, true)", [f.bravoBirthday, f.people.jo]],
  ["set_christmas_recipient_active", "select public.set_christmas_recipient_active($1, false)", [f.bravoRecipient]],
  ["save_christmas_recipient_with_contributions",
    "select public.save_christmas_recipient_with_contributions($1, $2, 'Sam', 0, '[]'::jsonb)",
    [f.bravoRecipient, f.bravoBirthday]],
  ["save_gift_idea (edit)", "select public.save_gift_idea($1, $2, 'PWNED', 1, null, null, null)",
    [() => bravo.idea, f.bravoRecipient]],
  ["save_gift_idea (add)", "select public.save_gift_idea(null, $1, 'PWNED NEW', 1, null, null, null)",
    [f.bravoRecipient]],
  ["save_purchase_with_location",
    "select public.save_purchase_with_location($1, $2, 'PWNED', 5000, $3, null, '2027-01-01', null, null, 'purchased', 'equal', null, null)",
    [() => bravo.purchase, f.bravoRecipient, () => bravo.beaContributor]],
  ["set_purchase_status", "select public.set_purchase_status($1, 'wrapped')", [() => bravo.purchase]],
  ["void_purchase", "select public.void_purchase($1)", [() => bravo.purchase]],
  ["record_settlement", "select public.record_settlement($1, $2, $3, 100, '2027-01-02', null)",
    [f.bravoBirthday, () => bravo.beaContributor, () => bravo.joContributor]],
  ["admin_record_confirmed_payment",
    "select public.admin_record_confirmed_payment($1, $2, $3, 100, '2027-01-02', 'pwn')",
    [f.bravoBirthday, () => bravo.beaContributor, () => bravo.joContributor]],
  ["review_payment", "select public.review_payment($1, 'confirm', null, null)", [() => bravo.settlement]],
  ["void_settlement", "select public.void_settlement($1)", [() => bravo.settlement]],
];

const resolve = (params) => params.map((p) => (typeof p === "function" ? p() : p));

// ===========================================================================
// B. Admin of Alpha, MEMBER of Bravo, acting in Alpha, aiming at Bravo
// ===========================================================================

describe("administering one family is no licence to write in another", () => {
  test("the setup is real: admin here, ordinary member there", async () => {
    const here = await probe(db, who(f.users.dual, f.areas.alpha), "select public.is_app_admin() as x");
    const there = await probe(db, who(f.users.dual, f.areas.bravo), "select public.is_app_admin() as x");
    assert.equal(here.rows[0].x, true, "dual administers Alpha");
    assert.equal(there.rows[0].x, false, "and merely belongs to Bravo");
  });

  test("EVERY targeted mutation refuses with 42501, and Bravo is untouched", async () => {
    /*
     * The whole matrix in one test on purpose: the interesting number is
     * "how many of the sixteen", and sixteen separate green ticks hide a
     * regression in one of them less well than a list does.
     */
    const before = await bravoFingerprint();
    const wrong = [];

    for (const [name, sql, params] of CROSS_AREA_ATTEMPTS()) {
      const result = await probe(db, who(f.users.dual, f.areas.alpha), sql, resolve(params));
      // 42501 is THE authorization refusal. Anything else means the call
      // reached business logic, so the Area was never checked.
      if (result.ok) wrong.push(`${name}: WROTE to another family`);
      else if (result.code !== "42501") wrong.push(`${name}: reached business logic (${result.code})`);
    }

    assert.deepEqual(wrong, []);
    assert.deepEqual(await bravoFingerprint(), before, "not one Bravo row may have moved");
  });

  test("and the refusal says the same thing whatever the row is", async () => {
    // So it cannot be used to work out what exists in the other family.
    const messages = new Set();
    for (const [, sql, params] of CROSS_AREA_ATTEMPTS()) {
      const result = await probe(db, who(f.users.dual, f.areas.alpha), sql, resolve(params));
      messages.add(result.error);
    }
    assert.equal(messages.size, 1, `expected one sentence, got: ${[...messages].join(" | ")}`);
  });
});

/** Everything about Bravo that a breach would disturb. */
async function bravoFingerprint() {
  await asOwner(db);
  return rows(db, `
    select
      (select count(*) from public.events where area_id = $1) as events,
      (select coalesce(string_agg(name || ':' || status, ',' order by name), '') from public.events where area_id = $1) as event_state,
      (select count(*) from public.christmas_recipients r join public.events e on e.id = r.christmas_event_id where e.area_id = $1) as recipients,
      (select count(*) from public.contributors c join public.events e on e.id = c.christmas_event_id where e.area_id = $1) as contributors,
      (select count(*) from public.gift_ideas g join public.christmas_recipients r on r.id = g.christmas_recipient_id
         join public.events e on e.id = r.christmas_event_id where e.area_id = $1) as ideas,
      (select coalesce(string_agg(g.title, ',' order by g.title), '') from public.gift_ideas g
         join public.christmas_recipients r on r.id = g.christmas_recipient_id
         join public.events e on e.id = r.christmas_event_id where e.area_id = $1) as idea_titles,
      (select count(*) from public.purchases p join public.christmas_recipients r on r.id = p.christmas_recipient_id
         join public.events e on e.id = r.christmas_event_id where e.area_id = $1 and p.deleted_at is null) as purchases,
      (select count(*) from public.settlements s join public.events e on e.id = s.christmas_event_id
         where e.area_id = $1 and s.voided_at is null) as settlements,
      (select count(*) from public.payment_receipts pr join public.events e on e.id = pr.christmas_event_id
         where e.area_id = $1) as receipts`, [f.areas.bravo]);
}

// ===========================================================================
// A. The same routines, inside their own family, still work
// ===========================================================================

describe("and inside your own family nothing changed", () => {
  test("Alpha's administrator can still run every one of them in Alpha", async () => {
    const failures = [];
    const attempts = [
      ["update_event", "select public.update_event($1,'Taylor renamed','2027-03-14',null)", [f.birthday]],
      ["add_event_recipient", "select public.add_event_recipient($1,$2)", [f.birthday, f.people.mo]],
      ["set_event_contributor", "select public.set_event_contributor($1,$2,true)", [f.birthday, f.people.mo]],
      ["set_christmas_recipient_active", "select public.set_christmas_recipient_active($1,true)", [f.recipient]],
      ["set_purchase_status", "select public.set_purchase_status($1,'purchased')", [f.purchase]],
      ["set_event_status", "select public.set_event_status($1,'archived')", [f.adminBirthday]],
      ["set_area_name", "select public.set_area_name($1,'Alpha')", [f.areas.alpha]],
    ];
    for (const [name, sql, params] of attempts) {
      const result = await probe(db, who(f.users.dual, f.areas.alpha), sql, params);
      if (!result.ok) failures.push(`${name}: ${result.error}`);
    }
    assert.deepEqual(failures, [], "the guard must not have cost anybody a legitimate action");
  });

  test("a contributor can still add a gift idea in their own family", async () => {
    const result = await probe(db, who(f.users.jade, f.areas.alpha),
      "select public.save_gift_idea(null,$1,'Another idea',500,null,null,null)", [f.recipient]);
    assert.ok(result.ok, result.error);
  });

  test("and Bravo's own administrator can still run them in Bravo", async () => {
    for (const [name, sql, params] of [
      ["update_event", "select public.update_event($1,'Sam renamed','2027-06-02',null)", [f.bravoBirthday]],
      ["set_area_name", "select public.set_area_name($1,'Bravo')", [f.areas.bravo]],
    ]) {
      const result = await probe(db, who(f.users.bravoadmin, f.areas.bravo), sql, params);
      assert.ok(result.ok, `${name}: ${result.error}`);
    }
  });
});

// ===========================================================================
// C. Two administrators, one selected family
// ===========================================================================

describe("a dual administrator changes the family they are standing in", () => {
  test("REFUSED in the family they are not standing in", async () => {
    // `dual` administers Alpha AND Charlie. Standing in Alpha is not standing
    // in Charlie, and administering both does not merge them.
    for (const [name, sql] of [
      ["set_area_name", "select public.set_area_name($1,'PWNED')"],
      ["set_area_archived", "select public.set_area_archived($1,true)"],
    ]) {
      const result = await probe(db, who(f.users.dual, f.areas.alpha), sql, [f.areas.charlie]);
      assert.equal(result.ok, false, `${name} reached Charlie from Alpha`);
      assert.equal(result.code, "42501");
    }
    await asOwner(db);
    assert.equal(await value(db, "select archived_at from public.areas where id = $1", [f.areas.charlie]), null);
  });

  test("AND ALLOWED once they switch to it -- a door, not a wall", async () => {
    const result = await probe(db, who(f.users.dual, f.areas.charlie),
      "select public.set_area_name($1, 'Charlie Renamed')", [f.areas.charlie]);
    assert.ok(result.ok, result.error);
    await asOwner(db);
    assert.equal(await value(db, "select name from public.areas where id = $1", [f.areas.charlie]), "Charlie Renamed");
    await db.query("update public.areas set name = 'Charlie' where id = $1", [f.areas.charlie]);
  });

  test("leaving a family you are not standing in is refused too", async () => {
    const result = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.leave_area($1)", [f.areas.bravo]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
    await asOwner(db);
    assert.equal(
      await value(db, "select active from public.app_members where user_id = $1 and area_id = $2",
        [f.users.dual, f.areas.bravo]), true, "their Bravo membership is untouched");
  });
});

// ===========================================================================
// D/E. Strangers, and ids that name nothing
// ===========================================================================

describe("strangers and nonsense", () => {
  test("a NON-MEMBER of the target family is refused", async () => {
    // Bravo's administrator has no standing in Alpha whatsoever.
    for (const [name, sql, params] of [
      ["set_event_status", "select public.set_event_status($1,'archived')", [f.birthday]],
      ["void_purchase", "select public.void_purchase($1)", [f.purchase]],
    ]) {
      const result = await probe(db, who(f.users.bravoadmin, f.areas.bravo), sql, params);
      assert.equal(result.ok, false, name);
      assert.equal(result.code, "42501", name);
    }
  });

  test("an id that names nothing is refused, and writes nothing", async () => {
    /*
     * A NULL target Area means the row does not exist, and the routine's own
     * "could not be found" answer is the honest one -- P0002, not an
     * authorization error. What matters is that nothing is written either way.
     */
    const before = await bravoFingerprint();
    const unknown = "3f2b1c4d-9a7e-4b21-8c6f-5d4e3a2b1c09";
    for (const [name, sql] of [
      ["set_event_status", "select public.set_event_status($1,'archived')"],
      ["void_purchase", "select public.void_purchase($1)"],
      ["void_settlement", "select public.void_settlement($1)"],
    ]) {
      const result = await probe(db, who(f.users.dual, f.areas.alpha), sql, [unknown]);
      assert.equal(result.ok, false, `${name} must refuse an unknown id`);
    }
    assert.deepEqual(await bravoFingerprint(), before);
  });

  test("a malformed id is refused by the type system, before anything runs", async () => {
    const result = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_event_status($1,'archived')", ["not-a-uuid"]);
    assert.equal(result.ok, false);
  });
});

// ===========================================================================
// F/G. Nothing half-written, and no parent left in another family
// ===========================================================================

describe("failure leaves nothing behind", () => {
  test("A REFUSED FINANCIAL ROUTINE WRITES NO RECEIPT AND NO SETTLEMENT", async () => {
    await asOwner(db);
    const before = await rows(db, `
      select (select count(*) from public.settlements) as settlements,
             (select count(*) from public.payment_receipts) as receipts,
             (select count(*) from public.purchase_allocations) as allocations`);

    for (const [sql, params] of [
      ["select public.record_settlement($1,$2,$3,100,'2027-01-02',null)",
        [f.bravoBirthday, () => bravo.beaContributor, () => bravo.joContributor]],
      ["select public.admin_record_confirmed_payment($1,$2,$3,100,'2027-01-02','x')",
        [f.bravoBirthday, () => bravo.beaContributor, () => bravo.joContributor]],
      ["select public.review_payment($1,'confirm',null,null)", [() => bravo.settlement]],
      ["select public.void_settlement($1)", [() => bravo.settlement]],
    ]) {
      const result = await probe(db, who(f.users.dual, f.areas.alpha), sql, resolve(params));
      assert.equal(result.ok, false);
    }

    await asOwner(db);
    assert.deepEqual(await rows(db, `
      select (select count(*) from public.settlements) as settlements,
             (select count(*) from public.payment_receipts) as receipts,
             (select count(*) from public.purchase_allocations) as allocations`),
      before, "money is append-only, and a refusal appends nothing");
  });

  test("no row anywhere ends up with a parent in another Area", async () => {
    await asOwner(db);
    const mismatches = await rows(db, `
      select 'recipient/event' as what, count(*)::int as n from public.christmas_recipients r
        join public.events e on e.id = r.christmas_event_id
        join public.people p on p.id = r.person_id where p.area_id <> e.area_id
      union all
      select 'contributor/event', count(*)::int from public.contributors c
        join public.events e on e.id = c.christmas_event_id
        join public.people p on p.id = c.person_id where p.area_id <> e.area_id
      union all
      select 'membership/person', count(*)::int from public.app_members m
        join public.people p on p.id = m.person_id where p.area_id <> m.area_id
      union all
      select 'settlement/contributor', count(*)::int from public.settlements s
        join public.contributors c on c.id = s.payer_contributor_id
        where c.christmas_event_id <> s.christmas_event_id`);
    assert.deepEqual(mismatches.filter((row) => row.n !== 0), []);
  });
});

// ===========================================================================
// The catalogue, asked directly
// ===========================================================================

describe("the schema itself says every targeted mutation is guarded", () => {
  /**
   * A CATALOGUE SWEEP, NOT A REGEX OVER FILES. It asks the database what it
   * will actually run, so a routine redefined by some later migration is
   * judged on its final form rather than on the file somebody happened to
   * write it in.
   */
  const GUARDED = [
    "set_event_status", "update_event", "delete_event_if_empty", "add_event_recipient",
    "set_event_contributor", "set_christmas_recipient_active",
    "save_christmas_recipient_with_contributions", "save_gift_idea",
    "save_purchase_with_location", "set_purchase_status", "void_purchase",
    "record_settlement", "admin_record_confirmed_payment", "review_payment",
    "void_settlement", "set_area_name", "set_area_archived", "leave_area",
    "transfer_area_admin",
  ];

  test("each one calls require_acting_area", async () => {
    await asOwner(db);
    const missing = await rows(db, `
      select name from unnest($1::text[]) as name
      where not exists (
        select 1 from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proname = name
          and p.prosrc like '%require_acting_area%')`, [GUARDED]);
    assert.deepEqual(missing.map((row) => row.name), []);
  });

  test("NO OTHER authenticated mutation is left unguarded and Area-blind", async () => {
    /*
     * The sweep that catches the next one. Every function `authenticated` may
     * call, that writes to an Area-owned table, must either derive the Area of
     * what it is changing or be insert-only into the acting Area.
     *
     * The exemptions are named individually, with a reason, so adding a routine
     * to this list is a decision somebody has to write down.
     */
    const EXEMPT = {
      create_area: "creates the Area it writes to, three statements earlier",
      create_person: "insert only; the Area comes from the acting membership",
      create_event: "insert only; a person from another Area is refused by 035's guard",
      start_birthday_planning: "already derives the celebrant's Area (039)",
      set_family_contributor: "derives the person's Area (044)",
      set_person_archived: "derives the person's Area (044)",
      set_person_name: "derives the person's Area (044)",
      set_person_birthday: "derives the person's Area (039)",
      claim_app_member: "self-service; matches the caller's own auth email only",
      record_audit_event: "trigger function, not callable",
      record_birthday_audit_event: "trigger function, not callable",
    };

    await asOwner(db);
    const suspects = await rows(db, `
      select p.proname
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and has_function_privilege('authenticated', p.oid, 'execute')
        and p.prorettype::regtype::text <> 'trigger'
        and pg_get_functiondef(p.oid) ~* '(insert into public\\.|update public\\.|delete from public\\.)'
        and pg_get_functiondef(p.oid) !~ 'require_acting_area'
        and pg_get_functiondef(p.oid) !~ 'area_of_(person|event|recipient|purchase|gift_idea|member|settlement)'
      order by p.proname`);

    const unexplained = suspects.map((row) => row.proname).filter((name) => !(name in EXEMPT));
    assert.deepEqual(unexplained, [],
      "a new mutation that neither derives its target Area nor calls the guard");
  });

  test("and every guarded routine is still a pinned definer that anon cannot call", async () => {
    await asOwner(db);
    const bad = await rows(db, `
      select p.proname,
             p.prosecdef,
             coalesce(array_to_string(p.proconfig, ','), '') as config,
             has_function_privilege('anon', p.oid, 'execute') as anon_exec,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname = any($1::text[])
        and (not p.prosecdef
             or coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%'
             or has_function_privilege('anon', p.oid, 'execute')
             or not has_function_privilege('authenticated', p.oid, 'execute'))`, [GUARDED]);
    assert.deepEqual(bad, []);
  });

  test("the guard itself is a pinned definer, and anon cannot call it", async () => {
    await asOwner(db);
    const guard = (await rows(db, `
      select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config,
             has_function_privilege('anon', p.oid, 'execute') as anon_exec,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = 'require_acting_area'`))[0];
    assert.equal(guard.prosecdef, true);
    assert.match(guard.config, /search_path=/u);
    assert.equal(guard.anon_exec, false);
    assert.equal(guard.auth_exec, true);
  });
});

// ===========================================================================
// The guard's own rules
// ===========================================================================

describe("require_acting_area, on its own terms", () => {
  test("a caller with ONE family and no Area claimed is unambiguous, and allowed", async () => {
    // The no-cookie case. Bravo's administrator belongs to Bravo and nowhere
    // else, so there is nothing to guess between.
    const result = await probe(db, who(f.users.bravoadmin, null),
      "select public.set_area_name($1, 'Bravo')", [f.areas.bravo]);
    assert.ok(result.ok, result.error);
  });

  test("A CALLER WITH SEVERAL FAMILIES AND NO AREA CLAIMED IS REFUSED", async () => {
    /*
     * Otherwise omitting the header would be the way round the whole thing:
     * the acting Area comes from a request header, and a caller controls it.
     * This is migration 038's own rule -- refuse to guess -- applied to
     * writing rather than to reading.
     */
    const result = await probe(db, who(f.users.dual, null),
      "select public.set_area_name($1, 'PWNED')", [f.areas.alpha]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "42501");
    await asOwner(db);
    assert.equal(await value(db, "select name from public.areas where id = $1", [f.areas.alpha]), "Alpha");
  });
});
