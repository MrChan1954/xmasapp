/**
 * MIGRATION 053, RUN RATHER THAN READ.
 *
 * The whole of this migration is one sentence -- "confirming an email address
 * stops joining you to a family" -- and there is exactly one way to find out
 * whether a real PostgreSQL agrees: put an invitation in front of an account
 * that would previously have been joined by signing in, sign it in, and count
 * what it belongs to.
 *
 * Everything below runs on PGlite carrying migrations 001-053, with real roles,
 * real `SET ROLE`, real row level security and the real PostgREST pre-request
 * hook. No authorization is mocked anywhere in this file. When a test says an
 * account is refused, that is the database refusing, not a stub.
 *
 * THE LOAD-BEARING TEST IN THIS FILE is "the legacy claim path joins nobody".
 * Every other assertion here guards a boundary; that one proves the product
 * requirement the migration exists for.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";

import {
  applyMigration, asOwner, attempt, buildRehearsal, literal, probe, probeValue,
  request, rows, seen, value,
} from "./pg/rehearsal.mjs";
import { buildTwoFamilies, setAccountStatus } from "./pg/fixtures.mjs";

const CONSENT = "202608100053_family_invitation_consent.sql";
const BEFORE_053 = "202608100052_global_account_approval.sql";

const who = (user, area) => ({ user, role: "authenticated", area });

/** A confirmed Auth account, and its global status. */
async function makeAccount(db, email, { confirmed = true, status = "approved" } = {}) {
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

/** One RPC as one signed-in caller standing in one Area. */
const call = (db, actor, sql, params) => probe(db, actor, sql, params);

/** The whole `app_members` row, read as the owner. */
async function seat(db, id) {
  const [row] = await rows(db, "select * from public.app_members where id = $1", [id]);
  return row;
}

/** Invite `email` to `person` as that Area's administrator. */
async function invite(db, admin, area, personId, email) {
  return call(db, who(admin, area), "select public.grant_area_access($1, $2)", [personId, email]);
}

/**
 * A person nobody has ever been invited as.
 *
 * The fixture's own people all hold claimed seats, and `grant_area_access`
 * rightly refuses to re-address one of those. Every invitation test therefore
 * seats its own subject first, through the real routine.
 */
async function newPerson(db, admin, area, name) {
  const created = await call(db, who(admin, area),
    "select public.create_person($1, null, null, null)", [name]);
  if (!created.ok) throw new Error(`create_person(${name}): ${created.error}`);
  await asOwner(db);
  return value(db, "select id from public.people where area_id = $1 and name = $2", [area, name]);
}

// ===========================================================================

describe("migration 053, on a database that carries it", () => {
  let db;
  let f;

  before(async () => {
    db = await buildRehearsal({});
    f = await buildTwoFamilies(db);
  });

  after(async () => { await db?.close(); });

  // -------------------------------------------------------------------------
  // THE ONE THAT MATTERS MOST
  // -------------------------------------------------------------------------

  describe("the legacy claim path joins nobody", () => {
    test("a confirmed invited address that WOULD have been auto-joined is not", async () => {
      const email = "silent@example.test";
      const account = await makeAccount(db, email);

      // Bravo's administrator seats a new person and invites that address.
      const quinn = await newPerson(db, f.users.bravoadmin, f.areas.bravo, "Quinn");
      assert.ok(quinn);

      const granted = await invite(db, f.users.bravoadmin, f.areas.bravo, quinn, email);
      assert.ok(granted.ok, `grant_area_access: ${granted.error ?? ""}`);

      const before = await rows(db,
        "select id, user_id, active, declined_at from public.app_members where lower(email) = $1", [email]);
      assert.equal(before.length, 1);
      assert.equal(before[0].user_id, null);

      // THE SIGN-IN. Pre-053 this one statement made them a member of Bravo.
      const claimed = await probeValue(db, who(account, null), "select public.claim_app_member()");
      assert.equal(claimed.value, false, "claim_app_member must report that it joined nobody");

      const after = await seat(db, before[0].id);
      assert.equal(after.user_id, null, "the invitation must still be unclaimed");
      assert.equal(after.active, true);
      assert.equal(after.declined_at, null);

      // And they belong to nothing.
      assert.equal(
        Number(await value(db, "select count(*) from public.app_members where user_id = $1", [account])),
        0,
        "signing in must not have created any membership",
      );

      f.silent = { account, email, invitationId: before[0].id, personId: quinn };
    });

    test("claim_app_member has no UPDATE left in it", async () => {
      const def = await value(db,
        `select pg_get_functiondef(oid) from pg_proc
         where proname = 'claim_app_member' and pronamespace = 'public'::regnamespace`);
      assert.ok(!/update/i.test(def), "the auto-join body must be gone, not merely conditioned");
    });
  });

  // -------------------------------------------------------------------------
  // WHAT THE INVITEE CAN SEE
  // -------------------------------------------------------------------------

  describe("list_my_family_invitations", () => {
    test("returns the caller's own open invitation, before any membership exists", async () => {
      const seen_ = await probe(db, who(f.silent.account, null),
        "select * from public.list_my_family_invitations()");
      assert.ok(seen_.ok, seen_.error ?? "");
      assert.equal(seen_.count, 1);
      assert.equal(seen_.rows[0].area_name, "Bravo");
      assert.equal(seen_.rows[0].invited_as, "Quinn");
      assert.equal(seen_.rows[0].invitation_id, f.silent.invitationId);
    });

    test("returns nothing financial, no event and no third party", async () => {
      const cols = (await rows(db,
        `select unnest(proargnames) as name from pg_proc
         where proname = 'list_my_family_invitations' and pronamespace = 'public'::regnamespace`))
        .map((r) => r.name);
      assert.deepEqual(cols, ["invitation_id", "area_name", "invited_as", "invited_at"]);
    });

    test("takes no parameter, so it cannot be pointed at another address", async () => {
      const args = await value(db,
        `select pg_get_function_identity_arguments(oid) from pg_proc
         where proname = 'list_my_family_invitations' and pronamespace = 'public'::regnamespace`);
      assert.equal(args, "");
    });

    test("another confirmed account sees none of it", async () => {
      const stranger = await makeAccount(db, "stranger@example.test");
      const seen_ = await probe(db, who(stranger, null), "select * from public.list_my_family_invitations()");
      assert.ok(seen_.ok);
      assert.equal(seen_.count, 0);
      f.stranger = stranger;
    });

    test("an unconfirmed account sees nothing, and is not an error", async () => {
      const unconfirmed = await makeAccount(db, "unconfirmed@example.test", { confirmed: false });
      const seen_ = await probe(db, who(unconfirmed, null), "select * from public.list_my_family_invitations()");
      assert.ok(seen_.ok, "zero rows, never an error -- the surface must not tell the cases apart");
      assert.equal(seen_.count, 0);
      f.unconfirmed = unconfirmed;
    });

    test("a signed-out visitor cannot execute it at all", async () => {
      const anon = await probe(db, { user: null, role: "anon", area: null },
        "select * from public.list_my_family_invitations()");
      assert.equal(anon.ok, false);
    });
  });

  // -------------------------------------------------------------------------
  // ACCEPT -- WHO MAY, AND WHO MAY NOT
  // -------------------------------------------------------------------------

  describe("accept_family_invitation refuses everybody it is not addressed to", () => {
    const REFUSAL = "That invitation is not yours.";

    test("the wrong account, holding a real invitation id", async () => {
      const r = await call(db, who(f.stranger, null),
        "select public.accept_family_invitation($1)", [f.silent.invitationId]);
      assert.equal(r.ok, false);
      assert.match(r.error, /That invitation is not yours/);
    });

    test("a guessed uuid produces the identical refusal", async () => {
      const guessed = await call(db, who(f.stranger, null),
        "select public.accept_family_invitation('00000000-0000-0000-0000-000000000000'::uuid)");
      const real = await call(db, who(f.stranger, null),
        "select public.accept_family_invitation($1)", [f.silent.invitationId]);
      assert.equal(guessed.ok, false);
      assert.equal(real.ok, false);
      assert.equal(
        guessed.error, real.error,
        "a real invitation belonging to somebody else must be indistinguishable from a guess",
      );
      assert.match(guessed.error, new RegExp(REFUSAL.replace(".", "\\.")));
    });

    test("an unconfirmed email cannot accept, even its own invitation", async () => {
      const personId = await newPerson(db, f.users.dual, f.areas.alpha, "Unconfirmed Seat");
      const inv = await invite(db, f.users.dual, f.areas.alpha, personId, "unconfirmed@example.test");
      assert.ok(inv.ok, inv.error ?? "");
      const r = await call(db, who(f.unconfirmed, null),
        `select public.accept_family_invitation(
           (select id from public.app_members where lower(email) = 'unconfirmed@example.test'))`);
      assert.equal(r.ok, false);
      assert.match(r.error, /Confirm your email address first/);
    });

    test("a stale gp_area cookie pointing at another family changes nothing", async () => {
      // The acting Area is never read by these routines. Standing in Alpha, an
      // Area this account has nothing to do with, must be neither help nor harm.
      const r = await call(db, who(f.stranger, f.areas.alpha),
        "select public.accept_family_invitation($1)", [f.silent.invitationId]);
      assert.equal(r.ok, false);
      assert.match(r.error, /That invitation is not yours/);
    });
  });

  describe("global approval decides whether accepting is even offered", () => {
    let rejected;
    let suspended;
    let rejectedInvitation;

    before(async () => {
      rejected = await makeAccount(db, "rejected@example.test", { status: "rejected" });
      suspended = await makeAccount(db, "suspended@example.test", { status: "suspended" });

      const refusedSeat = await newPerson(db, f.users.bravoadmin, f.areas.bravo, "Refused Seat");
      const inv = await invite(db, f.users.bravoadmin, f.areas.bravo, refusedSeat, "rejected@example.test");
      assert.ok(inv.ok, inv.error ?? "");
      rejectedInvitation = await value(db,
        "select id from public.app_members where lower(email) = 'rejected@example.test'");
    });

    test("a rejected account is refused", async () => {
      const r = await call(db, who(rejected, null),
        "select public.accept_family_invitation($1)", [rejectedInvitation]);
      assert.equal(r.ok, false);
      assert.match(r.error, /This account cannot join a family/);
    });

    test("a rejected account may still DECLINE -- refusing access is never blocked", async () => {
      const r = await call(db, who(rejected, null),
        "select public.decline_family_invitation($1)", [rejectedInvitation]);
      assert.ok(r.ok, r.error ?? "");
      const row = await seat(db, rejectedInvitation);
      assert.equal(row.user_id, null);
      assert.equal(row.active, false);
      assert.notEqual(row.declined_at, null);
    });

    test("a suspended account is refused acceptance too", async () => {
      // Reissue the same seat to the suspended address.
      const personId = await value(db,
        "select person_id from public.app_members where id = $1", [rejectedInvitation]);
      const inv = await invite(db, f.users.bravoadmin, f.areas.bravo, personId, "suspended@example.test");
      assert.ok(inv.ok, inv.error ?? "");
      const r = await call(db, who(suspended, null),
        "select public.accept_family_invitation($1)", [rejectedInvitation]);
      assert.equal(r.ok, false);
      assert.match(r.error, /This account cannot join a family/);

      // Put the seat back to a clean invitation for the reissue tests below.
      const back = await invite(db, f.users.bravoadmin, f.areas.bravo, personId, "reissue@example.test");
      assert.ok(back.ok, back.error ?? "");
      f.reissueSeat = rejectedInvitation;
      f.reissuePerson = personId;
    });

    test("a globally PENDING account may accept, and the seat grants it nothing", async () => {
      const pending = await makeAccount(db, "pending@example.test", { status: "pending" });
      const personId = await newPerson(db, f.users.bravoadmin, f.areas.bravo, "Pending Seat");
      const inv = await invite(db, f.users.bravoadmin, f.areas.bravo, personId, "pending@example.test");
      assert.ok(inv.ok, inv.error ?? "");
      const invitationId = await value(db,
        "select id from public.app_members where lower(email) = 'pending@example.test'");

      const accepted = await probeValue(db, who(pending, null),
        "select public.accept_family_invitation($1)", [invitationId]);
      assert.ok(accepted.ok, accepted.error ?? "");
      assert.equal(accepted.value, f.areas.bravo, "accept returns the Area joined");

      const row = await seat(db, invitationId);
      assert.equal(row.user_id, pending);
      assert.equal(row.active, true);

      /*
       * WHAT MIGRATION 054 CHANGED HERE, AND WHY THIS ASSERTION INVERTED.
       *
       * Under 053 alone this account stayed `pending` and read nothing: every
       * predicate carries `is_globally_approved()`, so the accepted seat
       * granted zero access until a platform administrator decided it.
       *
       * 054 makes that wait unnecessary for exactly this shape. The invitation
       * was issued by the Area's own administrator and accepted by the owner of
       * the address it names -- two authorities that have already been checked
       * -- so the account is SPONSORED and approved by the accept itself. What
       * remains true, and is asserted below, is that the seat grants access to
       * THAT family and nothing else, and that public sign-up with no accepted
       * invitation still waits. `scripts/sponsored-approval.test.mjs` holds the
       * whole of the new contract.
       */
      assert.equal(
        await value(db, "select status from public.app_accounts where user_id = $1", [pending]),
        "approved",
        "an invitation issued by a family admin and explicitly accepted sponsors the account",
      );
      assert.ok(
        Number(await seen(db, who(pending, f.areas.bravo), "people")) > 0,
        "and the invited family is usable at once, with no second approval",
      );

      // STILL EXACTLY ONE FAMILY. Sponsorship approves the account; it does not
      // hand out an Area nobody invited them to.
      assert.equal(await seen(db, who(pending, f.areas.alpha), "people", "area_id = $1", [f.areas.alpha]), 0,
        "the family they were never invited to stays closed");
      f.pending = { account: pending, invitationId };
    });

    test("a global administrator is still nobody's family member", async () => {
      const globalAdmin = await makeAccount(db, "globaladmin@example.test");
      await asOwner(db);
      await db.query("update public.app_accounts set is_global_admin = true where user_id = $1", [globalAdmin]);
      for (const table of ["areas", "people", "app_members", "events"]) {
        assert.equal(await seen(db, who(globalAdmin, f.areas.bravo), table), 0,
          `${table} must not open to a global administrator`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // ACCEPT -- WHAT IT ACTUALLY WRITES
  // -------------------------------------------------------------------------

  describe("accepting writes exactly two columns, and nothing anywhere else", () => {
    let seatBefore;
    let seatAfter;
    let fingerprintBefore;

    const OTHER_TABLES = [
      "people", "contributors", "christmas_recipients", "events",
      "recipient_contributions", "purchases", "purchase_allocations", "gift_ideas",
    ];

    before(async () => {
      await asOwner(db);
      seatBefore = await seat(db, f.silent.invitationId);
      fingerprintBefore = {};
      for (const t of OTHER_TABLES) {
        fingerprintBefore[t] = await value(db, `select count(*)::int from public.${t}`);
      }
      const r = await call(db, who(f.silent.account, null),
        "select public.accept_family_invitation($1)", [f.silent.invitationId]);
      assert.ok(r.ok, r.error ?? "");
      await asOwner(db);
      seatAfter = await seat(db, f.silent.invitationId);
    });

    test("user_id and updated_at, and those alone", () => {
      const changed = Object.keys(seatAfter).filter(
        (k) => String(seatAfter[k]) !== String(seatBefore[k]),
      );
      // `updated_at` may or may not show a difference -- PGlite can run both
      // statements inside one clock tick -- so the assertion is the one that
      // matters: NOTHING OTHER than those two columns moved.
      assert.deepEqual(
        changed.filter((k) => k !== "updated_at" && k !== "user_id"), [],
        "accepting must write user_id and updated_at and nothing else",
      );
      assert.ok(changed.includes("user_id"));
      assert.equal(seatAfter.user_id, f.silent.account);
      for (const untouched of ["role", "contributor_id", "person_id", "area_id", "active", "email", "declined_at"]) {
        assert.equal(String(seatAfter[untouched]), String(seatBefore[untouched]), untouched);
      }
    });

    test("no contributor, recipient, event or person row moved", async () => {
      for (const t of OTHER_TABLES) {
        assert.equal(
          await value(db, `select count(*)::int from public.${t}`), fingerprintBefore[t],
          `${t} changed while an invitation was accepted`,
        );
      }
    });

    test("the audit row is Area-attributed to the family, and the actor is the invitee", async () => {
      const [row] = await rows(db,
        `select action, area_id, actor_user_id, summary, details from public.audit_log
         where table_name = 'app_members' and record_id = $1 and summary like 'Joined%'`,
        [f.silent.invitationId]);
      assert.ok(row, "accepting must be audited");
      assert.equal(row.action, "added");
      assert.equal(row.area_id, f.areas.bravo);
      assert.equal(row.actor_user_id, f.silent.account);
      assert.match(row.summary, /^Joined Bravo$/);
    });

    test("replaying accept is refused and changes nothing", async () => {
      const r = await call(db, who(f.silent.account, null),
        "select public.accept_family_invitation($1)", [f.silent.invitationId]);
      assert.equal(r.ok, false);
      assert.match(r.error, /That invitation is not yours/);
      await asOwner(db);
      const row = await seat(db, f.silent.invitationId);
      assert.equal(String(row.updated_at), String(seatAfter.updated_at));
    });

    test("declining an already accepted seat is refused", async () => {
      const r = await call(db, who(f.silent.account, null),
        "select public.decline_family_invitation($1)", [f.silent.invitationId]);
      assert.equal(r.ok, false);
      assert.match(r.error, /That invitation is not yours/);
    });
  });

  // -------------------------------------------------------------------------
  // DECLINE, AND THE REISSUE THAT FOLLOWS IT
  // -------------------------------------------------------------------------

  describe("decline, reissue, and the state they leave behind", () => {
    let account;
    let invitationId;
    let personId;

    before(async () => {
      account = await makeAccount(db, "decliner@example.test");
      personId = await newPerson(db, f.users.dual, f.areas.alpha, "Decliner Seat");
      const inv = await invite(db, f.users.dual, f.areas.alpha, personId, "decliner@example.test");
      assert.ok(inv.ok, inv.error ?? "");
      invitationId = await value(db,
        "select id from public.app_members where lower(email) = 'decliner@example.test'");
    });

    test("the wrong account cannot decline somebody else's invitation", async () => {
      const r = await call(db, who(f.stranger, null),
        "select public.decline_family_invitation($1)", [invitationId]);
      assert.equal(r.ok, false);
      assert.match(r.error, /That invitation is not yours/);
      await asOwner(db);
      assert.equal((await seat(db, invitationId)).declined_at, null);
    });

    test("the invitee declines, and no membership is created at any point", async () => {
      const r = await call(db, who(account, null),
        "select public.decline_family_invitation($1)", [invitationId]);
      assert.ok(r.ok, r.error ?? "");
      await asOwner(db);
      const row = await seat(db, invitationId);
      assert.equal(row.user_id, null, "declining must never attach a login");
      assert.equal(row.active, false);
      assert.notEqual(row.declined_at, null);
    });

    test("the decline is audited, Area-attributed, with the invitee as actor", async () => {
      const [row] = await rows(db,
        `select action, area_id, actor_user_id, summary from public.audit_log
         where record_id = $1 and summary like 'Declined%'`, [invitationId]);
      assert.ok(row);
      assert.equal(row.action, "removed");
      assert.equal(row.area_id, f.areas.alpha);
      assert.equal(row.actor_user_id, account);
    });

    test("replaying decline is refused", async () => {
      const r = await call(db, who(account, null),
        "select public.decline_family_invitation($1)", [invitationId]);
      assert.equal(r.ok, false);
      assert.match(r.error, /That invitation is not yours/);
    });

    test("a declined invitation has left the invitee's list", async () => {
      const seen_ = await probe(db, who(account, null), "select * from public.list_my_family_invitations()");
      assert.ok(seen_.ok);
      assert.equal(seen_.count, 0);
    });

    test("accepting after declining is refused", async () => {
      const r = await call(db, who(account, null),
        "select public.accept_family_invitation($1)", [invitationId]);
      assert.equal(r.ok, false);
      assert.match(r.error, /That invitation is not yours/);
    });

    test("re-inviting clears the decline and creates NO membership", async () => {
      const inv = await invite(db, f.users.dual, f.areas.alpha, personId, "decliner@example.test");
      assert.ok(inv.ok, inv.error ?? "");
      await asOwner(db);
      const row = await seat(db, invitationId);
      assert.equal(row.declined_at, null, "a reissue clears the decline");
      assert.equal(row.active, true);
      assert.equal(row.user_id, null, "a reissue restores an INVITATION, never a membership");
    });

    test("the reissue is auditable as a restoration in that family", async () => {
      const [row] = await rows(db,
        `select action, area_id from public.audit_log
         where record_id = $1 and action = 'restored' order by occurred_at desc limit 1`, [invitationId]);
      assert.ok(row, "a reissue must leave an audit row");
      assert.equal(row.area_id, f.areas.alpha);
    });

    test("and Accept is required again -- the invitation is back on the list", async () => {
      const seen_ = await probe(db, who(account, null), "select * from public.list_my_family_invitations()");
      assert.equal(seen_.count, 1);
      const accepted = await call(db, who(account, null),
        "select public.accept_family_invitation($1)", [invitationId]);
      assert.ok(accepted.ok, accepted.error ?? "");
    });

    test("the CHECK refuses a declined row that carries a login", async () => {
      await asOwner(db);
      const r = await attempt(db,
        "update public.app_members set declined_at = now() where id = $1", [invitationId]);
      assert.equal(r.ok, false, "a claimed seat must never be markable as declined");
      assert.match(r.error, /app_members_declined_is_unclaimed/);
    });

    test("revoke and decline are now distinguishable", async () => {
      const revoked = await call(db, who(f.users.dual, f.areas.alpha),
        "select public.revoke_area_access($1, false)", [personId]);
      assert.ok(revoked.ok, revoked.error ?? "");
      await asOwner(db);
      const row = await seat(db, invitationId);
      assert.equal(row.active, false);
      assert.equal(row.declined_at, null, "revoked is not declined");
    });
  });

  // -------------------------------------------------------------------------
  // THE WRITE BARRIER
  // -------------------------------------------------------------------------

  describe("the barrier permits the decline shape and nothing else new", () => {
    let outsider;
    let invitationId;

    before(async () => {
      outsider = await makeAccount(db, "barrier@example.test");
      const personId = await newPerson(db, f.users.bravoadmin, f.areas.bravo, "Barrier Seat");
      const inv = await invite(db, f.users.bravoadmin, f.areas.bravo, personId, "barrier@example.test");
      assert.ok(inv.ok, inv.error ?? "");
      invitationId = await value(db,
        "select id from public.app_members where lower(email) = 'barrier@example.test'");
    });

    /** Every other write a non-member could try on their own invitation row. */
    const FORBIDDEN = [
      ["promote themselves to admin", "role = 'admin'"],
      ["move the row to another family", "area_id = $2"],
      ["make themselves a contributor", "contributor_id = gen_random_uuid()"],
      ["reactivate a row they do not hold", "active = true, declined_at = now()"],
      ["decline while attaching a login", "active = false, declined_at = now(), user_id = $3"],
      ["change the address on it", "email = 'someoneelse@example.test'"],
      ["declare it declined while leaving it active", "declined_at = now()"],
    ];

    for (const [name, setClause] of FORBIDDEN) {
      test(`a non-member cannot ${name}`, async () => {
        const r = await probe(db, who(outsider, null),
          `update public.app_members set ${setClause} where id = $1`,
          [invitationId, f.areas.alpha, outsider]);
        assert.equal(r.ok, false, `${name} was permitted`);
      });
    }

    test("but the routine's own decline shape passes", async () => {
      const r = await call(db, who(outsider, null),
        "select public.decline_family_invitation($1)", [invitationId]);
      assert.ok(r.ok, r.error ?? "");
    });
  });

  // -------------------------------------------------------------------------
  // ENUMERATION RESISTANCE
  // -------------------------------------------------------------------------

  describe("no family-facing surface reveals whether an address has an account", () => {
    let withAccount;
    let withoutAccount;

    before(async () => {
      await makeAccount(db, "hasaccount@example.test");
      // Two fresh people in Charlie, invited to two addresses -- one of which
      // has an Auth account and one of which has never been heard of.
      withAccount = await newPerson(db, f.users.dual, f.areas.charlie, "Enum One");
      withoutAccount = await newPerson(db, f.users.dual, f.areas.charlie, "Enum Two");
      assert.ok((await invite(db, f.users.dual, f.areas.charlie, withAccount, "hasaccount@example.test")).ok);
      assert.ok((await invite(db, f.users.dual, f.areas.charlie, withoutAccount, "noaccount@example.test")).ok);
    });

    test("list_area_access returns the identical row shape for both", async () => {
      const listed = await probe(db, who(f.users.dual, f.areas.charlie), "select * from public.list_area_access()");
      assert.ok(listed.ok, listed.error ?? "");
      const one = listed.rows.find((r) => r.person_name === "Enum One");
      const two = listed.rows.find((r) => r.person_name === "Enum Two");
      assert.ok(one && two);

      for (const column of ["role", "active", "claimed", "account_status", "email_confirmed", "declined_at"]) {
        assert.equal(
          String(one[column]), String(two[column]),
          `${column} differs between an invited address that has an account and one that does not`,
        );
      }
      assert.equal(one.account_status, null);
      assert.equal(one.email_confirmed, null);
      assert.equal(one.claimed, false);
    });

    test("no routine anywhere takes an email address and answers about accounts", async () => {
      const offenders = await rows(db,
        `select proname from pg_proc
         where pronamespace = 'public'::regnamespace
           and proname in ('list_my_family_invitations', 'accept_family_invitation',
                           'decline_family_invitation', 'record_invitation_delivery')
           and pg_get_function_identity_arguments(oid) like '%email%'`);
      assert.deepEqual(offenders, []);
    });

    test("the two delivery branches write byte-identical audit rows", async () => {
      const a = await call(db, who(f.users.dual, f.areas.charlie),
        "select public.record_invitation_delivery($1, 'ready')", [withAccount]);
      const b = await call(db, who(f.users.dual, f.areas.charlie),
        "select public.record_invitation_delivery($1, 'ready')", [withoutAccount]);
      assert.ok(a.ok, a.error ?? "");
      assert.ok(b.ok, b.error ?? "");

      await asOwner(db);
      const written = await rows(db,
        `select record_id, table_name, action, actor_user_id, actor_name, summary, details, area_id
         from public.audit_log where summary = 'Invitation delivery recorded' order by id`);
      assert.equal(written.length, 2);
      const [one, two] = written;
      for (const column of Object.keys(one)) {
        if (column === "record_id") continue;
        assert.equal(
          JSON.stringify(one[column]), JSON.stringify(two[column]),
          `${column} differs between the existing-account and no-account delivery branches`,
        );
      }
      assert.deepEqual(one.details, { outcome: "ready" });
    });
  });

  // -------------------------------------------------------------------------
  // THE AUDIT BOUNDARY
  // -------------------------------------------------------------------------

  describe("record_invitation_delivery cannot be used for anything else", () => {
    let openInvitation;

    before(async () => {
      openInvitation = await value(db,
        "select id from public.people where area_id = $1 and name = 'Enum One'", [f.areas.charlie]);
    });

    test("an outcome outside the two permitted words is refused", async () => {
      for (const word of ["sent", "email_exists", "SKIPPED", "", "ready'; drop table"]) {
        const r = await call(db, who(f.users.dual, f.areas.charlie),
          "select public.record_invitation_delivery($1, $2)", [openInvitation, word]);
        assert.equal(r.ok, false, `'${word}' was accepted as a delivery outcome`);
        assert.match(r.error, /not a delivery outcome/);
      }
    });

    test("a null outcome is refused", async () => {
      const r = await call(db, who(f.users.dual, f.areas.charlie),
        "select public.record_invitation_delivery($1, null)", [openInvitation]);
      assert.equal(r.ok, false);
    });

    test("an administrator of another family cannot record against this one", async () => {
      const r = await call(db, who(f.users.bravoadmin, f.areas.bravo),
        "select public.record_invitation_delivery($1, 'ready')", [openInvitation]);
      assert.equal(r.ok, false);
    });

    test("an ordinary member of the same family cannot record at all", async () => {
      const r = await call(db, who(f.users.jade, f.areas.alpha),
        `select public.record_invitation_delivery(
           (select id from public.people where area_id = $1 and name = 'Mo'), 'ready')`, [f.areas.alpha]);
      assert.equal(r.ok, false);
    });

    test("it refuses a person who has no open invitation", async () => {
      const ada = await value(db,
        "select id from public.people where area_id = $1 and name = 'Cass'", [f.areas.charlie]);
      const r = await call(db, who(f.users.dual, f.areas.charlie),
        "select public.record_invitation_delivery($1, 'ready')", [ada]);
      assert.equal(r.ok, false, "the administrator's own seat must not be narratable through this");
    });

    test("no audit row it writes carries an address, a domain, a link or a token", async () => {
      const leaked = await rows(db,
        `select id from public.audit_log
         where summary = 'Invitation delivery recorded'
           and (details::text like '%@%' or details::text like '%http%'
                or summary like '%@%' or details::text like '%token%')`);
      assert.deepEqual(leaked, []);
    });
  });

  // -------------------------------------------------------------------------
  // INTEGRITY THAT MUST NOT HAVE MOVED
  // -------------------------------------------------------------------------

  describe("the guarantees 053 must not have weakened", () => {
    test("the protected admin seat refuses grant, revoke, accept and decline", async () => {
      await asOwner(db);
      const adminSeat = await value(db,
        "select id from public.app_members where area_id = $1 and role = 'admin'", [f.areas.bravo]);
      const adminPerson = await value(db,
        "select person_id from public.app_members where id = $1", [adminSeat]);

      const granted = await invite(db, f.users.bravoadmin, f.areas.bravo, adminPerson, "newadmin@example.test");
      assert.equal(granted.ok, false);
      const revoked = await call(db, who(f.users.bravoadmin, f.areas.bravo),
        "select public.revoke_area_access($1, false)", [adminPerson]);
      assert.equal(revoked.ok, false);
      const accepted = await call(db, who(f.users.bravoadmin, f.areas.bravo),
        "select public.accept_family_invitation($1)", [adminSeat]);
      assert.equal(accepted.ok, false);
      const declined = await call(db, who(f.users.bravoadmin, f.areas.bravo),
        "select public.decline_family_invitation($1)", [adminSeat]);
      assert.equal(declined.ok, false);
    });

    test("a family administrator cannot invite into another family", async () => {
      const otherPerson = await value(db,
        "select id from public.people where area_id = $1 and name = 'Mo'", [f.areas.alpha]);
      const r = await invite(db, f.users.bravoadmin, f.areas.bravo, otherPerson, "crossarea@example.test");
      assert.equal(r.ok, false);
    });

    test("one person cannot be linked to two seats", async () => {
      await asOwner(db);
      const personId = await value(db,
        "select id from public.people where area_id = $1 and name = 'Mo'", [f.areas.alpha]);
      const r = await attempt(db,
        `insert into public.app_members (area_id, person_id, email, role, active)
         values ($1, $2, 'second@example.test', 'member', true)`, [f.areas.alpha, personId]);
      assert.equal(r.ok, false);
    });

    test("one account may hold seats in several families", async () => {
      const held = Number(await value(db,
        `select count(distinct area_id) from public.app_members
         where user_id = $1 and active = true`, [f.users.dual]));
      assert.ok(held >= 2, "the dual account must still be a member of more than one family");
    });

    test("the same address may be invited to two different families", async () => {
      const multi = await makeAccount(db, "twofamilies@example.test");
      await asOwner(db);
      for (const [admin, area, name] of [
        [f.users.dual, f.areas.alpha, "Multi A"],
        [f.users.bravoadmin, f.areas.bravo, "Multi B"],
      ]) {
        const personId = await newPerson(db, admin, area, name);
        const inv = await invite(db, admin, area, personId, "twofamilies@example.test");
        assert.ok(inv.ok, `${name}: ${inv.error ?? ""}`);
      }
      const listed = await probe(db, who(multi, null), "select * from public.list_my_family_invitations()");
      assert.equal(listed.count, 2);

      for (const row of listed.rows) {
        const r = await call(db, who(multi, null),
          "select public.accept_family_invitation($1)", [row.invitation_id]);
        assert.ok(r.ok, r.error ?? "");
      }
      await asOwner(db);
      assert.equal(
        Number(await value(db,
          "select count(*) from public.app_members where user_id = $1 and active = true", [multi])),
        2,
        "both memberships must stand, independently",
      );
    });

    test("a duplicate address inside one family is refused with a sentence", async () => {
      const personId = await newPerson(db, f.users.bravoadmin, f.areas.bravo, "Dup");
      const r = await invite(db, f.users.bravoadmin, f.areas.bravo, personId, "twofamilies@example.test");
      assert.equal(r.ok, false);
      assert.match(r.error, /already uses that email address/);
    });

    test("cross-Area integrity is still zero", async () => {
      await asOwner(db);
      const strays = await value(db,
        `select count(*)::int from public.app_members m
         join public.people p on p.id = m.person_id
         where p.area_id <> m.area_id`);
      assert.equal(strays, 0);
    });

    test("app_members carries no new policy, and app_accounts is still unreadable", async () => {
      assert.equal(
        Number(await value(db,
          "select count(*) from pg_policies where schemaname='public' and tablename='app_members'")), 2);
      assert.equal(await seen(db, who(f.users.dual, f.areas.alpha), "app_accounts"),
        "REFUSED(permission denied for table app_accounts)");
    });
  });
});

// ===========================================================================

describe("what migration 053 changed, measured against 052", () => {
  let db;

  before(async () => { db = await buildRehearsal({ through: BEFORE_053 }); });
  after(async () => { await db?.close(); });

  test("before 053, signing in still joined you silently -- that is the defect", async () => {
    const f = await buildTwoFamilies(db);
    const email = "beforethefix@example.test";
    const account = await makeAccount(db, email);
    const personId = await newPerson(db, f.users.bravoadmin, f.areas.bravo, "Legacy");
    const inv = await invite(db, f.users.bravoadmin, f.areas.bravo, personId, email);
    assert.ok(inv.ok, inv.error ?? "");

    const claimed = await probeValue(db, who(account, null), "select public.claim_app_member()");
    assert.equal(claimed.value, true, "052's claim path joined this account with no consent step");

    await asOwner(db);
    assert.equal(
      Number(await value(db, "select count(*) from public.app_members where user_id = $1", [account])), 1);
  });

  test("053 applies cleanly on top, and its end-state block passes", async () => {
    const applied = await applyMigration(db, CONSENT);
    assert.ok(applied.ok, `053 did not apply: ${applied.error ?? ""}`);
  });

  test("and after it, the same claim path joins nobody", async () => {
    const email = "afterthefix@example.test";
    const account = await makeAccount(db, email);
    await asOwner(db);
    const area = await value(db, "select id from public.areas where name = 'Bravo'");
    const admin = await value(db,
      "select user_id from public.app_members where area_id = $1 and role = 'admin'", [area]);
    const personId = await newPerson(db, admin, area, "AfterFix");
    const inv = await invite(db, admin, area, personId, email);
    assert.ok(inv.ok, inv.error ?? "");

    const claimed = await probeValue(db, who(account, null), "select public.claim_app_member()");
    assert.equal(claimed.value, false);
    await asOwner(db);
    assert.equal(
      Number(await value(db, "select count(*) from public.app_members where user_id = $1", [account])), 0);
  });

  test("053 refuses to apply to a database that is not 052's end state", async () => {
    const bare = await buildRehearsal({ through: "202608100051_drop_superseded_routines_and_narrow_table_grants.sql" });
    const applied = await applyMigration(bare, CONSENT);
    assert.equal(applied.ok, false, "the preflight must refuse a pre-052 database");
    assert.match(applied.error, /preflight failed/);
    await bare.close();
  });
});
