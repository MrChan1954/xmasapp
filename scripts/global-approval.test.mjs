/**
 * MIGRATION 052, RUN RATHER THAN READ.
 *
 * The whole of Q19's database work is one sentence -- "being able to sign in is
 * not the same thing as being allowed in" -- and there is exactly one way to
 * find out whether a real PostgreSQL agrees with it: sign somebody in who is
 * not approved, and count what they can see.
 *
 * Everything below runs on PGlite carrying migrations 001-052, with real roles,
 * real `SET ROLE`, real row level security and the real PostgREST pre-request
 * hook. No authorization is mocked anywhere in this file. When a test says an
 * account sees nothing, that is the database refusing, not a stub.
 *
 * THE ONE THING THIS FILE IS FOR, ABOVE THE OTHERS. 052 is the first migration
 * to put a gate UPSTREAM of the Area gates, and a gate that is upstream of
 * everything can break everything. So the first section is not about the new
 * feature at all: it is a row-by-row proof that an APPROVED member of two
 * families sees exactly what they saw before 052 existed. A security migration
 * that quietly narrowed what a real family can read would be a worse defect
 * than the one it fixed.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";

import {
  applyMigration, asOwner, attempt, buildRehearsal, literal, probe, rows, seen, value,
} from "./pg/rehearsal.mjs";
import { buildTwoFamilies, setAccountStatus } from "./pg/fixtures.mjs";

const GLOBAL_APPROVAL = "202608100052_global_account_approval.sql";
const BEFORE_052 = "202608100051_drop_superseded_routines_and_narrow_table_grants.sql";

/** One signed-in request, standing in one family. */
const who = (user, area) => ({ user, role: "authenticated", area });
const anon = { user: null, role: "anon", area: null };

/**
 * THE AREA-OWNED TABLES A FAMILY MEMBER READS.
 *
 * Seventeen: every table whose rows belong to one family, plus the three that
 * belong to one MEMBER (`notifications`, `notification_preferences`,
 * `push_subscriptions`) and are reached through `is_own_app_member` rather than
 * through an Area column at all. Those three are in this list deliberately --
 * they are the ones an Area-shaped sweep does not look at, and they are where
 * the leak this file found actually was.
 */
const AREA_TABLES = [
  "areas", "people", "app_members", "events", "christmas_recipients",
  "contributors", "recipient_contributions", "gift_ideas", "purchases",
  "purchase_allocations", "settlements", "payment_receipts", "item_photos",
  "birthday_wishlist_ideas", "audit_log",
  "notifications", "notification_preferences", "push_subscriptions",
];

/** Everything one caller can see, table by table, as a comparable object. */
async function visibleEverywhere(db, actor) {
  const out = {};
  for (const table of AREA_TABLES) out[table] = await seen(db, actor, table);
  return out;
}

/**
 * The member-owned rows the fixture does not create, seeded past the triggers.
 *
 * Without these, `notifications`, `notification_preferences` and
 * `push_subscriptions` are empty for everybody, and a test that counts zero
 * proves nothing at all. This is the difference between the sweep having teeth
 * and the sweep being decorative.
 */
async function seedOwnRows(db, memberId) {
  await asOwner(db);
  await db.query(
    `insert into public.notifications (app_member_id, category, title, body, target_url)
     values ($1, 'gift_ideas', 'Surprise weekend away', 'Jade added a gift idea for Taylor', '/x')`,
    [memberId],
  );
  await db.query("insert into public.notification_preferences (app_member_id) values ($1)", [memberId]);
  await db.query(
    `insert into public.push_subscriptions (app_member_id, endpoint, p256dh, auth)
     values ($1, 'https://push.example.test/one', repeat('p', 87), repeat('a', 22))`,
    [memberId],
  );
}

// ===========================================================================
// 1. NOTHING CHANGED FOR THE PEOPLE WHO WERE ALREADY HERE
// ===========================================================================

describe("an approved member sees exactly what they saw before 052", () => {
  let before051, after052, f51, f52;

  before(async () => {
    // The SAME fixture, built twice: once on a database that stops at 051, and
    // once on one that carries 052. Row ids differ between them because they
    // are generated, so what is compared is COUNTS, per caller, per table.
    before051 = await buildRehearsal({ through: BEFORE_052 });
    f51 = await buildTwoFamilies(before051);
    await seedOwnRows(before051, f51.members.jadeAlpha);

    after052 = await buildRehearsal({});
    f52 = await buildTwoFamilies(after052);
    await seedOwnRows(after052, f52.members.jadeAlpha);
  });
  after(async () => { await before051?.close(); await after052?.close(); });

  test("the two databases really are different -- one has app_accounts, one does not", async () => {
    assert.equal(await value(before051, "select to_regclass('public.app_accounts') is null"), true);
    assert.equal(await value(after052, "select to_regclass('public.app_accounts') is not null"), true);
  });

  /*
   * FIVE CALLERS, THREE FAMILIES, EIGHTEEN TABLES EACH.
   *
   * `dual` is the interesting one: administrator of Alpha, administrator of
   * Charlie, ordinary member of Bravo. If 052's gate had been written so that
   * approval were somehow per-Area, or so that a multi-family login answered
   * about the wrong one, this is the caller it would show up on.
   */
  const CALLERS = [
    ["Alpha's administrator, standing in Alpha", "dual", "alpha"],
    ["the same login, standing in Bravo as an ordinary member", "dual", "bravo"],
    ["the same login again, standing in Charlie", "dual", "charlie"],
    ["a contributor in Alpha", "jade", "alpha"],
    ["the least-privileged member of Alpha", "mo", "alpha"],
    ["Bravo's own administrator", "bravoadmin", "bravo"],
    ["the birthday celebrant themselves", "taylor", "alpha"],
  ];

  for (const [label, user, area] of CALLERS) {
    test(`ZERO DRIFT: ${label}`, async () => {
      const was = await visibleEverywhere(before051, who(f51.users[user], f51.areas[area]));
      const is = await visibleEverywhere(after052, who(f52.users[user], f52.areas[area]));
      assert.deepEqual(is, was, `052 changed what ${label} can read`);
    });
  }

  test("and the sweep had teeth -- these are not eighteen zeroes", async () => {
    // Jade, because the member-owned rows are seeded onto HER membership: the
    // three tables reached through `is_own_app_member` are exactly the ones an
    // Area-shaped sweep misses, so an equivalence over them has to be measured
    // on somebody who actually owns some.
    const is = await visibleEverywhere(after052, who(f52.users.jade, f52.areas.alpha));
    const populated = Object.entries(is).filter(([, n]) => typeof n === "number" && n > 0);
    assert.ok(populated.length >= 10,
      `only ${populated.length} tables had any visible row: ${JSON.stringify(is)}`);
    for (const table of [
      "people", "events", "gift_ideas", "purchases", "audit_log",
      "notifications", "notification_preferences", "push_subscriptions",
    ]) {
      assert.ok(is[table] > 0, `${table} was empty, so its equivalence proved nothing`);
    }
  });

  test("a member of one family still sees nothing of another", async () => {
    assert.equal(await seen(after052, who(f52.users.mo, f52.areas.alpha),
      "people", "area_id = $1", [f52.areas.bravo]), 0);
    assert.equal(await seen(after052, who(f52.users.mo, f52.areas.alpha),
      "areas", "id = $1", [f52.areas.bravo]), 0);
  });
});

// ===========================================================================
// 2-5. THE NEW GATE ITSELF
// ===========================================================================

