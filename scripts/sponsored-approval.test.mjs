/**
 * MIGRATION 054, RUN RATHER THAN READ.
 *
 * THE PRODUCT RULE, IN ONE LINE:
 *
 *     FAMILY ADMIN INVITES  +  INVITEE ACCEPTS  =  approved Gift Planner account
 *
 * and nothing else does. Everything below runs on PGlite carrying migrations
 * 001-054, with real roles, real `SET ROLE`, real row level security and the
 * real PostgREST pre-request hook. No authorization is mocked anywhere in this
 * file: when a test says an account is refused, that is PostgreSQL refusing.
 *
 * THE TWO LOAD-BEARING TESTS are "a pending account is approved by accepting"
 * and "a rejected account cannot launder itself through an invitation". The
 * first is the feature; the second is the thing that must never break while the
 * first exists.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";

import { asOwner, buildRehearsal, probe, probeValue, rows, value } from "./pg/rehearsal.mjs";
import { buildTwoFamilies, setAccountStatus } from "./pg/fixtures.mjs";

const who = (user, area) => ({ user, role: "authenticated", area });
const call = (db, actor, sql, params) => probe(db, actor, sql, params);

/** A confirmed Auth account. `status: null` leaves NO app_accounts row at all. */
async function makeAccount(db, email, { confirmed = true, status = null } = {}) {
  await asOwner(db);
  const id = await value(
    db,
    `insert into auth.users (email, email_confirmed_at)
     values ($1, ${confirmed ? "now()" : "null"}) returning id`,
    [email],
  );
  if (status) await setAccountStatus(db, id, status);
  return id;
}

async function newPerson(db, admin, area, name) {
  const created = await call(db, who(admin, area), "select public.create_person($1, null, null, null)", [name]);
  if (!created.ok) throw new Error(`create_person(${name}): ${created.error}`);
  await asOwner(db);
  return value(db, "select id from public.people where area_id = $1 and name = $2", [area, name]);
}

const invite = (db, admin, area, personId, email) =>
  call(db, who(admin, area), "select public.grant_area_access($1, $2)", [personId, email]);

async function openInvitation(db, email) {
  const [row] = await rows(db,
    "select id, area_id, user_id, active, declined_at from public.app_members where lower(email) = $1", [email]);
  return row;
}

async function account(db, userId) {
  const [row] = await rows(db, "select * from public.app_accounts where user_id = $1", [userId]);
  return row ?? null;
}

/** What `my_account_status()` reports, which is what the runtime believes. */
async function statusOf(db, userId) {
  const seen = await probe(db, who(userId, null), "select * from public.my_account_status()");
  return seen.ok && seen.rows?.length ? seen.rows[0].status : null;
}

/** One whole sponsorship: seat a fresh person, invite, then accept. */
async function sponsor(db, f, email, options = {}) {
  const person = await newPerson(db, f.users.bravoadmin, f.areas.bravo, options.person ?? `P${Math.random().toString(36).slice(2, 8)}`);
  const granted = await invite(db, f.users.bravoadmin, f.areas.bravo, person, email);
  assert.ok(granted.ok, `grant_area_access: ${granted.error ?? ""}`);
  const seat = await openInvitation(db, email);
  return { person, seat };
}

// ===========================================================================

