/**
 * WHICH IDENTITY A SETUP LINK OPERATES ON.
 *
 * THE DEFECT THIS SUITE PINS, observed live on 2026-08-31. `/account-setup`
 * established a session from the link's tokens when there were any, and then
 * asked `supabase.auth.getUser()` for the identity WITHOUT CHECKING that the
 * two were the same person. Open an invitation email for B in a browser already
 * signed in as A, with the link's tokens already spent, and Gift Planner
 * greeted you, set a password and routed you AS A -- while you believed you had
 * just set up B.
 *
 * NOT A DATA BREACH, and the distinction matters. `list_my_family_invitations()`
 * and `accept_family_invitation()` resolve the caller from `auth.uid()` and
 * match the seat on `lower(m.email) = caller_email` read from `auth.users`, so
 * A's session can never see or accept B's invitation -- the database refuses
 * it, and there is no parameter to lie in. What was broken was DETERMINISM.
 *
 * THE DECISION IS A PURE FUNCTION, so every case below runs the real rule rather
 * than a regex over the file that contains it. The source-reading tests that
 * remain are for the wiring and for shapes that must not exist.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";

const {
  SETUP_IDENTITY_PARAM,
  SETUP_SESSION_MESSAGES,
  mayProceedWithSetup,
  mustClearSession,
  setupSessionVerdict,
} = await import("../src/lib/setup-session.ts");

const {
  ACCOUNT_PENDING_PATH,
  destinationFor,
} = await import("../src/lib/account-status.ts");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/gu, "").replace(/^\s*\/\/.*$/gmu, "");

const SETUP = "src/app/account-setup/page.tsx";
const CALLBACK = "src/app/auth/callback/route.ts";
const PENDING = "src/app/account-pending/page.tsx";

const INVITED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOMEBODY_ELSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// 1. The six situations a setup link can land in
// ---------------------------------------------------------------------------

describe("a setup link operates on the identity the link established, and no other", () => {
  test("NO EXISTING BROWSER SESSION, and the link carries its own tokens", () => {
    // The ordinary invited path: nothing was signed in, `setSession` spends the
    // tokens, and the identity afterwards is the link's by construction.
    const verdict = setupSessionVerdict({
      linkUserId: INVITED,
      sessionUserId: INVITED,
      establishedFromLink: true,
    });
    assert.equal(verdict, "established");
    assert.ok(mayProceedWithSetup(verdict));
    assert.ok(!mustClearSession(verdict));
  });

  test("NO EXISTING SESSION AND NO TOKENS is a spent link, not an identity problem", () => {
    /*
     * Worth telling apart from a mismatch: there is nobody to sign out and
     * nothing was borrowed. The person needs another link, and the message says
     * so rather than accusing their browser of anything.
     */
    const verdict = setupSessionVerdict({
      linkUserId: null,
      sessionUserId: null,
      establishedFromLink: false,
    });
    assert.equal(verdict, "no_session");
    assert.ok(!mayProceedWithSetup(verdict));
    assert.ok(!mustClearSession(verdict));
    assert.match(SETUP_SESSION_MESSAGES.no_session, /invalid or has expired/iu);
  });

  test("THE EXISTING SESSION IS ALREADY THE INVITED USER -- proceed, do not sign them out", () => {
    /*
     * The PKCE path. `/auth/callback` exchanged the code, the cookie is already
     * the link's identity, and the callback NAMED it so this side can check
     * rather than assume. Signing them out here would break the ordinary
     * confirmation journey.
     */
    const verdict = setupSessionVerdict({
      linkUserId: INVITED,
      sessionUserId: INVITED,
      establishedFromLink: false,
    });
    assert.equal(verdict, "matches");
    assert.ok(mayProceedWithSetup(verdict));
    assert.ok(!mustClearSession(verdict));
  });

  test("THE EXISTING SESSION BELONGS TO SOMEBODY ELSE -- refuse and clear", () => {
    // Signed in as A, opening B's link. This is the defect, and it must never
    // proceed.
    const verdict = setupSessionVerdict({
      linkUserId: INVITED,
      sessionUserId: SOMEBODY_ELSE,
      establishedFromLink: false,
    });
    assert.equal(verdict, "wrong_identity");
    assert.ok(!mayProceedWithSetup(verdict), "setup must not continue as the other account");
    assert.ok(mustClearSession(verdict), "and the other session must be cleared");
  });

  test("AN UNIDENTIFIED LINK OVER AN EXISTING SESSION IS REFUSED, not borrowed", () => {
    /*
     * THE EXACT SHAPE OF THE LIVE DEFECT. No tokens were spent and the link
     * named nobody, so there is NO EVIDENCE that the session in this browser
     * has anything to do with the email that was opened. The old code called
     * `getUser()` and believed it. Failing closed is the whole fix.
     */
    const verdict = setupSessionVerdict({
      linkUserId: null,
      sessionUserId: SOMEBODY_ELSE,
      establishedFromLink: false,
    });
    assert.equal(verdict, "wrong_identity");
    assert.ok(!mayProceedWithSetup(verdict));
    assert.ok(mustClearSession(verdict));
  });

  test("THE LINK REPLACES A DIFFERENT SESSION when it has tokens to spend", () => {
    /*
     * `setSession` overwrites whatever was in the browser, so the identity
     * afterwards is the link's even though somebody else was signed in a moment
     * earlier. That is the replacement working -- and the verdict reads
     * `established`, from the identity that came BACK from the exchange rather
     * than the one that preceded it.
     */
    const verdict = setupSessionVerdict({
      linkUserId: INVITED,
      sessionUserId: INVITED,
      establishedFromLink: true,
    });
    assert.equal(verdict, "established");
    assert.ok(mayProceedWithSetup(verdict));
  });

  test("and an exchange that somehow produced a DIFFERENT person is still refused", () => {
    // Belt and braces: if the tokens ever resolved to somebody other than the
    // named identity, that disagreement fails closed like every other.
    const verdict = setupSessionVerdict({
      linkUserId: SOMEBODY_ELSE,
      sessionUserId: INVITED,
      establishedFromLink: true,
    });
    assert.equal(verdict, "wrong_identity");
    assert.ok(mustClearSession(verdict));
  });

  test("AFTER SETUP THE SESSION DEFINITELY BELONGS TO THE INVITED ACCOUNT", () => {
    /*
     * The property, stated as an exhaustive sweep rather than as one example:
     * across every combination, setup proceeds ONLY where the session id equals
     * the link id. There is no reachable state in which setup runs under an
     * identity the link did not establish.
     */
    const ids = [INVITED, SOMEBODY_ELSE, null];
    for (const linkUserId of ids) {
      for (const sessionUserId of ids) {
        for (const establishedFromLink of [true, false]) {
          const verdict = setupSessionVerdict({ linkUserId, sessionUserId, establishedFromLink });
          if (!mayProceedWithSetup(verdict)) continue;
          assert.ok(sessionUserId, "setup never proceeds without a session");
          if (linkUserId) {
            assert.equal(sessionUserId, linkUserId,
              `setup proceeded with session ${sessionUserId} for link ${linkUserId}`);
          } else {
            assert.ok(establishedFromLink,
              "an unnamed link may only proceed when it established the session itself");
          }
        }
      }
    }
  });

  test("the refusal names nobody", () => {
    // Saying "you were signed in as alice@example.com" would disclose one
    // browser-sharer's address to another, on a screen anybody with a link can
    // reach.
    const message = SETUP_SESSION_MESSAGES.wrong_identity;
    assert.match(message, /signed out/iu);
    assert.match(message, /open the link in your email again/iu);
    assert.ok(!/@/u.test(message), "no address may appear in the refusal");
  });
});