describe("migration 052, on a database that carries it", () => {
  let db, f;

  before(async () => {
    db = await buildRehearsal({});
    f = await buildTwoFamilies(db);
    await seedOwnRows(db, f.members.jadeAlpha);
  });
  after(async () => { await db?.close(); });

  /** Put jade back to approved, whatever a test did to her. */
  async function restore() {
    await setAccountStatus(db, f.users.jade, "approved");
  }

  // -------------------------------------------------------------------------
  // 2. Pending, rejected and suspended
  // -------------------------------------------------------------------------

  for (const status of ["pending", "rejected", "suspended"]) {
    describe(`a ${status} account with a claimed, active membership`, () => {
      before(async () => { await setAccountStatus(db, f.users.jade, status); });
      after(restore);

      test("sees ZERO rows in every table a family owns", async () => {
        const visible = await visibleEverywhere(db, who(f.users.jade, f.areas.alpha));
        for (const [table, n] of Object.entries(visible)) {
          if (typeof n === "number") {
            assert.equal(n, 0, `a ${status} account can still read ${n} row(s) of ${table}`);
          } else {
            assert.match(String(n), /REFUSED/u, `${table} answered ${n}`);
          }
        }
      });

      test("and sees zero with no Area named either -- there is no back door", async () => {
        const visible = await visibleEverywhere(db, who(f.users.jade, null));
        for (const [table, n] of Object.entries(visible)) {
          if (typeof n === "number") assert.equal(n, 0, `${table} leaked without an Area header`);
        }
      });

      test("cannot create a family of its own", async () => {
        const made = await probe(db, who(f.users.jade, null),
          "select public.create_area($1, $2)", ["Smuggled", "Nobody"]);
        assert.equal(made.ok, false);
        assert.match(made.error, /not been approved/iu);
      });

      test("cannot claim an acting Area, by header or by routine", async () => {
        // `claim_active_area` is the pre-request hook and returns void either
        // way; what matters is that it does not SET anything.
        const acting = await probe(db, who(f.users.jade, f.areas.alpha),
          "select public.acting_area() as a");
        assert.equal(acting.rows[0].a, null, "the hook claimed an Area for an unapproved account");

        const act = await probe(db, who(f.users.jade, null),
          "select public.act_in_area($1)", [f.areas.alpha]);
        assert.equal(act.ok, false);
        assert.match(act.error, /not a member of that Area/iu);
      });

      test("require_acting_area refuses it for a row it used to own", async () => {
        const guarded = await probe(db, who(f.users.jade, f.areas.alpha),
          "select public.require_acting_area($1)", [f.areas.alpha]);
        assert.equal(guarded.ok, false);
        assert.match(guarded.error, /Say which family|another family/iu);
      });

      test("and every ordinary write it used to be allowed is refused", async () => {
        const idea = await probe(db, who(f.users.jade, f.areas.alpha),
          "select id from public.save_gift_idea(null, $1, $2, $3, null, null, null)",
          [f.recipient, "Smuggled in", 100]);
        assert.equal(idea.ok, false, "an unapproved contributor still wrote a gift idea");

        const rename = await probe(db, who(f.users.jade, f.areas.alpha),
          "select public.set_person_name($1, $2)", [f.people.mo, "Renamed"]);
        assert.equal(rename.ok, false);

        await asOwner(db);
        assert.equal(await value(db, "select name from public.people where id = $1", [f.people.mo]), "Mo");
      });

      test("the three predicates all answer false", async () => {
        for (const fn of [
          "public.is_active_app_member()",
          `public.is_area_member(${literal(f.areas.alpha)})`,
          `public.is_area_admin(${literal(f.areas.alpha)})`,
          "public.is_globally_approved()",
          "public.is_global_admin()",
        ]) {
          const answer = await probe(db, who(f.users.jade, f.areas.alpha), `select ${fn} as v`);
          assert.equal(answer.rows[0].v, false, `${fn} answered true for a ${status} account`);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // 2b. THE SAME THING, BUT TO A FAMILY'S ADMINISTRATOR
  //
  // Found by a surviving mutation. Everything above suspends an ordinary
  // MEMBER, so `is_area_admin` answered false for them whether or not it asked
  // about approval -- and the gate could have been taken off it without one
  // assertion noticing. An administrator is the caller with the most to lose
  // control of, so they are the one to measure it on.
  // -------------------------------------------------------------------------

  describe("a suspended account that ADMINISTERS a family", () => {
    // Bravo's own administrator, who administers nothing else, so nothing here
    // is answered by a second membership.
    const admin = () => f.users.bravoadmin;

    before(async () => { await setAccountStatus(db, f.users.bravoadmin, "suspended"); });
    after(async () => { await setAccountStatus(db, f.users.bravoadmin, "approved"); });

    test("IS_AREA_ADMIN ANSWERS FALSE, and so does is_area_member", async () => {
      for (const fn of ["is_area_admin", "is_area_member"]) {
        const answer = await probe(db, who(admin(), f.areas.bravo),
          `select public.${fn}($1) as v`, [f.areas.bravo]);
        assert.equal(answer.rows[0].v, false, `${fn} still says yes to a suspended administrator`);
      }
      // The two the surviving mutation led to. `is_app_admin` in particular:
      // its acting-Area branch reaches a gated predicate, but its OTHER branch
      // -- one membership, no Area on screen -- answered for itself.
      const global = await probe(db, who(admin(), f.areas.bravo), "select public.is_app_admin() as v");
      assert.equal(global.rows[0].v, false, "is_app_admin still says yes");
      const contributor = await probe(db, who(admin(), f.areas.bravo),
        "select public.is_area_contributor_member($1) as v", [f.areas.bravo]);
      assert.equal(contributor.rows[0].v, false, "is_area_contributor_member still says yes");
    });

    test("NO PERMISSION PREDICATE IN THE SCHEMA STILL SAYS YES TO THEM", async () => {
      /*
       * The sweep the survivor earned. Every boolean SECURITY DEFINER routine
       * that reads `app_members` to answer about the CALLER is asked, by name,
       * derived from the catalogue rather than listed here -- so a predicate
       * added later is included automatically and has to be dealt with.
       *
       * `is_acting_area` is the one deliberate exception, and it is named as
       * such: it is a SCOPING test ("is this row in the family on screen"),
       * never an authorisation, and it answers true for a null argument by
       * design. See migration 052 section 9b(ii).
       */
      await asOwner(db);
      const predicates = await rows(db, `
        select p.proname, pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.prosecdef
          and pg_get_function_result(p.oid) = 'boolean'
          and p.prosrc like '%app_members%'
          and pg_get_function_identity_arguments(p.oid) in ('', 'p_area_id uuid')
          and has_function_privilege('authenticated', p.oid, 'execute')
        order by p.proname`);

      const EXPECTED_EXCEPTION = "is_acting_area";
      const answeredYes = [];
      for (const { proname, args } of predicates) {
        const call = args === "" ? `select public.${proname}() as v` : `select public.${proname}($1) as v`;
        const result = await probe(db, who(admin(), f.areas.bravo),
          call, args === "" ? undefined : [f.areas.bravo]);
        if (result.ok && result.rows[0]?.v === true) answeredYes.push(proname);
      }

      assert.ok(predicates.length >= 6,
        `the derivation found only ${predicates.length} predicates, so it proves little`);
      assert.deepEqual(answeredYes, [EXPECTED_EXCEPTION],
        "a permission predicate other than the documented scoping one still says yes to a suspended account");
    });

    test("the administrator-only membership policy shows them nothing", async () => {
      // `admins read all memberships` is USING (is_area_admin(area_id)) and is
      // the only policy that hands one member another's row. If the gate came
      // off is_area_admin, this is the number that would not be zero.
      assert.equal(await seen(db, who(admin(), f.areas.bravo), "app_members"), 0);
      assert.equal(await seen(db, who(admin(), f.areas.bravo), "people"), 0);
    });

    test("and every administrator-only routine refuses them", async () => {
      const REFUSALS = [
        ["renaming the family", "select public.set_area_name($1, $2)", [f.areas.bravo, "Renamed"]],
        ["archiving it", "select public.set_area_archived($1, true)", [f.areas.bravo]],
        ["adding a person", "select id from public.create_person($1, null, null, null)", ["Smuggled"]],
        ["giving somebody access", "select public.grant_area_access($1, $2)",
          [f.people.jo, "smuggled@example.test"]],
        ["taking access away", "select public.revoke_area_access($1)", [f.people.jo]],
        ["listing who has access", "select * from public.list_area_access()", []],
      ];
      for (const [label, sql, params] of REFUSALS) {
        const result = await probe(db, who(admin(), f.areas.bravo), sql, params);
        assert.equal(result.ok, false, `a suspended administrator succeeded at ${label}`);
      }

      await asOwner(db);
      assert.equal(await value(db, "select name from public.areas where id = $1", [f.areas.bravo]), "Bravo");
    });

    test("approving them again restores every one of those powers", async () => {
      await setAccountStatus(db, f.users.bravoadmin, "approved");
      for (const [fn, params] of [
        ["is_area_admin($1)", [f.areas.bravo]],
        ["is_area_member($1)", [f.areas.bravo]],
        ["is_area_contributor_member($1)", [f.areas.bravo]],
        ["is_app_admin()", null],
      ]) {
        const answer = await probe(db, who(admin(), f.areas.bravo),
          `select public.${fn} as v`, params ?? undefined);
        assert.equal(answer.rows[0].v, true, `${fn} did not come back on approval`);
      }
      const listed = await probe(db, who(admin(), f.areas.bravo), "select * from public.list_area_access()");
      assert.equal(listed.ok, true, listed.error);
      assert.ok(listed.rows.length > 0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. The membership row itself -- the leak the own-row policy used to allow
  // -------------------------------------------------------------------------

  describe("the pending-with-membership regression", () => {
    after(restore);

    test("approved, the member reads their own membership rows", async () => {
      await restore();
      const mine = await seen(db, who(f.users.jade, f.areas.alpha), "app_members", "user_id = $1", [f.users.jade]);
      assert.ok(mine > 0, "the fixture must give jade at least one membership to lose");
    });

    test("PENDING, THE SAME ROWS ARE GONE -- including their Area and their role", async () => {
      await setAccountStatus(db, f.users.jade, "pending");
      assert.equal(await seen(db, who(f.users.jade, f.areas.alpha), "app_members"), 0);
      assert.equal(await seen(db, who(f.users.jade, null), "app_members"), 0);
    });

    test("and approving them again gives the rows back, unchanged", async () => {
      await asOwner(db);
      const truth = await value(db,
        "select count(*)::int from public.app_members where user_id = $1 and active = true", [f.users.jade]);
      await restore();
      assert.equal(await seen(db, who(f.users.jade, f.areas.alpha), "app_members", "user_id = $1", [f.users.jade]),
        truth, "approval must restore exactly what was there, not a subset");
    });

    test("the rows were never deleted -- only hidden", async () => {
      await setAccountStatus(db, f.users.jade, "suspended");
      await asOwner(db);
      assert.ok(await value(db,
        "select count(*)::int from public.app_members where user_id = $1", [f.users.jade]) > 0);
      await restore();
    });
  });

  // -------------------------------------------------------------------------
  // 4. The table itself
  // -------------------------------------------------------------------------

  describe("app_accounts is not reachable from a browser at all", () => {
    const STATEMENTS = [
      ["a whole-table read", "select * from public.app_accounts"],
      ["one column", "select status from public.app_accounts"],
      ["a count", "select count(*) from public.app_accounts"],
      ["an insert", "insert into public.app_accounts (user_id, status) values (gen_random_uuid(), 'approved')"],
      ["an update", "update public.app_accounts set status = 'approved'"],
      ["a delete", "delete from public.app_accounts"],
      ["a truncate", "truncate table public.app_accounts"],
    ];

    for (const [label, sql] of STATEMENTS) {
      test(`an approved, signed-in administrator is refused ${label}`, async () => {
        const result = await probe(db, who(f.users.dual, f.areas.alpha), sql);
        assert.equal(result.ok, false, `${label} succeeded`);
        assert.match(result.error, /permission denied/iu);
      });

      test(`and so is a signed-out visitor: ${label}`, async () => {
        const result = await probe(db, anon, sql);
        assert.equal(result.ok, false, `${label} succeeded for anon`);
        assert.match(result.error, /permission denied/iu);
      });
    }

    test("the privilege sets are empty in the catalogue, not merely refused in practice", async () => {
      await asOwner(db);
      for (const role of ["anon", "authenticated"]) {
        const held = await rows(db, `
          select a.privilege_type
          from pg_class c, aclexplode(c.relacl) a
          where c.oid = 'public.app_accounts'::regclass and a.grantee = ${literal(role)}::regrole
          order by 1`);
        assert.deepEqual(held.map((r) => r.privilege_type), [], `${role} holds a privilege on app_accounts`);
      }
    });

    test("row level security is on, and there is not one policy to admit anybody", async () => {
      await asOwner(db);
      assert.equal(await value(db,
        "select relrowsecurity from pg_class where oid = 'public.app_accounts'::regclass"), true);
      assert.equal(await value(db,
        "select count(*)::int from pg_policy where polrelid = 'public.app_accounts'::regclass"), 0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. A signed-in account with no row at all
  // -------------------------------------------------------------------------

  describe("a signed-in account with NO app_accounts row is pending, not unknown", () => {
    let stranger;

    before(async () => {
      await asOwner(db);
      stranger = await value(db, `
        insert into auth.users (email, email_confirmed_at)
        values ('nobody@example.test', now()) returning id`);
      // Deliberately NOT given a row. This is the state a brand-new public
      // sign-up is in between confirming their email and being reviewed.
    });

    test("no row exists for them", async () => {
      await asOwner(db);
      assert.equal(await value(db,
        "select count(*)::int from public.app_accounts where user_id = $1", [stranger]), 0);
    });

    test("is_globally_approved and is_global_admin are both false", async () => {
      for (const fn of ["is_globally_approved", "is_global_admin"]) {
        const answer = await probe(db, who(stranger, null), `select public.${fn}() as v`);
        assert.equal(answer.rows[0].v, false, `${fn} was not false`);
      }
    });

    test("MY_ACCOUNT_STATUS REPORTS A STABLE `pending`, not null and not an error", async () => {
      const status = await probe(db, who(stranger, null), "select * from public.my_account_status()");
      assert.equal(status.ok, true, status.error);
      assert.equal(status.rows.length, 1, "a signed-in account must get exactly one row back");
      assert.deepEqual(status.rows[0], { status: "pending", is_global_admin: false, email_confirmed: true });
    });

    test("and it says the same thing the second time -- the answer is not created by asking", async () => {
      await probe(db, who(stranger, null), "select * from public.my_account_status()");
      await asOwner(db);
      assert.equal(await value(db,
        "select count(*)::int from public.app_accounts where user_id = $1", [stranger]), 0,
      "reading a status must not write one");
    });

    test("they can read nothing of any family", async () => {
      const visible = await visibleEverywhere(db, who(stranger, f.areas.alpha));
      for (const [table, n] of Object.entries(visible)) {
        if (typeof n === "number") assert.equal(n, 0, `${table} leaked to an account with no row`);
      }
    });

    test("and a signed-OUT visitor gets no row from my_account_status at all", async () => {
      const status = await probe(db, anon, "select * from public.my_account_status()");
      assert.equal(status.ok, false, "anon must not be able to call it");
      assert.match(status.error, /permission denied/iu);
    });
  });
});

// ===========================================================================
// 6. THE BACKFILL, ON A DATABASE WHERE 052 HAS NOT RUN YET
// ===========================================================================

describe("the backfill approves the confirmed and claimed, and nobody else", () => {
  let db;
  let applied;
  const cat = {};

  before(async () => {
    db = await buildRehearsal({ through: BEFORE_052 });
    const f = await buildTwoFamilies(db);
    await asOwner(db);

    /*
     * THREE CATEGORIES, BUILT DELIBERATELY, BEFORE 052 EXISTS.
     *
     *   A  active claimed membership + confirmed email   -> approved
     *   B  active claimed membership + UNCONFIRMED email -> left undecided
     *   C  no active claimed membership at all           -> left undecided
     *
     * B is the one that matters. An account that never proved it owns its own
     * address is an account somebody else may have signed up as, and inheriting
     * a family membership on that basis is precisely the takeover 052 exists to
     * stop. It is not a bug that they are held back; it is the point.
     */
    cat.A = f.users.mo;                       // built by the fixture, confirmed
    cat.B = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('unconfirmed@example.test', null) returning id`);
    cat.C = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('membershipless@example.test', now()) returning id`);
    cat.Cinactive = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('deactivated@example.test', now()) returning id`);

    const personB = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Bee') returning id", [f.areas.alpha]);
    await db.query(`
      insert into public.app_members (area_id, person_id, user_id, email, role, active)
      values ($1, $2, $3, 'unconfirmed@example.test', 'member', true)`, [f.areas.alpha, personB, cat.B]);

    const personD = await value(db,
      "insert into public.people (area_id, name) values ($1, 'Dee') returning id", [f.areas.alpha]);
    await db.query(`
      insert into public.app_members (area_id, person_id, user_id, email, role, active)
      values ($1, $2, $3, 'deactivated@example.test', 'member', false)`,
    [f.areas.alpha, personD, cat.Cinactive]);

    // AND ONLY NOW does 052 run, so the backfill sees exactly this population.
    applied = await applyMigration(db, GLOBAL_APPROVAL);
  });
  after(async () => { await db?.close(); });

  test("052 applies to this population at all", () => {
    // Kept out of `before` deliberately. If the backfill rule is broken, 052's
    // own end-state block refuses -- and a refusal inside `before` cancels every
    // test below it, so the run would say "cancelled" rather than naming what
    // went wrong. Asserted here, the categories below still run and still fail
    // by name.
    assert.equal(applied.ok, true, `052 failed to apply: ${applied.error} ${applied.detail ?? ""}`);
  });

  test("the three categories are mutually exclusive and cover every auth user", async () => {
    await asOwner(db);
    const totals = await rows(db, `
      select
        count(*) filter (where u.email_confirmed_at is not null and claimed.n > 0)  as a,
        count(*) filter (where u.email_confirmed_at is null     and claimed.n > 0)  as b,
        count(*) filter (where claimed.n = 0)                                       as c,
        count(*)                                                                    as total
      from auth.users u
      cross join lateral (
        select count(*)::int as n from public.app_members m
        where m.user_id = u.id and m.active = true
      ) as claimed`);
    const t = totals[0];
    assert.equal(Number(t.a) + Number(t.b) + Number(t.c), Number(t.total),
      "the categories must partition auth.users, with no row in two and none in none");
    assert.ok(Number(t.a) > 0 && Number(t.b) > 0 && Number(t.c) > 0,
      "every category must be populated or this test proves nothing");
  });

  test("CATEGORY A IS APPROVED", async () => {
    await asOwner(db);
    assert.equal(await value(db,
      "select status from public.app_accounts where user_id = $1", [cat.A]), "approved");
  });

  test("CATEGORY B IS NOT -- an unconfirmed email does not inherit a family", async () => {
    await asOwner(db);
    assert.equal(await value(db,
      "select count(*)::int from public.app_accounts where user_id = $1", [cat.B]), 0,
    "an account that never confirmed its address was auto-approved");
  });

  test("CATEGORY C IS NOT, whether it has no membership or only an inactive one", async () => {
    await asOwner(db);
    for (const user of [cat.C, cat.Cinactive]) {
      assert.equal(await value(db,
        "select count(*)::int from public.app_accounts where user_id = $1", [user]), 0);
    }
  });

  test("every approved account has a confirmed email, without exception", async () => {
    await asOwner(db);
    assert.equal(await value(db, `
      select count(*)::int from public.app_accounts a
      join auth.users u on u.id = a.user_id
      where a.status = 'approved' and u.email_confirmed_at is null`), 0);
  });

  test("the approved set is exactly the derived set, counted both ways", async () => {
    await asOwner(db);
    assert.equal(await value(db, `
      select (select count(*) from public.app_accounts where status = 'approved')
           = (select count(distinct u.id) from auth.users u
              where u.email_confirmed_at is not null
                and exists (select 1 from public.app_members m
                            where m.user_id = u.id and m.active = true))`), true);
  });

  test("and nobody administers Gift Planner yet", async () => {
    await asOwner(db);
    assert.equal(await value(db,
      "select count(*)::int from public.app_accounts where is_global_admin = true"), 0);
  });

  test("B and C can still be approved by hand afterwards -- they are held, not barred", async () => {
    await asOwner(db);
    await db.query("insert into public.app_accounts (user_id, status) values ($1, 'approved')", [cat.C]);
    assert.equal(await value(db,
      "select status from public.app_accounts where user_id = $1", [cat.C]), "approved");
  });
});

// ===========================================================================
// 7-8. CREATING A FAMILY, AND CLAIMING A SEAT IN ONE
// ===========================================================================

describe("create_area and claim_app_member", () => {
  let db, f;

  before(async () => {
    db = await buildRehearsal({});
    f = await buildTwoFamilies(db);
  });
  after(async () => { await db?.close(); });

  describe("create_area asks the front door first", () => {
    for (const status of ["pending", "rejected", "suspended"]) {
      test(`a ${status} account is refused`, async () => {
        await asOwner(db);
        const user = await value(db, `
          insert into auth.users (email, email_confirmed_at)
          values (${literal(`create-${status}@example.test`)}, now()) returning id`);
        await setAccountStatus(db, user, status);

        const made = await probe(db, who(user, null), "select public.create_area($1, $2)", ["Nope", "Nobody"]);
        assert.equal(made.ok, false);
        assert.match(made.error, /not been approved/iu);

        await asOwner(db);
        assert.equal(await value(db,
          "select count(*)::int from public.areas where name = 'Nope'"), 0, "a refused call still wrote an Area");
      });
    }

    test("an account with no row at all is refused too", async () => {
      await asOwner(db);
      const user = await value(db, `
        insert into auth.users (email, email_confirmed_at)
        values ('create-norow@example.test', now()) returning id`);
      const made = await probe(db, who(user, null), "select public.create_area($1, $2)", ["Nope2", "Nobody"]);
      assert.equal(made.ok, false);
      assert.match(made.error, /not been approved/iu);
    });

    test("AN APPROVED ACCOUNT WITH NO FAMILY AT ALL CAN CREATE ONE", async () => {
      await asOwner(db);
      const user = await value(db, `
        insert into auth.users (email, email_confirmed_at)
        values ('create-approved@example.test', now()) returning id`);
      await setAccountStatus(db, user, "approved");

      const made = await probe(db, who(user, null), "select public.create_area($1, $2) as id",
        ["Delta", "Dara"]);
      assert.equal(made.ok, true, made.error);
      const area = made.rows[0].id;

      // Atomically a member AND its administrator, with a person of their own.
      await asOwner(db);
      const seat = (await rows(db, `
        select m.role, m.active, m.user_id, p.name
        from public.app_members m join public.people p on p.id = m.person_id
        where m.area_id = $1`, [area]))[0];
      assert.deepEqual(
        { role: seat.role, active: seat.active, user_id: seat.user_id, name: seat.name },
        { role: "admin", active: true, user_id: user, name: "Dara" },
      );
    });

    test("and a signed-out visitor is still refused, with the older message", async () => {
      const made = await probe(db, anon, "select public.create_area($1, $2)", ["Nope3", "Nobody"]);
      assert.equal(made.ok, false);
    });
  });

  /*
   * 053 MOVED THE JOIN, NOT THE RULE. Every assertion below used to be made of
   * `claim_app_member()`, which joined you to every matching open invitation on
   * every sign-in. 053 reduces that routine to `select false` and puts the join
   * behind `accept_family_invitation(uuid)`, so the same questions are now
   * asked of the routine that can actually write. The rule being tested --
   * A CONFIRMED ADDRESS, MATCHING THE ROW, OR NOTHING -- is unchanged.
   */
  describe("accept_family_invitation will not believe an unconfirmed address", () => {
    let unconfirmed, confirmed, seatUnconfirmed, seatConfirmed;

    before(async () => {
      await asOwner(db);
      unconfirmed = await value(db, `
        insert into auth.users (email, email_confirmed_at)
        values ('claim-unconfirmed@example.test', null) returning id`);
      confirmed = await value(db, `
        insert into auth.users (email, email_confirmed_at)
        values ('claim-confirmed@example.test', now()) returning id`);

      const p1 = await value(db,
        "insert into public.people (area_id, name) values ($1, 'Unconf') returning id", [f.areas.bravo]);
      seatUnconfirmed = await value(db, `
        insert into public.app_members (area_id, person_id, email, role, active)
        values ($1, $2, 'claim-unconfirmed@example.test', 'member', true) returning id`, [f.areas.bravo, p1]);

      const p2 = await value(db,
        "insert into public.people (area_id, name) values ($1, 'Conf') returning id", [f.areas.bravo]);
      seatConfirmed = await value(db, `
        insert into public.app_members (area_id, person_id, email, role, active)
        values ($1, $2, 'claim-confirmed@example.test', 'member', true) returning id`, [f.areas.bravo, p2]);
    });

    test("AN UNCONFIRMED ACCOUNT JOINS NOTHING, and the seat stays open", async () => {
      // Signing in is inert now, and accepting is refused outright.
      const claimed = await probe(db, who(unconfirmed, null), "select public.claim_app_member() as got");
      assert.equal(claimed.ok, true, claimed.error);
      assert.equal(claimed.rows[0].got, false, "the sign-in stub must join nobody, ever");

      const accepted = await probe(db, who(unconfirmed, null),
        "select public.accept_family_invitation($1)", [seatUnconfirmed]);
      assert.equal(accepted.ok, false, "an unconfirmed address accepted a family seat");
      assert.match(accepted.error, /confirm your email address first/iu);

      await asOwner(db);
      assert.equal(await value(db,
        "select user_id from public.app_members where id = $1", [seatUnconfirmed]), null);
    });

    test("the same account, once confirmed, may accept it", async () => {
      await asOwner(db);
      await db.query("update auth.users set email_confirmed_at = now() where id = $1", [unconfirmed]);

      const accepted = await probe(db, who(unconfirmed, null),
        "select public.accept_family_invitation($1) as area", [seatUnconfirmed]);
      assert.equal(accepted.ok, true, accepted.error);
      assert.equal(accepted.rows[0].area, f.areas.bravo);

      await asOwner(db);
      assert.equal(await value(db,
        "select user_id from public.app_members where id = $1", [seatUnconfirmed]), unconfirmed);
    });

    test("a confirmed account takes only the seat addressed to it", async () => {
      const accepted = await probe(db, who(confirmed, null),
        "select public.accept_family_invitation($1) as area", [seatConfirmed]);
      assert.equal(accepted.ok, true, accepted.error);

      await asOwner(db);
      assert.equal(await value(db,
        "select user_id from public.app_members where id = $1", [seatConfirmed]), confirmed);
      // And it took nothing else with it.
      assert.equal(await value(db,
        "select count(*)::int from public.app_members where user_id = $1", [confirmed]), 1);
    });

    test("an inactive invitation is not claimable at all", async () => {
      await asOwner(db);
      const user = await value(db, `
        insert into auth.users (email, email_confirmed_at)
        values ('claim-revoked@example.test', now()) returning id`);
      const person = await value(db,
        "insert into public.people (area_id, name) values ($1, 'Revoked') returning id", [f.areas.bravo]);
      const seat = await value(db, `
        insert into public.app_members (area_id, person_id, email, role, active)
        values ($1, $2, 'claim-revoked@example.test', 'member', false) returning id`, [f.areas.bravo, person]);

      const accepted = await probe(db, who(user, null),
        "select public.accept_family_invitation($1)", [seat]);
      assert.equal(accepted.ok, false, "a revoked invitation must not be acceptable");
      assert.match(accepted.error, /that invitation is not yours/iu);
      await asOwner(db);
      assert.equal(await value(db, "select user_id from public.app_members where id = $1", [seat]), null);
    });

    test("a seat in a family they are already in is refused, not doubled", async () => {
      /*
       * THE ONLY WAY THIS CASE CAN ARISE, and it is worth spelling out. The
       * unique index on (area_id, lower(email)) makes two seats with the SAME
       * address in one family impossible -- so the guard inside
       * `claim_app_member` is not about that. It is about an account whose
       * address has CHANGED: the old seat is taken and caches the old address,
       * and a second invitation goes out to the new one. Same family, two rows,
       * two different addresses, one login.
       *
       * 053 makes the refusal EXPLICIT rather than silent. The old routine
       * skipped the row and reported success for the others; the new one is
       * asked about one invitation and says no to it.
       */
      await asOwner(db);
      await db.query("update auth.users set email = 'moved-on@example.test' where id = $1", [confirmed]);
      const person = await value(db,
        "insert into public.people (area_id, name) values ($1, 'Second seat') returning id", [f.areas.bravo]);
      const secondSeat = await value(db, `
        insert into public.app_members (area_id, person_id, email, role, active)
        values ($1, $2, 'moved-on@example.test', 'member', true) returning id`, [f.areas.bravo, person]);

      const accepted = await probe(db, who(confirmed, null),
        "select public.accept_family_invitation($1)", [secondSeat]);
      assert.equal(accepted.ok, false, "a second seat in one family must be refused");
      assert.match(accepted.error, /that invitation is not yours/iu);

      await asOwner(db);
      assert.equal(await value(db,
        "select user_id from public.app_members where id = $1", [secondSeat]), null,
      "the second seat in a family they are already in must be left alone");
      assert.equal(await value(db, `
        select count(*)::int from public.app_members
        where user_id = $1 and area_id = $2`, [confirmed, f.areas.bravo]), 1,
      "one login must never hold two seats in one family");
    });

    test("EVERY user_id it ever wrote belongs to a CONFIRMED account", async () => {
      /*
       * The address is checked at the moment of the claim and cached; an
       * account that changes its email afterwards leaves the cached column
       * stale, which is legitimate and is exactly what `grant_area_access`
       * branch 3 heals. What can never be stale is the confirmation: an
       * unconfirmed account must not hold a claimed seat at all.
       */
      await asOwner(db);
      const wrong = await value(db, `
        select count(*)::int from public.app_members m
        join auth.users u on u.id = m.user_id
        where m.email like 'claim-%' and u.email_confirmed_at is null`);
      assert.equal(wrong, 0, "an unconfirmed account holds a claimed family seat");

      // And every one of them was claimed by the account that owned the
      // address at the time -- checked on the seats nothing has since moved.
      const mismatched = await value(db, `
        select count(*)::int from public.app_members m
        join auth.users u on u.id = m.user_id
        where m.email like 'claim-%'
          and lower(u.email) is distinct from lower(m.email)
          and u.email <> 'moved-on@example.test'`);
      assert.equal(mismatched, 0, "a claimed seat exists whose login never owned its address");
    });
  });
});

// ===========================================================================
// 9-11. FAMILY ACCESS, IN THE DATABASE
// ===========================================================================

describe("grant_area_access, revoke_area_access and list_area_access", () => {
  let db, f, admin, alpha;

  before(async () => {
    db = await buildRehearsal({});
    f = await buildTwoFamilies(db);
    admin = f.users.dual;
    alpha = f.areas.alpha;
  });
  after(async () => { await db?.close(); });

  const asAdmin = (sql, params) => probe(db, who(admin, alpha), sql, params);

  /** A person in Alpha with no membership row of any kind. */
  async function freshPerson(name) {
    const made = await probe(db, who(admin, alpha),
      "select id from public.create_person($1, null, null, null)", [name]);
    assert.equal(made.ok, true, made.error);
    return made.rows[0].id;
  }

  async function seatOf(personId) {
    await asOwner(db);
    return (await rows(db,
      "select id, user_id, email, role, active from public.app_members where person_id = $1", [personId]))[0];
  }

  describe("granting", () => {
    test("BRANCH 1: a person with no seat gets an UNCLAIMED invitation", async () => {
      const person = await freshPerson("Newcomer");
      const done = await asAdmin("select public.grant_area_access($1, $2)", [person, "Newcomer@Example.TEST "]);
      assert.equal(done.ok, true, done.error);

      const seat = await seatOf(person);
      assert.equal(seat.email, "newcomer@example.test", "the address must be normalised on the way in");
      assert.equal(seat.user_id, null, "granting access must NEVER attach a login");
      assert.equal(seat.role, "member");
      assert.equal(seat.active, true);
    });

    test("AND IT STAYS UNCLAIMED EVEN WHEN AN ACCOUNT WITH THAT ADDRESS ALREADY EXISTS", async () => {
      await asOwner(db);
      await db.query(
        "insert into auth.users (email, email_confirmed_at) values ('waiting@example.test', now())");
      const person = await freshPerson("Waiting");
      assert.equal((await asAdmin("select public.grant_area_access($1, $2)",
        [person, "waiting@example.test"])).ok, true);

      const seat = await seatOf(person);
      assert.equal(seat.user_id, null,
        "the routine resolved an account by email and attached it -- only claim_app_member may do that");
    });

    test("BRANCH 2: an existing UNCLAIMED invitation can be re-addressed", async () => {
      const person = await freshPerson("Typo");
      await asAdmin("select public.grant_area_access($1, $2)", [person, "wrogn@example.test"]);
      assert.equal((await asAdmin("select public.grant_area_access($1, $2)",
        [person, "right@example.test"])).ok, true);

      const seat = await seatOf(person);
      assert.equal(seat.email, "right@example.test");
      assert.equal(seat.user_id, null);
    });

    test("BRANCH 3: a CLAIMED seat is restored when the address is its account's current one", async () => {
      /*
       * The fixture writes a placeholder into `app_members.email` and links a
       * different real address in `auth.users`, which is exactly the drift this
       * branch has to survive: the cached column is not the identity.
       */
      await asOwner(db);
      const stale = await value(db,
        "select email from public.app_members where id = $1", [f.members.moAlpha]);
      const real = await value(db, "select email from auth.users where id = $1", [f.users.mo]);
      assert.notEqual(stale, real, "the fixture must have a stale cached email for this to prove anything");

      await db.query("update public.app_members set active = false where id = $1", [f.members.moAlpha]);

      const done = await asAdmin("select public.grant_area_access($1, $2)", [f.people.mo, real]);
      assert.equal(done.ok, true, done.error);

      const seat = await seatOf(f.people.mo);
      assert.equal(seat.active, true, "access was not restored");
      assert.equal(seat.email, real.toLowerCase(), "the stale cached address was not healed");
      assert.equal(seat.user_id, f.users.mo, "the login on the seat must not change");
    });

    test("AND THE STALE ADDRESS ITSELF IS REFUSED -- the cache is not the identity", async () => {
      await asOwner(db);
      const stale = await value(db, "select email from auth.users where id = $1", [f.users.taylor]);
      await db.query("update public.app_members set email = 'old-address@example.test' where id = $1",
        [f.members.taylorAlpha]);

      const wrong = await asAdmin("select public.grant_area_access($1, $2)",
        [f.people.taylor, "old-address@example.test"]);
      assert.equal(wrong.ok, false, "a seat was re-granted against a stale cached address");
      assert.match(wrong.error, /different account/iu);

      // And the live one still works.
      assert.equal((await asAdmin("select public.grant_area_access($1, $2)", [f.people.taylor, stale])).ok,
        true, "the account's REAL confirmed address must be the one that works");
    });

    test("BRANCH 4: a different address on a claimed seat is REFUSED, never transferred", async () => {
      const refused = await asAdmin("select public.grant_area_access($1, $2)",
        [f.people.mo, "someone-else@example.test"]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /different account/iu);

      const seat = await seatOf(f.people.mo);
      assert.equal(seat.user_id, f.users.mo, "a refused grant still moved the seat");
    });

    test("BRANCH 5: a claimed seat whose account never confirmed its email is refused", async () => {
      await asOwner(db);
      const user = await value(db, `
        insert into auth.users (email, email_confirmed_at)
        values ('never-confirmed@example.test', null) returning id`);
      const person = await freshPerson("Unconfirmed seat");
      await db.query(`
        insert into public.app_members (area_id, person_id, user_id, email, role, active)
        values ($1, $2, $3, 'never-confirmed@example.test', 'member', true)`, [alpha, person, user]);

      const refused = await asAdmin("select public.grant_area_access($1, $2)",
        [person, "never-confirmed@example.test"]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /no confirmed email/iu);
    });

    test("a duplicate address inside one family is refused with a sentence", async () => {
      const person = await freshPerson("Collider");
      const refused = await asAdmin("select public.grant_area_access($1, $2)",
        [person, "newcomer@example.test"]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /already uses that email/iu);
    });

    test("but the same address in ANOTHER family is fine -- they are two families", async () => {
      const made = await probe(db, who(f.users.bravoadmin, f.areas.bravo),
        "select id from public.create_person($1, null, null, null)", ["Same address"]);
      assert.equal((await probe(db, who(f.users.bravoadmin, f.areas.bravo),
        "select public.grant_area_access($1, $2)", [made.rows[0].id, "newcomer@example.test"])).ok, true);
    });

    test("A PERSON IN ANOTHER FAMILY IS REFUSED", async () => {
      const refused = await asAdmin("select public.grant_area_access($1, $2)",
        [f.people.jo, "reaching@example.test"]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /another family/iu);
    });

    test("AND THE ADMINISTRATOR'S OWN SEAT IS REFUSED", async () => {
      const refused = await asAdmin("select public.grant_area_access($1, $2)",
        [f.people.ada, "ada-new@example.test"]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /handing over the family/iu);
    });

    test("an ordinary member cannot grant access at all", async () => {
      const person = await freshPerson("Not yours to give");
      const refused = await probe(db, who(f.users.mo, alpha),
        "select public.grant_area_access($1, $2)", [person, "nope@example.test"]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /administrator/iu);
    });

    test("nor can an administrator of a DIFFERENT family, even naming the right person", async () => {
      const person = await freshPerson("Coveted");
      const refused = await probe(db, who(f.users.bravoadmin, f.areas.bravo),
        "select public.grant_area_access($1, $2)", [person, "nope2@example.test"]);
      assert.equal(refused.ok, false);
    });

    test("a malformed address is refused before anything is written", async () => {
      const person = await freshPerson("Malformed");
      for (const bad of ["", "   ", "notanemail", "no@domain", "two@@at.test", "with space@example.test"]) {
        const refused = await asAdmin("select public.grant_area_access($1, $2)", [person, bad]);
        assert.equal(refused.ok, false, `"${bad}" was accepted as an email address`);
      }
      assert.equal(await seatOf(person), undefined, "a refused grant created a seat anyway");
    });

    test("NO BRANCH ANYWHERE ASSIGNED A user_id -- every seat it created is still empty", async () => {
      /*
       * Measured over the seats THIS section made, because the fixture's own
       * seats were claimed before any of this ran and a whole-table sweep would
       * count those as failures. Every person named below reached its seat only
       * through `grant_area_access`, so any user_id on one of them was invented
       * by the routine -- which is the defect this asserts against.
       */
      await asOwner(db);
      const invented = await rows(db, `
        select p.name, m.user_id
        from public.app_members m join public.people p on p.id = m.person_id
        where p.area_id = $1
          and p.name in ('Newcomer', 'Waiting', 'Typo', 'Collider', 'Not yours to give', 'Coveted')
          and m.user_id is not null`, [alpha]);
      assert.deepEqual(invented, [],
        "grant_area_access attached a login to a seat -- only claim_app_member may do that");
      // And the sweep had something to look at.
      assert.ok(await value(db, `
        select count(*)::int from public.app_members m join public.people p on p.id = m.person_id
        where p.area_id = $1 and p.name in ('Newcomer', 'Waiting', 'Typo')`, [alpha]) >= 3);
    });
  });

  describe("revoking", () => {
    test("the default disables the seat and keeps both the login and the address", async () => {
      const before = await seatOf(f.people.jade);
      assert.equal((await asAdmin("select public.revoke_area_access($1)", [f.people.jade])).ok, true);

      const after = await seatOf(f.people.jade);
      assert.equal(after.active, false);
      assert.equal(after.user_id, before.user_id, "user_id must be preserved without p_unlink");
      assert.equal(after.email, before.email, "the address must be preserved without p_unlink");
    });

    test("and the revoked member can read nothing OF THAT FAMILY", async () => {
      // Jade is also a member of Bravo, so the assertion has to name Alpha.
      // "Revoked here" must not mean "revoked everywhere" -- that is the same
      // separation `leave_area` is tested for, arriving by a different door.
      assert.equal(await seen(db, who(f.users.jade, alpha), "people", "area_id = $1", [alpha]), 0);
      assert.equal(await seen(db, who(f.users.jade, alpha), "areas", "id = $1", [alpha]), 0);
      assert.ok(await seen(db, who(f.users.jade, f.areas.bravo), "people", "area_id = $1", [f.areas.bravo]) > 0,
        "revoking access in one family must not touch another");
    });

    test("restoring them brings back the same seat, not a second one", async () => {
      await asOwner(db);
      const real = await value(db, "select email from auth.users where id = $1", [f.users.jade]);
      assert.equal((await asAdmin("select public.grant_area_access($1, $2)", [f.people.jade, real])).ok, true);
      const seat = await seatOf(f.people.jade);
      assert.equal(seat.active, true);
      assert.equal(seat.user_id, f.users.jade);
    });

    test("P_UNLINK IS THE ONLY THING THAT CLEARS THE LOGIN, and it is explicit", async () => {
      assert.equal((await asAdmin("select public.revoke_area_access($1, true)", [f.people.jade])).ok, true);
      const seat = await seatOf(f.people.jade);
      assert.equal(seat.active, false);
      assert.equal(seat.user_id, null, "p_unlink => true must clear the login");
      assert.equal(seat.email, (await seatOf(f.people.jade)).email, "the address is still there to re-invite");
    });

    test("after an unlink, a fresh grant creates an EMPTY seat again", async () => {
      assert.equal((await asAdmin("select public.grant_area_access($1, $2)",
        [f.people.jade, "jade-new@example.test"])).ok, true);
      const seat = await seatOf(f.people.jade);
      assert.equal(seat.user_id, null, "the seat must wait for a claim, not be handed to anybody");
      assert.equal(seat.email, "jade-new@example.test");
      assert.equal(seat.active, true);
    });

    test("THE ADMINISTRATOR'S OWN SEAT IS REFUSED, and named as a handover", async () => {
      const refused = await asAdmin("select public.revoke_area_access($1)", [f.people.ada]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /handing over the family/iu);

      const seat = await seatOf(f.people.ada);
      assert.equal(seat.active, true, "the family lost its administrator");
      assert.equal(seat.role, "admin");
    });

    test("and so is the unlink form of the same call", async () => {
      const refused = await asAdmin("select public.revoke_area_access($1, true)", [f.people.ada]);
      assert.equal(refused.ok, false);
      assert.equal((await seatOf(f.people.ada)).user_id, admin, "the administrator was unlinked from their own family");
    });

    test("a person in another family is refused", async () => {
      const refused = await asAdmin("select public.revoke_area_access($1)", [f.people.jo]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /another family/iu);
    });

    test("a person with no seat is a not-found, not a silent success", async () => {
      const person = await freshPerson("Never invited");
      const refused = await asAdmin("select public.revoke_area_access($1)", [person]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /no access to take away/iu);
    });

    test("an ordinary member cannot revoke anybody", async () => {
      const refused = await probe(db, who(f.users.taylor, alpha),
        "select public.revoke_area_access($1)", [f.people.mo]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /administrator/iu);
    });
  });

  describe("list_area_access", () => {
    test("the acting Area's administrator sees that Area's people, and only those", async () => {
      const listed = await probe(db, who(admin, alpha), "select * from public.list_area_access()");
      assert.equal(listed.ok, true, listed.error);

      await asOwner(db);
      const alphaPeople = await value(db,
        "select count(*)::int from public.people where area_id = $1", [alpha]);
      assert.equal(listed.rows.length, alphaPeople);

      const bravoNames = (await rows(db,
        "select name from public.people where area_id = $1", [f.areas.bravo])).map((r) => r.name);
      for (const row of listed.rows) {
        assert.ok(!bravoNames.includes(row.person_name) || row.person_name === undefined,
          `${row.person_name} belongs to another family`);
      }
    });

    test("standing in the OTHER family lists the other family, not this one", async () => {
      const inCharlie = await probe(db, who(admin, f.areas.charlie), "select * from public.list_area_access()");
      assert.equal(inCharlie.ok, true, inCharlie.error);
      await asOwner(db);
      assert.equal(inCharlie.rows.length, await value(db,
        "select count(*)::int from public.people where area_id = $1", [f.areas.charlie]));
    });

    test("IT TAKES NO AREA ARGUMENT, so it cannot be pointed at a family you do not run", async () => {
      await asOwner(db);
      const overloads = await rows(db, `
        select pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p where p.proname = 'list_area_access' and p.pronamespace = 'public'::regnamespace`);
      assert.deepEqual(overloads.map((r) => r.args), [""], "list_area_access must take no parameters at all");
    });

    test("an ordinary member of the same family is refused", async () => {
      const refused = await probe(db, who(f.users.mo, alpha), "select * from public.list_area_access()");
      assert.equal(refused.ok, false);
      assert.match(refused.error, /administrator/iu);
    });

    test("an administrator with no Area on screen is refused rather than guessed at", async () => {
      const refused = await probe(db, who(admin, null), "select * from public.list_area_access()");
      assert.equal(refused.ok, false);
      assert.match(refused.error, /which family/iu);
    });

    test("IT ENUMERATES NO ACCOUNT -- every row it returns is a seat in this family", async () => {
      /*
       * The distinction that matters. An address this Area's administrator
       * TYPED IN is theirs to see: it is on a seat they created. What must not
       * be reachable is the Auth table -- an account that has nothing to do
       * with this family, or the answer to "does an account exist for X?".
       *
       * So the assertion is about the SEATS, not the strings: every membership
       * id and every person the listing returns belongs to Alpha, and there is
       * no parameter through which to ask about anything else.
       */
      const listed = await probe(db, who(admin, alpha), "select * from public.list_area_access()");
      assert.equal(listed.ok, true, listed.error);

      await asOwner(db);
      const alphaMembers = new Set((await rows(db,
        "select id from public.app_members where area_id = $1", [alpha])).map((r) => r.id));
      const alphaPeople = new Set((await rows(db,
        "select id from public.people where area_id = $1", [alpha])).map((r) => r.id));

      for (const row of listed.rows) {
        assert.ok(alphaPeople.has(row.person_id), "a person from another family was listed");
        if (row.app_member_id !== null) {
          assert.ok(alphaMembers.has(row.app_member_id), "a membership from another family was listed");
        }
      }

      // And an account with no seat here is invisible however it is asked for.
      const outsiderEmail = await value(db, "select email from auth.users where id = $1", [f.users.bravoadmin]);
      assert.ok(!listed.rows.some((r) => r.email === outsiderEmail),
        "an account with no seat in this family appeared in its access list");
    });

    test("an unclaimed seat reports no account status at all, rather than a guess", async () => {
      const listed = await probe(db, who(admin, alpha), "select * from public.list_area_access()");
      for (const row of listed.rows) {
        if (row.claimed === false) {
          assert.equal(row.account_status, null, "an unclaimed seat must not report a global status");
          assert.equal(row.email_confirmed, null);
        }
      }
    });
  });
});

// ===========================================================================
// 12-13. GLOBAL ADMINISTRATION, AND WHAT IT IS NOT
// ===========================================================================

describe("global administration is not family administration", () => {
  let db, f, root, second, outsider;

  before(async () => {
    db = await buildRehearsal({});
    f = await buildTwoFamilies(db);
    await asOwner(db);

    // A Gift Planner administrator who belongs to NO family. The separation
    // this whole design rests on, built as its own account on purpose.
    root = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('root@example.test', now()) returning id`);
    second = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('second@example.test', now()) returning id`);
    outsider = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('unconfirmed-admin@example.test', null) returning id`);

    // The bootstrap, done the way the operator statement does it -- directly,
    // because grant_global_admin requires a caller who is already one.
    await db.query(`
      insert into public.app_accounts (user_id, status, is_global_admin, decided_at)
      values ($1, 'approved', true, now())`, [root]);
    await db.query("insert into public.app_accounts (user_id, status) values ($1, 'approved')", [second]);
  });
  after(async () => { await db?.close(); });

  const asRoot = (sql, params) => probe(db, who(root, null), sql, params);

  test("A ZERO-AREA GLOBAL ADMINISTRATOR SEES NO FAMILY DATA WHATSOEVER", async () => {
    const visible = await visibleEverywhere(db, who(root, f.areas.alpha));
    for (const [table, n] of Object.entries(visible)) {
      if (typeof n === "number") {
        assert.equal(n, 0, `the Gift Planner administrator can read ${n} row(s) of ${table}`);
      }
    }
  });

  test("but they can read the global queue", async () => {
    const listed = await asRoot("select * from public.list_accounts()");
    assert.equal(listed.ok, true, listed.error);
    assert.ok(listed.rows.length > 0);
    // And it carries no family data of any kind.
    assert.deepEqual(Object.keys(listed.rows[0]).sort(), [
      "decided_at", "decided_by", "decision_note", "email", "email_confirmed",
      "is_global_admin", "signed_up_at", "status", "user_id",
    ]);
  });

  test("filtering the queue by status works, and an unknown status is refused", async () => {
    const pending = await asRoot("select * from public.list_accounts($1)", ["pending"]);
    assert.equal(pending.ok, true, pending.error);
    for (const row of pending.rows) assert.equal(row.status, "pending");

    const nonsense = await asRoot("select * from public.list_accounts($1)", ["approvedish"]);
    assert.equal(nonsense.ok, false);
    assert.match(nonsense.error, /Unknown account status/iu);
  });

  test("A FAMILY ADMINISTRATOR CANNOT APPROVE ANYBODY, and cannot even see the queue", async () => {
    const listed = await probe(db, who(f.users.dual, f.areas.alpha), "select * from public.list_accounts()");
    assert.equal(listed.ok, false);
    assert.match(listed.error, /Gift Planner administrator/iu);

    const decided = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.set_account_status($1, $2)", [second, "approved"]);
    assert.equal(decided.ok, false);
    assert.match(decided.error, /Gift Planner administrator/iu);
  });

  test("and neither can an ordinary member, nor a signed-out visitor", async () => {
    for (const actor of [who(f.users.mo, f.areas.alpha), anon]) {
      const decided = await probe(db, actor, "select public.set_account_status($1, $2)", [second, "approved"]);
      assert.equal(decided.ok, false);
    }
  });

  test("an unconfirmed account cannot be approved", async () => {
    const decided = await asRoot("select public.set_account_status($1, $2)", [outsider, "approved"]);
    assert.equal(decided.ok, false);
    assert.match(decided.error, /not confirmed its email/iu);
  });

  test("nobody decides their own account", async () => {
    const decided = await asRoot("select public.set_account_status($1, $2)", [root, "suspended"]);
    assert.equal(decided.ok, false);
    assert.match(decided.error, /your own account/iu);
  });

  test("an unknown account is a not-found, and an unknown status is refused", async () => {
    const nobody = await asRoot("select public.set_account_status($1, $2)",
      ["00000000-0000-0000-0000-000000000000", "approved"]);
    assert.equal(nobody.ok, false);
    assert.match(nobody.error, /No such account/iu);

    const nonsense = await asRoot("select public.set_account_status($1, $2)", [second, "banished"]);
    assert.equal(nonsense.ok, false);
    assert.match(nonsense.error, /Unknown account status/iu);
  });

  test("a decision note is bounded and control-character-safe", async () => {
    const long = await asRoot("select public.set_account_status($1, $2, $3)",
      [second, "approved", "x".repeat(501)]);
    assert.equal(long.ok, false);
    assert.match(long.error, /at most 500/iu);

    const control = await asRoot("select public.set_account_status($1, $2, $3)",
      [second, "approved", "line one\nline two"]);
    assert.equal(control.ok, false);
    assert.match(control.error, /control characters/iu);
  });

  test("GRANTING GLOBAL ADMINISTRATION CREATES NO FAMILY MEMBERSHIP", async () => {
    await asOwner(db);
    const membershipsBefore = await value(db, "select count(*)::int from public.app_members");

    assert.equal((await asRoot("select public.grant_global_admin($1)", [second])).ok, true);

    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.app_members"), membershipsBefore,
      "appointing a Gift Planner administrator wrote a family membership");
    assert.equal(await value(db,
      "select is_global_admin from public.app_accounts where user_id = $1", [second]), true);
  });

  test("and the new administrator still sees no family data", async () => {
    const visible = await visibleEverywhere(db, who(second, f.areas.alpha));
    for (const [table, n] of Object.entries(visible)) {
      // `audit_log` is the one table a global administrator CAN read a row of,
      // and only ever a global decision -- which is asserted on its own terms
      // below rather than counted to zero here.
      if (table === "audit_log") continue;
      if (typeof n === "number") assert.equal(n, 0, `${table} leaked to a global administrator`);
    }
  });

  test("and the only audit row they can read is a global decision with no Area", async () => {
    const entries = await probe(db, who(second, f.areas.alpha),
      "select table_name, area_id from public.audit_log");
    assert.ok(entries.rows.length > 0, "the appointment they were the subject of should be readable");
    for (const row of entries.rows) {
      assert.equal(row.table_name, "app_accounts", `a global administrator read a ${row.table_name} entry`);
      assert.equal(row.area_id, null);
    }
  });

  test("an unapproved or unconfirmed target cannot be appointed", async () => {
    await asOwner(db);
    const pendingUser = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('pending-admin@example.test', now()) returning id`);

    const notApproved = await asRoot("select public.grant_global_admin($1)", [pendingUser]);
    assert.equal(notApproved.ok, false);
    assert.match(notApproved.error, /must be approved/iu);

    await db.query("insert into public.app_accounts (user_id, status) values ($1, 'approved')", [outsider]);
    const notConfirmed = await asRoot("select public.grant_global_admin($1)", [outsider]);
    assert.equal(notConfirmed.ok, false);
    assert.match(notConfirmed.error, /not confirmed its email/iu);
  });

  test("THE LAST GLOBAL ADMINISTRATOR CANNOT BE STOOD DOWN", async () => {
    // Two exist right now, so standing one down is allowed...
    assert.equal((await asRoot("select public.revoke_global_admin($1)", [second])).ok, true);

    // ...and now root is the last, so standing THEMSELVES down is refused.
    const refused = await asRoot("select public.revoke_global_admin($1)", [root]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /last Gift Planner administrator/iu);

    await asOwner(db);
    assert.equal(await value(db,
      "select count(*)::int from public.app_accounts where is_global_admin = true"), 1);
  });

  test("standing down somebody who is not an administrator is a not-found", async () => {
    const refused = await asRoot("select public.revoke_global_admin($1)", [second]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /does not administer/iu);
  });

  test("SUSPENDING AN ADMINISTRATOR CLEARS THE FLAG, AND RE-APPROVAL DOES NOT RESTORE IT", async () => {
    assert.equal((await asRoot("select public.grant_global_admin($1)", [second])).ok, true);
    assert.equal((await asRoot("select public.set_account_status($1, $2)", [second, "suspended"])).ok, true);

    await asOwner(db);
    const suspended = (await rows(db,
      "select status, is_global_admin from public.app_accounts where user_id = $1", [second]))[0];
    assert.deepEqual(suspended, { status: "suspended", is_global_admin: false });

    assert.equal((await asRoot("select public.set_account_status($1, $2)", [second, "approved"])).ok, true);
    await asOwner(db);
    assert.equal(await value(db,
      "select is_global_admin from public.app_accounts where user_id = $1", [second]), false,
    "re-approval silently restored global administration");
  });

  test("and the database itself refuses an unapproved administrator, whatever a routine does", async () => {
    await asOwner(db);
    const forced = await attempt(db,
      "update public.app_accounts set status = 'suspended' where user_id = $1", [root]);
    assert.equal(forced.ok, false, "the CHECK constraint must refuse an unapproved global administrator");
    assert.match(forced.error, /app_accounts_admin_must_be_approved/u);
  });

  test("a suspended account is refused by the front door even holding a membership", async () => {
    assert.equal((await asRoot("select public.set_account_status($1, $2, $3)",
      [f.users.mo, "suspended", "Left the family"])).ok, true);
    assert.equal(await seen(db, who(f.users.mo, f.areas.alpha), "people"), 0);

    assert.equal((await asRoot("select public.set_account_status($1, $2)", [f.users.mo, "approved"])).ok, true);
    assert.ok(await seen(db, who(f.users.mo, f.areas.alpha), "people") > 0);
  });
});

// ===========================================================================
// 14. THE GLOBAL AUDIT TRAIL
// ===========================================================================

describe("a global decision is written down, and belongs to no family", () => {
  let db, f, root, subject;

  before(async () => {
    db = await buildRehearsal({});
    f = await buildTwoFamilies(db);
    await asOwner(db);

    /*
     * THE DECIDER IS ALSO A FAMILY ADMINISTRATOR, AND THAT IS THE POINT.
     *
     * `stamp_audit_area` step 2 reads the acting Area, and step 3 reads the
     * actor's single membership. Both would put Alpha on a global decision if
     * 052's early return were not there, and this account is standing in Alpha
     * while it decides.
     */
    root = f.users.bravoadmin;
    await db.query(
      "update public.app_accounts set is_global_admin = true where user_id = $1", [root]);
    subject = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('subject@example.test', now()) returning id`);
    await db.query("insert into public.app_accounts (user_id, status) values ($1, 'pending')", [subject]);
  });
  after(async () => { await db?.close(); });

  const decide = (sql, params) => probe(db, who(root, f.areas.bravo), sql, params);

  test("the decision is recorded with NO Area, even though the decider is standing in one", async () => {
    assert.equal((await decide("select public.set_account_status($1, $2, $3)",
      [subject, "rejected", "Not a family member"])).ok, true);

    await asOwner(db);
    const entry = (await rows(db, `
      select area_id, table_name, record_id, actor_user_id, actor_name, summary,
             celebrant_person_id, birthday_privacy_unknown, subject, amount_pennies
      from public.audit_log where table_name = 'app_accounts' order by id desc limit 1`))[0];

    assert.equal(entry.area_id, null, "a global decision was stamped with a family's Area");
    assert.equal(entry.record_id, subject);
    assert.equal(entry.actor_user_id, root);
    assert.equal(entry.actor_name, null, "a global entry must carry no family name");
    assert.equal(entry.summary, "Global account set to rejected");
    assert.equal(entry.celebrant_person_id, null);
    assert.equal(entry.birthday_privacy_unknown, false);
    assert.equal(entry.subject, null);
    assert.equal(entry.amount_pennies, null);
  });

  test("appointing and standing down are recorded distinctly", async () => {
    await asOwner(db);
    const other = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('appointee@example.test', now()) returning id`);
    await db.query("insert into public.app_accounts (user_id, status) values ($1, 'approved')", [other]);

    assert.equal((await decide("select public.grant_global_admin($1)", [other])).ok, true);
    assert.equal((await decide("select public.revoke_global_admin($1)", [other])).ok, true);

    await asOwner(db);
    const recent = (await rows(db, `
      select summary, area_id from public.audit_log
      where table_name = 'app_accounts' order by id desc limit 2`)).map((r) => r.summary);
    assert.deepEqual(recent, ["Global administrator revoked", "Global administrator granted"]);

    assert.equal(await value(db, `
      select count(*)::int from public.audit_log
      where table_name = 'app_accounts' and area_id is not null`), 0);
  });

  test("NOT ONE FAMILY MEMBER CAN SEE A GLOBAL ENTRY", async () => {
    for (const actor of [
      who(f.users.dual, f.areas.alpha),
      who(f.users.dual, f.areas.bravo),
      who(f.users.mo, f.areas.alpha),
      who(f.users.jade, f.areas.alpha),
    ]) {
      assert.equal(await seen(db, actor, "audit_log", "table_name = 'app_accounts'"), 0);
    }
  });

  test("and the family administrator who IS a global administrator sees them only as one", async () => {
    // `root` administers Bravo AND Gift Planner. Standing in Bravo they read
    // both their family's log and the global one -- the global rows arrive
    // through the second policy, and carry no Area, so no family is implicated.
    const global = await probe(db, who(root, f.areas.bravo),
      "select area_id, table_name from public.audit_log where table_name = 'app_accounts'");
    assert.ok(global.rows.length >= 3, "the global administrator should see the decisions they made");
    for (const row of global.rows) assert.equal(row.area_id, null);
  });

  test("a global administrator sees ONLY app_accounts rows through the new policy", async () => {
    // Somebody with the global flag and no family at all: everything they can
    // read is a global decision, and nothing else.
    await asOwner(db);
    const lone = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('lone-admin@example.test', now()) returning id`);
    await db.query(`
      insert into public.app_accounts (user_id, status, is_global_admin)
      values ($1, 'approved', true)`, [lone]);

    const all = await probe(db, who(lone, null), "select table_name, area_id from public.audit_log");
    assert.ok(all.rows.length > 0);
    for (const row of all.rows) {
      assert.equal(row.table_name, "app_accounts", `a global administrator read a ${row.table_name} entry`);
      assert.equal(row.area_id, null);
    }
  });

  test("AND AREA-LESS ROWS THAT ARE NOT GLOBAL DECISIONS STAY HIDDEN", async () => {
    /*
     * There are historic entries with no Area at all -- ones 049 could not
     * attribute to any family. The new policy must not be a door onto those,
     * which is why it carries `table_name = 'app_accounts'` as well as
     * `area_id is null`.
     */
    await asOwner(db);
    await db.exec("set session_replication_role = replica;");
    await db.query(`
      insert into public.audit_log (table_name, record_id, action, summary, subject, area_id)
      values ('purchases', gen_random_uuid(), 'added', 'purchases added', 'A secret present', null)`);
    await db.exec("set session_replication_role = origin;");

    const lone = await value(db, "select id from auth.users where email = 'lone-admin@example.test'");
    const seenRows = await probe(db, who(lone, null),
      "select id from public.audit_log where table_name = 'purchases'");
    assert.equal(seenRows.rows.length, 0, "an Area-less family entry was readable through the global policy");
  });

  test("and a birthday-sensitive row is still protected from everybody", async () => {
    await asOwner(db);
    await db.exec("set session_replication_role = replica;");
    await db.query(`
      insert into public.audit_log
        (table_name, record_id, action, summary, area_id, birthday_privacy_unknown)
      values ('gift_ideas', gen_random_uuid(), 'added', 'gift_ideas added', null, true)`);
    await db.exec("set session_replication_role = origin;");

    const lone = await value(db, "select id from auth.users where email = 'lone-admin@example.test'");
    for (const actor of [who(lone, null), who(f.users.dual, f.areas.alpha), who(root, f.areas.bravo)]) {
      assert.equal(await seen(db, actor, "audit_log", "birthday_privacy_unknown = true"), 0);
    }
  });
});

// ===========================================================================
// 15. THE PRIVILEGES THEMSELVES, MEASURED
// ===========================================================================

describe("EXECUTE, measured against the catalogue rather than assumed", () => {
  let db;

  const NEW_ROUTINES = [
    "public.is_globally_approved()",
    "public.is_global_admin()",
    "public.my_account_status()",
    "public.list_accounts(text)",
    "public.set_account_status(uuid, text, text)",
    "public.grant_global_admin(uuid)",
    "public.revoke_global_admin(uuid)",
    "public.grant_area_access(uuid, text)",
    "public.revoke_area_access(uuid, boolean)",
    "public.list_area_access()",
  ];

  before(async () => { db = await buildRehearsal({}); await asOwner(db); });
  after(async () => { await db?.close(); });

  test("all ten exist, and each is a SECURITY DEFINER with search_path pinned to nothing", async () => {
    for (const signature of NEW_ROUTINES) {
      assert.equal(await value(db, `select to_regprocedure(${literal(signature)}) is not null`), true,
        `${signature} is missing`);
      assert.equal(await value(db, `
        select p.prosecdef from pg_proc p where p.oid = ${literal(signature)}::regprocedure`), true,
      `${signature} is not SECURITY DEFINER`);
      assert.equal(await value(db, `
        select exists (
          select 1 from pg_proc p, unnest(p.proconfig) as cfg
          where p.oid = ${literal(signature)}::regprocedure
            and cfg in ('search_path=', 'search_path=""'))`), true,
      `${signature} does not pin search_path`);
    }
  });

  test("authenticated may call every one of them", async () => {
    for (const signature of NEW_ROUTINES) {
      assert.equal(
        await value(db, `select has_function_privilege('authenticated', ${literal(signature)}, 'execute')`),
        true, `${signature} is not callable by a signed-in account`);
    }
  });

  test("ANON MAY CALL NONE OF THEM", async () => {
    for (const signature of NEW_ROUTINES) {
      assert.equal(
        await value(db, `select has_function_privilege('anon', ${literal(signature)}, 'execute')`),
        false, `${signature} is reachable by the anonymous role`);
    }
  });

  test("and PUBLIC holds no grant on them either, which is what anon inherits", async () => {
    for (const signature of NEW_ROUTINES) {
      const acl = await value(db,
        `select coalesce(p.proacl::text, '') from pg_proc p where p.oid = ${literal(signature)}::regprocedure`);
      assert.ok(!acl.includes("=X/") || !/(^|,)=X\//u.test(acl),
        `${signature} is granted to PUBLIC: ${acl}`);
    }
  });

  /*
   * THE ONE THAT IS EASY TO GET WRONG, AND SILENTLY.
   *
   * A function named in a policy expression is executed with the CALLER's
   * privileges, not the policy owner's. So a policy that calls a routine
   * `authenticated` may not execute does not fail closed -- it fails, full
   * stop, and every read through that policy errors. Migration 048's header
   * says exactly this about four Area helpers. Both of 052's predicates are
   * named in policies, so both must keep the grant.
   */
  test("EVERY FUNCTION NAMED IN A POLICY IS CALLABLE BY authenticated", async () => {
    const named = new Set();
    const policies = await rows(db, `
      select coalesce(pg_get_expr(polqual, polrelid), '') || ' ' ||
             coalesce(pg_get_expr(polwithcheck, polrelid), '') as expr
      from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relnamespace = 'public'::regnamespace`);
    for (const { expr } of policies) {
      for (const match of expr.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gu)) named.add(match[1]);
    }

    const ours = await rows(db, `
      select p.proname, p.oid::regprocedure::text as signature
      from pg_proc p where p.pronamespace = 'public'::regnamespace`);

    let checked = 0;
    for (const { proname, signature } of ours) {
      if (!named.has(proname)) continue;
      checked += 1;
      assert.equal(
        await value(db, `select has_function_privilege('authenticated', ${literal(signature)}, 'execute')`),
        true, `${signature} is named in a policy but authenticated cannot execute it`);
    }
    assert.ok(checked >= 10, `the derivation found only ${checked} policy functions, so it proves little`);
    assert.ok(named.has("is_globally_approved"), "is_globally_approved must be named in a policy");
    assert.ok(named.has("is_global_admin"), "is_global_admin must be named in a policy");
  });

  test("and the routines that do NOT need a direct grant still do not have one", async () => {
    // 048's three internal helpers, unchanged by 052.
    for (const signature of [
      "public.area_of_record(text, uuid)",
      "public.area_of_written_row(text, jsonb)",
      "public.audit_actor_name()",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        assert.equal(
          await value(db, `select has_function_privilege('${role}', ${literal(signature)}, 'execute')`),
          false, `052 handed ${signature} back to ${role}`);
      }
    }
  });

  test("the eight redefined routines 053 left elevated are still pinned definers", async () => {
    /*
     * 052 REDEFINED NINE. 053 DELIBERATELY TOOK THE NINTH BACK DOWN.
     *
     * `claim_app_member()` was a SECURITY DEFINER routine because it wrote to
     * `app_members` on the caller's behalf. 053 removed that write, so the
     * privilege has nothing left to justify it -- and the next test proves it
     * is gone, rather than this one quietly tolerating either answer.
     */
    for (const signature of [
      "public.is_active_app_member()",
      "public.is_area_member(uuid)",
      "public.is_area_admin(uuid)",
      "public.is_own_app_member(uuid)",
      "public.is_app_admin()",
      "public.is_area_contributor_member(uuid)",
      "public.create_area(text, text)",
      "public.stamp_audit_area()",
    ]) {
      assert.equal(await value(db, `
        select p.prosecdef from pg_proc p where p.oid = ${literal(signature)}::regprocedure`), true,
      `${signature} stopped being SECURITY DEFINER`);
      assert.equal(await value(db, `
        select exists (
          select 1 from pg_proc p, unnest(p.proconfig) as cfg
          where p.oid = ${literal(signature)}::regprocedure
            and cfg in ('search_path=', 'search_path=""'))`), true,
      `${signature} lost its pinned search_path`);
    }
  });

  test("AND claim_app_member IS A HARMLESS STUB, NOT A DEFINER, AND STAYS CALLABLE", async () => {
    /*
     * THE ONE ROUTINE 053 TOOK PRIVILEGE AWAY FROM, asserted in the positive so
     * that restoring SECURITY DEFINER to satisfy an old catalogue expectation
     * fails here loudly.
     *
     * It cannot simply be dropped: the auth callback the deployed Worker is
     * running still calls it on every sign-in, and a missing routine would be
     * an error on the way in rather than a no-op. So it stays, reachable and
     * inert, until the runtime stops asking.
     */
    await asOwner(db);
    const [proc] = await rows(db, `
      select p.prosecdef, p.prosrc, p.provolatile, l.lanname
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.oid = 'public.claim_app_member()'::regprocedure`);

    assert.equal(proc.prosecdef, false, "claim_app_member must NOT be SECURITY DEFINER any more");
    assert.equal(proc.lanname, "sql", "it is a one-line SQL stub, not a procedural body");
    assert.match(proc.prosrc, /select\s+false/iu);
    for (const forbidden of ["update ", "insert into", "delete from", "app_members"]) {
      assert.ok(!proc.prosrc.toLowerCase().includes(forbidden),
        `the stub must not mention ${forbidden}`);
    }

    // Still reachable by exactly the role the runtime signs in as, and by
    // nobody else -- so the legacy caller keeps working and nothing widens.
    assert.equal(await value(db,
      "select has_function_privilege('authenticated', 'public.claim_app_member()', 'execute')"), true);
    // `anon` is revoked explicitly. `service_role` keeps it from Supabase's own
    // default privileges, as it does for every routine in this schema, and 053
    // deliberately grants it nothing new -- there is nothing left to grant.
    assert.equal(await value(db,
      "select has_function_privilege('anon', 'public.claim_app_member()', 'execute')"), false,
    "claim_app_member must not be executable by anon");

    // And calling it as a signed-in stranger joins them to nothing.
    const stranger = await value(db, `
      insert into auth.users (email, email_confirmed_at)
      values ('stub-caller@example.test', now()) returning id`);
    const before = Number(await value(db, "select count(*)::int from public.app_members where user_id is not null"));
    const called = await probe(db, who(stranger, null), "select public.claim_app_member() as got");
    assert.equal(called.ok, true, called.error);
    assert.equal(called.rows[0].got, false);
    await asOwner(db);
    assert.equal(
      Number(await value(db, "select count(*)::int from public.app_members where user_id is not null")), before,
      "signing in must not attach a single login to a single seat");
  });
});