describe("migration 054, on a database that carries it", () => {
  let db;
  let f;

  before(async () => {
    db = await buildRehearsal({});
    f = await buildTwoFamilies(db);
  });

  after(async () => { await db?.close(); });

  // -------------------------------------------------------------------------
  // 1. THE ONE THAT MATTERS MOST
  // -------------------------------------------------------------------------

  describe("a brand-new invited account is approved by accepting", () => {
    let subject;

    test("before Accept it is pending, with no app_accounts row at all", async () => {
      const email = "sponsored@example.test";
      const user = await makeAccount(db, email);
      const { seat } = await sponsor(db, f, email);
      subject = { user, email, seat };

      assert.equal(await account(db, user), null, "a brand-new account has no row");
      assert.equal(await statusOf(db, user), "pending", "and reports pending, which is 052's rule");
      assert.equal(seat.user_id, null, "the seat is an invitation, not a membership");
      assert.equal(
        Number(await value(db, "select count(*) from public.app_members where user_id = $1", [user])),
        0,
      );
    });

    test("it can reach no Area data while it waits", async () => {
      const seen = await probe(db, who(subject.user, subject.seat.area_id),
        "select count(*)::int as n from public.people");
      assert.ok(!seen.ok || Number(seen.rows?.[0]?.n ?? 0) === 0,
        "a pending account must read no people");
    });

    test("ACCEPTING APPROVES THE ACCOUNT, and it is the accept that does it", async () => {
      const accepted = await probeValue(db, who(subject.user, null),
        "select public.accept_family_invitation($1)", [subject.seat.id]);
      assert.ok(accepted.ok, accepted.error ?? "");
      assert.equal(accepted.value, subject.seat.area_id, "it returns the family joined");

      const row = await account(db, subject.user);
      assert.ok(row, "a canonical app_accounts row now exists");
      assert.equal(row.status, "approved");
      assert.equal(row.is_global_admin, false, "sponsorship grants no administration");
      assert.equal(row.decided_by, null, "no human took this decision at this moment");
      assert.equal(row.decision_note, "Approved by family invitation sponsorship");
      assert.equal(await statusOf(db, subject.user), "approved");
    });

    test("and the seat is claimed in place, with no second membership", async () => {
      const seat = await openInvitation(db, subject.email);
      assert.equal(seat.id, subject.seat.id, "the same row");
      assert.equal(seat.user_id, subject.user);
      assert.equal(seat.declined_at, null);
      assert.equal(
        Number(await value(db, "select count(*) from public.app_members where user_id = $1", [subject.user])),
        1,
      );
    });

    test("THE INVITED FAMILY IS USABLE IMMEDIATELY, with no second approval", async () => {
      const seen = await probe(db, who(subject.user, subject.seat.area_id),
        "select count(*)::int as n from public.people");
      assert.ok(seen.ok, seen.error ?? "");
      assert.ok(Number(seen.rows[0].n) > 0, "the sponsored member reads their family");

      const areas = await probe(db, who(subject.user, subject.seat.area_id),
        "select id from public.areas");
      assert.ok(areas.ok);
      assert.deepEqual(areas.rows.map((r) => r.id), [subject.seat.area_id],
        "and exactly the one family they were invited to");
    });

    test("the sponsorship is auditable, in the vocabulary the log already has", async () => {
      const entries = await rows(db,
        `select action, summary, details, area_id, actor_user_id
         from public.audit_log
         where table_name = 'app_accounts' and record_id = $1`, [subject.user]);
      assert.equal(entries.length, 1, "exactly one account decision");
      const entry = entries[0];
      assert.equal(entry.action, "decided", "the same word a manual approval uses");
      assert.equal(entry.summary, "Global account set to approved");
      assert.equal(entry.details.status, "approved");
      assert.equal(entry.details.source, "family_invitation", "which is what tells the two apart");
      assert.equal(entry.details.sponsor_area_id, subject.seat.area_id, "the sponsoring family is attributable");
      assert.equal(entry.details.sponsor_app_member_id, subject.seat.id);
      assert.equal(entry.actor_user_id, subject.user, "the invitee performed it");
      assert.equal(entry.area_id, null,
        "a global decision is not a family event -- stamp_audit_area refuses an Area here");
    });

    test("AND NOTHING SECRET IS STORED", async () => {
      const [entry] = await rows(db,
        "select details::text as text from public.audit_log where table_name = 'app_accounts' and record_id = $1",
        [subject.user]);
      for (const secret of ["@", "token", "password", "http", "access_token", "refresh"]) {
        assert.ok(!entry.text.toLowerCase().includes(secret),
          `the audit must not carry ${secret}`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. THE THING THAT MUST NEVER BREAK WHILE THE ABOVE EXISTS
  // -------------------------------------------------------------------------

  describe("a decided account cannot launder itself through an invitation", () => {
    for (const status of ["rejected", "suspended"]) {
      test(`a ${status} account is refused, and stays ${status}`, async () => {
        const email = `${status}@example.test`;
        const user = await makeAccount(db, email, { status });
        const { seat } = await sponsor(db, f, email);

        const accepted = await probeValue(db, who(user, null),
          "select public.accept_family_invitation($1)", [seat.id]);
        assert.ok(!accepted.ok, "acceptance must be refused");
        assert.match(accepted.error ?? "", /cannot join a family/iu);

        const row = await account(db, user);
        assert.equal(row.status, status, "the human decision stands");
        assert.notEqual(row.decision_note, "Approved by family invitation sponsorship");

        const after = await openInvitation(db, email);
        assert.equal(after.user_id, null, "and no membership was created");
      });

      test(`and a ${status} account reads no Area data through that seat`, async () => {
        const email = `${status}@example.test`;
        const [row] = await rows(db, "select area_id from public.app_members where lower(email) = $1", [email]);
        const user = await value(db, "select id from auth.users where lower(email) = $1", [email]);
        const seen = await probe(db, who(user, row.area_id), "select count(*)::int as n from public.people");
        assert.ok(!seen.ok || Number(seen.rows?.[0]?.n ?? 0) === 0);
      });
    }

    test("only a Gift Planner administrator can reverse those states", async () => {
      const user = await value(db, "select id from auth.users where lower(email) = $1", ["rejected@example.test"]);
      const notAdmin = await probe(db, who(f.users.bravoadmin, f.areas.bravo),
        "select public.set_account_status($1, 'approved', null)", [user]);
      assert.ok(!notAdmin.ok, "a family administrator may not decide a global account");
      assert.match(notAdmin.error ?? "", /Gift Planner administrator/iu);
    });
  });

  // -------------------------------------------------------------------------
  // 3. The other three account shapes
  // -------------------------------------------------------------------------

  describe("every other starting state ends where it should", () => {
    test("AN ALREADY-PENDING PUBLIC ACCOUNT is sponsored by a later invitation", async () => {
      // Signed up publicly first -- so the row exists and says pending -- and is
      // invited afterwards. This is the "Ben invites someone who already signed
      // up" case, and it must not need a second decision either.
      const email = "waited@example.test";
      const user = await makeAccount(db, email, { status: "pending" });
      assert.equal((await account(db, user)).status, "pending", "the row exists and says pending");

      const { seat } = await sponsor(db, f, email);
      const accepted = await probeValue(db, who(user, null),
        "select public.accept_family_invitation($1)", [seat.id]);
      assert.ok(accepted.ok, accepted.error ?? "");

      const row = await account(db, user);
      assert.equal(row.status, "approved");
      assert.equal(row.decision_note, "Approved by family invitation sponsorship");

      const seen = await probe(db, who(user, seat.area_id), "select count(*)::int as n from public.people");
      assert.ok(seen.ok && Number(seen.rows[0].n) > 0, "and the family is usable at once");
    });

    test("AN ALREADY-APPROVED ACCOUNT is left exactly as it was", async () => {
      /*
       * Re-stamping `decided_at` would overwrite a real administrator's
       * decision with a machine's, and a second audit row would make the log
       * claim a decision that nobody took.
       */
      const email = "approved@example.test";
      const user = await makeAccount(db, email, { status: "approved" });
      const before = await account(db, user);

      const { seat } = await sponsor(db, f, email);
      const accepted = await probeValue(db, who(user, null),
        "select public.accept_family_invitation($1)", [seat.id]);
      assert.ok(accepted.ok, accepted.error ?? "");

      const after = await account(db, user);
      assert.equal(after.status, "approved");
      assert.deepEqual(after.decided_at, before.decided_at, "the original decision timestamp stands");
      assert.equal(after.decided_by, before.decided_by, "and so does the administrator who made it");
      assert.notEqual(after.decision_note, "Approved by family invitation sponsorship");

      // The fixture writes an approved status directly, so there is no decision
      // entry to begin with. What matters is that accepting added NONE: an
      // account that was already approved is not re-decided by a sponsorship.
      const sponsored = await rows(db,
        `select id from public.audit_log
         where table_name = 'app_accounts' and record_id = $1
           and details->>'source' = 'family_invitation'`, [user]);
      assert.equal(sponsored.length, 0, "no sponsorship decision is written over an approved account");

      const seat2 = await openInvitation(db, email);
      assert.equal(seat2.user_id, user, "and the seat is claimed normally");
    });

    test("an unconfirmed address cannot be sponsored, because it cannot accept", async () => {
      const email = "unconfirmed@example.test";
      const user = await makeAccount(db, email, { confirmed: false });
      const { seat } = await sponsor(db, f, email);
      const accepted = await probeValue(db, who(user, null),
        "select public.accept_family_invitation($1)", [seat.id]);
      assert.ok(!accepted.ok);
      assert.match(accepted.error ?? "", /Confirm your email/iu);
      assert.equal(await account(db, user), null, "and no account row was created");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Public sign-up is untouched
  // -------------------------------------------------------------------------

  describe("public sign-up still waits for a Gift Planner administrator", () => {
    let stranger;

    test("a confirmed account with no invitation is pending and reads nothing", async () => {
      stranger = await makeAccount(db, "stranger@example.test");
      assert.equal(await statusOf(db, stranger), "pending");
      const seen = await probe(db, who(stranger, f.areas.bravo), "select count(*)::int as n from public.people");
      assert.ok(!seen.ok || Number(seen.rows?.[0]?.n ?? 0) === 0);
    });

    test("NOTHING IT CAN CALL APPROVES IT", async () => {
      // There is no invitation for it, so the only routine that could sponsor
      // anybody has nothing to select -- and a guessed id changes nothing.
      const guessed = await probeValue(db, who(stranger, null),
        "select public.accept_family_invitation('11111111-1111-4111-8111-111111111111'::uuid)");
      assert.ok(!guessed.ok);
      assert.match(guessed.error ?? "", /not yours/iu);
      assert.equal(await statusOf(db, stranger), "pending", "still waiting");
      assert.equal(await account(db, stranger), null, "and still no row");
    });

    test("and a family administrator of an unrelated Area cannot approve it", async () => {
      const refused = await probe(db, who(f.users.bravoadmin, f.areas.bravo),
        "select public.set_account_status($1, 'approved', null)", [stranger]);
      assert.ok(!refused.ok);
      assert.match(refused.error ?? "", /Gift Planner administrator/iu);
      assert.equal(await statusOf(db, stranger), "pending");
    });

    test("nor can they read the platform-wide queue", async () => {
      const queue = await probe(db, who(f.users.bravoadmin, f.areas.bravo),
        "select * from public.list_accounts(null)");
      assert.ok(!queue.ok, "list_accounts is global administrators only");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Authority boundaries
  // -------------------------------------------------------------------------

  describe("the client chooses which invitation, and nothing else", () => {
    test("THE CONTRACT HAS NO PARAMETER FOR AN IDENTITY, AN AREA OR A STATUS", async () => {
      const args = await value(db,
        `select pg_get_function_arguments(oid) from pg_proc
         where proname = 'accept_family_invitation' and pronamespace = 'public'::regnamespace`);
      assert.equal(args, "p_invitation_id uuid", "one argument, and it is the seat");
    });

    test("a guessed invitation id cannot approve the wrong account", async () => {
      const victim = await makeAccount(db, "victim@example.test");
      const { seat } = await sponsor(db, f, "victim@example.test");

      // A different confirmed account, holding the real invitation id.
      const thief = await makeAccount(db, "thief@example.test");
      const stolen = await probeValue(db, who(thief, null),
        "select public.accept_family_invitation($1)", [seat.id]);
      assert.ok(!stolen.ok, "the address authorizes, not the id");
      assert.match(stolen.error ?? "", /not yours/iu);

      assert.equal(await account(db, thief), null, "the thief was not approved");
      assert.equal(await statusOf(db, thief), "pending");
      assert.equal((await openInvitation(db, "victim@example.test")).user_id, null,
        "and the victim's invitation is untouched");
      assert.equal(await account(db, victim), null, "nor was the victim approved by somebody else's attempt");
    });

    test("an ordinary member cannot manufacture a sponsorship", async () => {
      // They are not their Area's administrator, so they cannot issue the
      // invitation that a sponsorship is made of.
      const target = await newPerson(db, f.users.bravoadmin, f.areas.bravo, "Nobody");
      const refused = await call(db, who(f.users.sam, f.areas.bravo),
        "select public.grant_area_access($1, $2)", [target, "member-made@example.test"]);
      assert.ok(!refused.ok, "an ordinary member may not issue an invitation");
      assert.match(refused.error ?? "", /administrator can give access/iu);
    });

    test("AN INVITATION INTO ONE FAMILY SPONSORS ACCESS TO THAT FAMILY ONLY", async () => {
      const email = "onefamily@example.test";
      const user = await makeAccount(db, email);
      const { seat } = await sponsor(db, f, email);
      const accepted = await probeValue(db, who(user, null),
        "select public.accept_family_invitation($1)", [seat.id]);
      assert.ok(accepted.ok, accepted.error ?? "");

      // Approved globally -- and still a stranger to the other family.
      assert.equal(await statusOf(db, user), "approved");
      /*
       * ASKED ABOUT ALPHA'S ROWS SPECIFICALLY, not about whatever the acting
       * Area resolved to. `claim_active_area` ignores an Area the caller is not
       * in and falls back to the one they are, so an unfiltered count would
       * come back non-zero from BRAVO and prove nothing.
       */
      const other = await probe(db, who(user, f.areas.alpha),
        "select count(*)::int as n from public.people where area_id = $1", [f.areas.alpha]);
      assert.ok(!other.ok || Number(other.rows?.[0]?.n ?? 0) === 0,
        "global approval must not open an Area they were never invited to");

      const areas = await probe(db, who(user, seat.area_id), "select id from public.areas");
      assert.deepEqual(areas.rows.map((r) => r.id), [seat.area_id]);
    });

    test("and a family administrator cannot invite into another family", async () => {
      const alphaPerson = await newPerson(db, f.users.dual, f.areas.alpha, "AlphaOnly");
      const crossed = await call(db, who(f.users.bravoadmin, f.areas.bravo),
        "select public.grant_area_access($1, $2)", [alphaPerson, "crossed@example.test"]);
      assert.ok(!crossed.ok, "the Area comes from the person, and the acting Area must match");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Durability
  // -------------------------------------------------------------------------

  describe("sponsored approval is durable", () => {
    test("LOSING THE SPONSORING MEMBERSHIP DOES NOT UNAPPROVE THE ACCOUNT", async () => {
      const email = "durable@example.test";
      const user = await makeAccount(db, email);
      const { person, seat } = await sponsor(db, f, email);
      assert.ok((await probeValue(db, who(user, null),
        "select public.accept_family_invitation($1)", [seat.id])).ok);
      assert.equal(await statusOf(db, user), "approved");

      // The family takes the access away again.
      const revoked = await call(db, who(f.users.bravoadmin, f.areas.bravo),
        "select public.revoke_area_access($1, true)", [person]);
      assert.ok(revoked.ok, revoked.error ?? "");

      assert.equal(await statusOf(db, user), "approved",
        "losing a family is not losing an account");
      assert.equal((await account(db, user)).status, "approved");
      assert.equal(
        Number(await value(db,
          "select count(*) from public.app_members where user_id = $1 and active = true", [user])),
        0,
        "and they are left in the zero-family state, which is legitimate",
      );
    });

    test("no automatic suspension or rejection happens anywhere", async () => {
      const decided = await rows(db,
        `select details->>'status' as status from public.audit_log
         where table_name = 'app_accounts' and details->>'source' = 'family_invitation'`);
      assert.ok(decided.length > 0, "sponsorships happened");
      for (const row of decided) {
        assert.equal(row.status, "approved", "sponsorship only ever approves");
      }
    });
  });

  // -------------------------------------------------------------------------
  // 7. The migration's own guarantees
  // -------------------------------------------------------------------------

  describe("what 054 did and did not change", () => {
    test("it is still a pinned SECURITY DEFINER, like every routine around it", async () => {
      const [row] = await rows(db,
        `select p.prosecdef, p.proconfig from pg_proc p
         where p.proname = 'accept_family_invitation' and p.pronamespace = 'public'::regnamespace`);
      assert.equal(row.prosecdef, true);
      // Text, not array containment: PostgreSQL's stored quoting of the empty
      // search path is a detail this has no business depending on.
      assert.match((row.proconfig ?? []).join(","), /search_path=/u);
    });

    test("DECLINING IS UNTOUCHED, and still approves nobody", async () => {
      const email = "declines@example.test";
      const user = await makeAccount(db, email);
      const { seat } = await sponsor(db, f, email);

      const declined = await probe(db, who(user, null),
        "select public.decline_family_invitation($1)", [seat.id]);
      assert.ok(declined.ok, declined.error ?? "");

      assert.equal(await statusOf(db, user), "pending", "saying no sponsors nothing");
      assert.equal(await account(db, user), null);
      const after = await openInvitation(db, email);
      assert.equal(after.user_id, null, "and creates no membership");
      assert.ok(after.declined_at);
    });

    test("issuing an invitation alone approves nobody", async () => {
      // The other half of the consent rule: the family administrator's act is
      // necessary and not sufficient.
      const email = "invited-only@example.test";
      const user = await makeAccount(db, email);
      await sponsor(db, f, email);
      assert.equal(await statusOf(db, user), "pending");
      assert.equal(await account(db, user), null);
    });

    test("and confirming an email address alone approves nobody", async () => {
      // `claim_app_member()` is still 053's no-op; nothing about signing in
      // touches the global decision.
      const email = "confirmed-only@example.test";
      const user = await makeAccount(db, email);
      await sponsor(db, f, email);
      const claimed = await probeValue(db, who(user, null), "select public.claim_app_member()");
      assert.equal(claimed.value, false);
      assert.equal(await statusOf(db, user), "pending");
    });
  });
});
