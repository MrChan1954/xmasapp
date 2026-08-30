/**
 * WHAT `authenticated` MAY DO TO A TABLE, ASKED RATHER THAN READ.
 *
 * WHY THIS SUITE EXISTS. Row level security is the answer to almost every
 * question about what a signed-in family member can reach -- but not to all of
 * them. Row policies are consulted for SELECT, INSERT, UPDATE and DELETE. They
 * are NOT consulted for TRUNCATE, which is a table privilege and nothing else.
 * So a table carrying a blanket grant is not made safe by having good policies:
 * one statement empties it, for every family at once, and no policy is asked.
 *
 * Supabase's project default hands every new table in `public` ALL privileges
 * to the browser roles:
 *
 *     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 *       GRANT ALL ON TABLES TO anon, authenticated, service_role
 *
 * A migration that adds the grant it means without first revoking that default
 * leaves the rest behind. Two tables did exactly that -- `areas` (034) and
 * `birthday_wishlist_ideas` (040) -- and migration 051 narrowed them.
 *
 * THE GENERAL TEST IS THE IMPORTANT ONE. Section 4 does not name a table: it
 * sweeps every table in `public` and fails if any of them has handed a browser
 * role a privilege beyond the four DML verbs. That is what stops the next table
 * arriving with the same defect, which is how these two got here.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";
import { asOwner, buildRehearsal, probe, rows, value, literal } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

let db;
let f;

/** The privileges a PostgREST client can ever actually use. */
const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"];

/** What a role has been granted on one table, sorted, straight from the catalogue. */
async function grantedOn(table, role) {
  const result = await rows(db, `
    select a.privilege_type
    from pg_class c, aclexplode(c.relacl) a
    where c.oid = ${literal("public." + table)}::regclass
      and a.grantee = ${literal(role)}::regrole
    order by 1`);
  return result.map((r) => r.privilege_type);
}

before(async () => {
  db = await buildRehearsal({});
  f = await buildTwoFamilies(db);

  // One wishlist row in each of the three Areas, so a successful TRUNCATE would
  // visibly cross a family boundary rather than emptying an empty table. Seeded
  // past the anchor trigger on purpose: the trigger is not what is under test.
  await asOwner(db);
  await db.exec("set session_replication_role = replica;");
  for (const [area, person] of [
    [f.areas.alpha, f.people.taylor],
    [f.areas.bravo, f.people.jo],
    [f.areas.charlie, f.people.cass],
  ]) {
    const member = await value(db, `select id from public.app_members where area_id = ${literal(area)} limit 1`);
    await db.query(
      `insert into public.birthday_wishlist_ideas
         (person_id, area_id, title, occurrence_year, created_by_app_member_id)
       values ($1, $2, $3, 2026, $4)`,
      [person, area, "wish", member],
    );
  }
  await db.exec("set session_replication_role = origin;");
});
after(async () => { await db?.close(); });

// ===========================================================================
// 1. The two tables migration 051 narrowed
// ===========================================================================

describe("migration 051 left exactly the privileges the application uses", () => {
  test("`areas` gives authenticated SELECT and nothing else", async () => {
    // Every write to an Area goes through create_area, set_area_name,
    // set_area_archived, leave_area or transfer_area_admin. Those are SECURITY
    // DEFINER and run with the owner's rights, so they never consult the
    // caller's table grant -- which is why SELECT is the whole of it.
    assert.deepEqual(await grantedOn("areas", "authenticated"), ["SELECT"]);
  });

  test("`birthday_wishlist_ideas` gives authenticated the four DML verbs and nothing else", async () => {
    // The wishlist editor writes straight from the browser, so unlike `areas`
    // this one really does need INSERT, UPDATE and DELETE.
    assert.deepEqual(
      await grantedOn("birthday_wishlist_ideas", "authenticated"),
      ["DELETE", "INSERT", "SELECT", "UPDATE"],
    );
  });

  test("anon holds nothing on either", async () => {
    for (const table of ["areas", "birthday_wishlist_ideas"]) {
      assert.deepEqual(await grantedOn(table, "anon"), [], `anon must hold nothing on ${table}`);
    }
  });

  test("service_role keeps everything on both", async () => {
    // It bypasses row level security and the write barrier regardless, so
    // narrowing it would buy nothing and would surprise server-side code.
    for (const table of ["areas", "birthday_wishlist_ideas"]) {
      for (const privilege of [...DML, "TRUNCATE"]) {
        assert.equal(
          await value(db, `select has_table_privilege('service_role', ${literal("public." + table)}, ${literal(privilege)})`),
          true,
          `service_role must keep ${privilege} on ${table}`,
        );
      }
    }
  });
});

// ===========================================================================
// 2. TRUNCATE, attempted rather than assumed
// ===========================================================================

describe("a signed-in member cannot empty a table row level security is guarding", () => {
  /*
   * THE POINT OF DOING THIS BY ATTEMPT. `has_table_privilege` returning false
   * is the catalogue's opinion. A refusal is the database's. Before 051 this
   * statement SUCCEEDED and took three families' wishlists with it, so this is
   * a regression test for something that actually happened, not a hypothetical.
   */
  for (const table of ["areas", "birthday_wishlist_ideas"]) {
    test(`TRUNCATE public.${table} is permission denied`, async () => {
      const result = await probe(
        db,
        { user: f.users.dual, role: "authenticated", area: f.areas.alpha },
        `truncate table public.${table}`,
      );
      assert.equal(result.ok, false, `truncating ${table} must be refused`);
      assert.match(
        result.error,
        /permission denied/iu,
        // `areas` is also referenced by foreign keys, and before 051 that was
        // the ONLY thing refusing it -- a schema accident, not a permission
        // check, and one a later change to those keys would quietly remove.
        `${table} must be refused by PRIVILEGE, not by a foreign key or anything else`,
      );
    });
  }

  test("and the rows are all still there", async () => {
    await asOwner(db);
    assert.equal(await value(db, "select count(*)::int from public.birthday_wishlist_ideas"), 3);
    assert.ok(await value(db, "select count(*)::int from public.areas") >= 3);
  });
});