// ---------------------------------------------------------------------------
// 2. The wiring
// ---------------------------------------------------------------------------

describe("the setup screen asks the question instead of assuming the answer", () => {
  const setup = read(SETUP);

  test("it decides with the shared rule, and it signs the wrong session out", () => {
    assert.match(setup, /const verdict = setupSessionVerdict\(\{/u);
    assert.match(setup, /establishedFromLink: establishedUserId !== null/u);
    assert.match(setup, /if \(mustClearSession\(verdict\)\) \{/u);
    /*
     * THE CANONICAL CLEARER, not a hand-rolled `auth.signOut()`. `clearSession`
     * ends the session AND forgets `gp_area` -- the hazard the sign-out module
     * exists for -- and leaves out only the hard navigation, because this
     * screen has to stay put and say what happened. `auth.signOut()` still
     * appears in exactly one file, which `scripts/canonical-paths.test.mjs`
     * counts.
     */
    assert.match(setup, /await clearSession\(\);/u);
    assert.ok(!withoutComments(setup).includes("auth.signOut()"));
    assert.match(setup, /if \(!mayProceedWithSetup\(verdict\)/u);
  });

  test("THE VERDICT IS REACHED BEFORE ANYTHING IS DONE AS THAT IDENTITY", () => {
    /*
     * Order is the guarantee. The claim, the membership read, the name lookup
     * and the password form all act as the signed-in person, so every one of
     * them has to come after the check that says who that is.
     */
    const body = withoutComments(setup);
    const verdict = body.indexOf("setupSessionVerdict(");
    assert.ok(verdict > -1);
    for (const later of ['rpc("claim_app_member")', 'from("app_members")', "loadAccountStatusClient()", "setStage(\"ready\")"]) {
      const at = body.indexOf(later);
      if (at === -1) continue;
      assert.ok(at > verdict, `${later} must not run before the identity is settled`);
    }
  });

  test("the link's own identity is read back from what it established", () => {
    // Not from the session that preceded it, which is the thing being guarded
    // against.
    assert.match(setup, /establishedUserId = session\.data\.user\?\.id \?\? null;/u);
    assert.match(setup, /const namedIdentity = query\.get\(SETUP_IDENTITY_PARAM\);/u);
  });

  test("and the callback names the identity it exchanged", () => {
    const callback = read(CALLBACK);
    assert.match(callback, /if \(next === "\/account-setup"\) \{/u);
    assert.match(callback, /const exchanged = exchange\.data\.user\?\.id \?\? null;/u);
    assert.match(callback, /setupUrl\.searchParams\.set\(SETUP_IDENTITY_PARAM, exchanged\)/u);
    assert.equal(SETUP_IDENTITY_PARAM, "identity");
  });

  test("no token, password or address reaches a log line", () => {
    for (const path of [SETUP, CALLBACK]) {
      const body = read(path);
      for (const line of body.matchAll(/console\.(error|warn|log|info)\(([\s\S]*?)\n?\s*\);/gu)) {
        const text = line[2];
        assert.ok(!/access_token|refresh_token|\bpassword\b|action_link/u.test(text),
          `${path} log line carries auth material: ${text.trim().slice(0, 80)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The two routing corrections found with it
// ---------------------------------------------------------------------------

describe("a brand-new invited account can finish setting itself up", () => {
  test("THE PASSWORD SCREEN IS REACHABLE FOR A PENDING ACCOUNT", () => {
    /*
     * THE DEFECT: an invite link CONFIRMS the address as part of the exchange,
     * so by the time `/account-setup` runs the account is `pending`, not
     * `email_unverified`. With `pending` allowed only on `/account-pending` and
     * `/invitations`, the setup page asked `destinationFor`, was told to leave,
     * and returned before rendering the password form. Every brand-new invited
     * account was unable to set a password. Observed live 2026-08-31.
     */
    assert.equal(destinationFor("pending", "/account-setup"), null);
    // And the states around it are unchanged.
    assert.equal(destinationFor("email_unverified", "/account-setup"), null);
    assert.equal(destinationFor("pending", "/"), ACCOUNT_PENDING_PATH);
    assert.equal(destinationFor("pending", "/people"), ACCOUNT_PENDING_PATH);
    assert.equal(destinationFor("signed_out", "/account-setup"), null, "the link is how you arrive");
    // A refused account may not set a credential on its way past the refusal.
    assert.equal(destinationFor("rejected", "/account-setup"), "/account-rejected");
    assert.equal(destinationFor("suspended", "/account-setup"), "/account-rejected");
  });

  test("setting a password is not access, which is why it is safe to allow", () => {
    // `/account-setup` reads no family data, and the account still cannot open
    // anything until a Gift Planner administrator approves it.
    const setup = withoutComments(read(SETUP));
    assert.ok(!setup.includes('from("events")'));
    assert.ok(!setup.includes('from("recipients")'));
    assert.ok(!setup.includes("list_area_access"));
  });

  test("AN INVITATION CANNOT BE ACCEPTED UNDER THE WRONG IDENTITY, whatever the browser does", () => {
    /*
     * THE GUARANTEE THAT DOES NOT DEPEND ON ANY OF THE ABOVE, and the reason
     * the session defect was a determinism bug rather than a data breach.
     *
     * Both invitee routines resolve the caller from `auth.uid()` and the
     * address from `auth.users`, then select the seat on
     * `lower(m.email) = caller_email`. There is NO PARAMETER for an address or
     * a user id anywhere -- the invitation id is a selector, never a credential
     * -- so a session belonging to A cannot list or accept a seat addressed to
     * B, however A's browser came by that session.
     *
     * `scripts/family-invitations.test.mjs` proves this against real
     * PostgreSQL by signing the wrong account in and trying. This pins the
     * contract those tests rely on.
     */
    const migration = read("supabase/migrations/202608100053_family_invitation_consent.sql");
    for (const routine of ["accept_family_invitation", "decline_family_invitation", "list_my_family_invitations"]) {
      const from = migration.indexOf(`create or replace function public.${routine}`);
      const body = migration.slice(from, migration.indexOf("$$;", from));
      assert.match(body, /caller uuid := \(select auth\.uid\(\)\)/u, `${routine} must resolve its own caller`);
      assert.match(body, /from auth\.users as auth_user\s*\n\s*where auth_user\.id = caller\s*\n\s*and auth_user\.email_confirmed_at is not null/u,
        `${routine} must read the address from the confirmed account, not from a parameter`);
      assert.match(body, /lower\(m\.email\) = caller_email/u, `${routine} must match the seat on the caller's own address`);
      assert.ok(!/p_email|p_user_id|p_address/u.test(body), `${routine} must take no identity parameter`);
    }
    // And the two that act take exactly one argument, which is the seat.
    assert.match(migration, /accept_family_invitation\(p_invitation_id uuid\)/u);
    assert.match(migration, /decline_family_invitation\(p_invitation_id uuid\)/u);
  });

  test("ACCEPT IS NOT THE FIRST THING A NEW ACCOUNT MEETS", () => {
    /*
     * The pending screen briefly rendered the invitation card inline, Accept
     * included -- and it is exactly where a new invitee was being bounced to,
     * so the first control anybody ever saw was Accept, seconds after clicking
     * an email. The offer belongs on the screen that exists for it, reached on
     * purpose.
     */
    const pending = withoutComments(read(PENDING));
    assert.ok(!pending.includes("<FamilyInvitations"), "no inline Accept on the pending screen");
    assert.ok(!pending.includes("accept_family_invitation"));
    assert.match(pending, /href=\{INVITATIONS_PATH\}/u, "but the way to it is still offered");
  });
});