// ===========================================================================
// 3. The narrowing did not take anything the application needs
// ===========================================================================

describe("the birthday person can still keep their own wishlist", () => {
  const asTaylor = (sql, params) =>
    probe(db, { user: f.users.taylor, role: "authenticated", area: f.areas.alpha }, sql, params);

  test("insert, update, select and delete all still work", async () => {
    const member = await value(db,
      `select id from public.app_members where user_id = ${literal(f.users.taylor)} and area_id = ${literal(f.areas.alpha)}`);

    const inserted = await asTaylor(
      `insert into public.birthday_wishlist_ideas
         (person_id, area_id, title, occurrence_year, created_by_app_member_id)
       values (${literal(f.people.taylor)}, ${literal(f.areas.alpha)}, 'a real wish', 2027, ${literal(member)})
       returning id`);
    assert.equal(inserted.ok, true, inserted.error);
    assert.equal(inserted.count, 1, "the insert must actually land a row");

    const read = await asTaylor("select id from public.birthday_wishlist_ideas where occurrence_year = 2027");
    assert.equal(read.count, 1);

    const updated = await asTaylor(
      "update public.birthday_wishlist_ideas set title = 'edited' where occurrence_year = 2027 returning id");
    assert.equal(updated.count, 1, "the update must reach the row");

    const deleted = await asTaylor(
      "delete from public.birthday_wishlist_ideas where occurrence_year = 2027 returning id");
    assert.equal(deleted.count, 1, "the delete must reach the row");
  });

  test("and reading an Area still works", async () => {
    const result = await probe(db, { user: f.users.dual, role: "authenticated", area: f.areas.alpha },
      "select id from public.areas");
    assert.equal(result.ok, true, result.error);
    assert.ok(result.count >= 1, "a member must still see the Areas they belong to");
  });
});

// ===========================================================================
// 4. THE GENERAL RULE -- what stops the next table arriving broken
// ===========================================================================

describe("no table in public hands a browser role more than the four DML verbs", () => {
  test("every table, every browser role", async () => {
    const offenders = await rows(db, `
      select c.relname, a.grantee::regrole::text as role, a.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      where n.nspname = 'public'
        and c.relkind in ('r', 'v')
        and a.grantee::regrole::text in ('anon', 'authenticated')
        and a.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      order by 1, 2, 3`);

    assert.deepEqual(
      offenders.map((o) => `${o.relname}.${o.role}=${o.privilege_type}`),
      [],
      "a browser role has been handed TRUNCATE, REFERENCES, TRIGGER or MAINTAIN -- " +
      "almost certainly a migration that granted without revoking Supabase's default first",
    );
  });

  test("and every table still has row level security switched on", async () => {
    const unguarded = await rows(db, `
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      order by 1`);
    assert.deepEqual(unguarded.map((r) => r.relname), []);
  });
});

// ===========================================================================
// 5. The three routines migration 051 dropped
// ===========================================================================

describe("the superseded routines are gone and their replacements are not", () => {
  test("all three are absent from the schema", async () => {
    for (const signature of [
      "public.is_family_contributor_member()",
      "public.save_christmas_recipient(uuid, uuid, text, integer)",
      "public.save_recipient_contributions(uuid, jsonb)",
    ]) {
      assert.equal(
        await value(db, `select to_regprocedure(${literal(signature)}) is null`),
        true,
        `${signature} should have been dropped by 051`,
      );
    }
  });

  test("and no browser session can call them by name any more", async () => {
    // The one that mattered: `is_family_contributor_member` was the only
    // orphaned routine still reachable over PostgREST by `authenticated`.
    const result = await probe(db, { user: f.users.dual, role: "authenticated", area: f.areas.alpha },
      "select public.is_family_contributor_member()");
    assert.equal(result.ok, false);
    assert.match(result.error, /does not exist/iu);
  });

  test("what replaced them still answers", async () => {
    for (const signature of [
      "public.is_area_contributor_member(uuid)",
      "public.save_christmas_recipient_with_contributions(uuid, uuid, text, integer, jsonb)",
      // Not redundant, and easy to sweep up by mistake: save_purchase IS still
      // called, by save_purchase_with_location.
      "public.save_purchase(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb)",
    ]) {
      assert.equal(
        await value(db, `select to_regprocedure(${literal(signature)}) is not null`),
        true,
        `${signature} must still exist`,
      );
    }
  });

  test("a contributor question still gets an Area-aware answer", async () => {
    // The behaviour the dropped wrapper used to delegate: Jade is a contributor
    // in Alpha and an ordinary member in Bravo.
    const inAlpha = await probe(db, { user: f.users.jade, role: "authenticated", area: f.areas.alpha },
      `select public.is_area_contributor_member(${literal(f.areas.alpha)}) as answer`);
    const inBravo = await probe(db, { user: f.users.jade, role: "authenticated", area: f.areas.bravo },
      `select public.is_area_contributor_member(${literal(f.areas.bravo)}) as answer`);
    assert.equal(inAlpha.rows[0].answer, true, "a contributor in Alpha");
    assert.equal(inBravo.rows[0].answer, false, "and not one in Bravo");
  });
});
