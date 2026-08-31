/**
 * THE INVITEE'S SIDE OF MIGRATION 053, AS THE APPLICATION RUNS IT.
 *
 * WHAT THIS FILE IS *NOT* FOR. `scripts/family-invitations.test.mjs` runs the
 * database half against a real PostgreSQL: it signs accounts in and proves that
 * the wrong account cannot accept, that a guessed uuid produces the identical
 * refusal, that a globally pending account may accept and gains nothing by it,
 * that a rejected account is refused acceptance but may still decline, that
 * replay is refused, that accepting writes `user_id` and `updated_at` and
 * nothing else anywhere, and that a stale `gp_area` changes none of it. Every
 * one of those is authorization, and authorization is the database's.
 *
 * WHAT THIS FILE IS FOR: the half that lives in this repository -- which screen
 * a state may stand on, what the invitation surface is allowed to say before
 * anybody has joined anything, and the shapes that must not exist. Where a
 * decision is a pure function it is CALLED here rather than read.
 *
 * THE ONE RULE UNDERNEATH ALL OF IT: nothing joins a family except an explicit
 * Accept. Not signing in, not confirming an address, not an auth callback, not
 * an email that happens to match.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const {
  ACCOUNT_PENDING_PATH,
  ACCOUNT_REJECTED_PATH,
  CHECK_EMAIL_PATH,
  GLOBAL_ROUTES,
  HOME_PATH,
  LOGIN_PATH,
  destinationFor,
  isBareRoute,
  isGlobalRoute,
} = await import("../src/lib/account-status.ts");

const {
  INVITATIONS_PATH,
  INVITATION_COPY,
  invitationBody,
  invitationFamilyName,
  invitationTitle,
  sortInvitations,
} = await import("../src/lib/invitations.ts");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/gu, "").replace(/^\s*\/\/.*$/gmu, "");

function sourceFiles(relative = "src") {
  const found = [];
  for (const entry of readdirSync(new URL(`../${relative}`, import.meta.url), { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...sourceFiles(`${relative}/${entry.name}`));
    else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) found.push(`${relative}/${entry.name}`);
  }
  return found;
}

const LIST = "src/app/invitations/family-invitations.tsx";
const PAGE = "src/app/invitations/page.tsx";
const MIGRATION = "supabase/migrations/202608100053_family_invitation_consent.sql";

const invitation = (over = {}) => ({
  invitation_id: "11111111-1111-4111-8111-111111111111",
  area_name: "Tricketts",
  invited_as: "Grandma",
  invited_at: "2026-08-30T10:00:00Z",
  ...over,
});

// ---------------------------------------------------------------------------
// 1. Where an invitation may be answered from
// ---------------------------------------------------------------------------

describe("the invitation surface is global, and it has to be", () => {
  test("`/invitations` is a global route, so it carries no family at all", () => {
    /*
     * A BARE ROUTE means `AppFrame` draws no chrome and `FamilyProvider` does
     * none of its Area work -- no membership resolution, no ensureAreaChosen,
     * no realtime subscription. That is not a cosmetic choice: the reader may
     * be in NO family, so a screen that resolves one first is a screen they can
     * never open.
     */
    assert.ok(GLOBAL_ROUTES.includes(INVITATIONS_PATH));
    assert.ok(isGlobalRoute(INVITATIONS_PATH));
    assert.ok(isBareRoute(INVITATIONS_PATH));
    assert.equal(INVITATIONS_PATH, "/invitations");
  });

  test("A GLOBALLY PENDING ACCOUNT MAY STAND THERE, which is the one routing change", () => {
    /*
     * Everywhere else a pending account is sent to `/account-pending` and kept
     * there. 053 permits it to accept -- and the membership grants NOTHING
     * until approval, because every permission predicate already carries
     * `is_globally_approved()` -- so this widens where they may stand and not
     * one row of what they may read. The alternative was: wait, be approved,
     * then chase the family for a second invitation.
     */
    assert.equal(destinationFor("pending", INVITATIONS_PATH), null);
    assert.equal(destinationFor("pending", ACCOUNT_PENDING_PATH), null);
    assert.equal(destinationFor("pending", HOME_PATH), ACCOUNT_PENDING_PATH);
    assert.equal(destinationFor("pending", "/people"), ACCOUNT_PENDING_PATH);
    assert.equal(destinationFor("pending", "/events/abc"), ACCOUNT_PENDING_PATH);
  });

  test("and the three states that may NOT are still sent where they belong", () => {
    assert.equal(destinationFor("signed_out", INVITATIONS_PATH), LOGIN_PATH);
    // An unconfirmed address would read an empty list anyway -- the routine
    // requires `email_confirmed_at is not null` -- so this only saves them a
    // blank screen.
    assert.equal(destinationFor("email_unverified", INVITATIONS_PATH), CHECK_EMAIL_PATH);
    assert.equal(destinationFor("rejected", INVITATIONS_PATH), ACCOUNT_REJECTED_PATH);
    assert.equal(destinationFor("suspended", INVITATIONS_PATH), ACCOUNT_REJECTED_PATH);
  });

  test("an approved account stays, with or without a family", () => {
    assert.equal(destinationFor("approved", INVITATIONS_PATH), null);
  });

  test("the page asks the same question of the same function", () => {
    const page = read(PAGE);
    assert.match(page, /const destination = destinationFor\(status\.state, INVITATIONS_PATH\);/u);
    assert.match(page, /if \(destination\) redirect\(destination\);/u);
  });

  test("A STALE gp_area CANNOT REACH THIS SCREEN, because nothing on it reads one", () => {
    for (const path of [PAGE, LIST]) {
      const body = withoutComments(read(path));
      assert.ok(!body.includes("AREA_COOKIE"), `${path} must not read the Area cookie`);
      assert.ok(!body.includes("gp_area"));
      assert.ok(!body.includes("acting_area"));
      assert.ok(!body.includes("getCurrentMember"), `${path} must not resolve a membership`);
      assert.ok(!body.includes("loadAreaContext"));
      assert.ok(!body.includes("useFamily"), `${path} must not need FamilyProvider`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. What an invitation may say before it is accepted
// ---------------------------------------------------------------------------

describe("an unaccepted invitation discloses the family's name and nothing else", () => {
  test("the card names the family and the person the seat is for", () => {
    assert.equal(invitationTitle(invitation()), "Invitation to Tricketts");
    assert.equal(invitationBody(invitation()), "You have been invited to join Tricketts as Grandma.");
  });

  test("NAMING THE PERSON IS THE POINT, not decoration", () => {
    // Being invited as the wrong person is the one mistake this screen can
    // catch before it becomes a membership.
    assert.match(invitationBody(invitation({ invited_as: "Harry" })), /as Harry/u);
    // And a seat that names nobody still asks a complete question.
    assert.equal(invitationBody(invitation({ invited_as: null })), "You have been invited to join Tricketts.");
    assert.equal(invitationBody(invitation({ invited_as: "   " })), "You have been invited to join Tricketts.");
  });

  test("a family with no name still renders safely rather than blankly", () => {
    assert.equal(invitationFamilyName(invitation({ area_name: null })), "a family");
    assert.equal(invitationTitle(invitation({ area_name: "" })), "Invitation to a family");
  });

  test("SEVERAL INVITATIONS ACROSS FAMILIES RENDER, in the routine's own order", () => {
    const rows = [
      invitation({ invitation_id: "b", area_name: "QA Bravo", invited_at: "2026-08-02T00:00:00Z" }),
      invitation({ invitation_id: "a2", area_name: "QA Alpha", invited_at: "2026-08-09T00:00:00Z" }),
      invitation({ invitation_id: "a1", area_name: "QA Alpha", invited_at: "2026-08-01T00:00:00Z" }),
    ];
    assert.deepEqual(sortInvitations(rows).map((row) => row.invitation_id), ["a1", "a2", "b"]);
    // and it does not mutate what it was handed
    assert.equal(rows[0].invitation_id, "b");
  });

  test("THE ROUTINE RETURNS FOUR COLUMNS, AND THE SCREEN CAN READ NO FIFTH", () => {
    /*
     * Nothing financial, no event, no other person, no member list, and not
     * even the invitee's own address. Anything this screen wanted to add would
     * have to be read from somewhere they have no right to read yet -- which is
     * the reason it is not there.
     */
    const migration = read(MIGRATION);
    const declared = migration.slice(migration.indexOf("create or replace function public.list_my_family_invitations"));
    const columns = declared.slice(declared.indexOf("returns table ("), declared.indexOf(")\nlanguage"));
    assert.deepEqual(
      [...columns.matchAll(/^\s{2}(\w+)\s/gmu)].map((match) => match[1]),
      ["invitation_id", "area_name", "invited_as", "invited_at"],
    );

    const screen = withoutComments(read(LIST));
    for (const word of ["pennies", "budget", "purchase", "payment", "birthday", "recipient"]) {
      assert.ok(!new RegExp(word, "iu").test(screen), `the invitation card must not mention ${word}`);
    }
    for (const table of ["people", "events", "recipients", "purchases", "notifications", "app_members"]) {
      assert.ok(!screen.includes(`from("${table}")`), `the invitation card must not read ${table}`);
    }
  });

  test("nothing declined, revoked or already claimed can reach the list at all", () => {
    // The routine filters them out, so there is no such card to make
    // non-actionable in the browser.
    const migration = read(MIGRATION);
    const listing = migration.slice(migration.indexOf("create or replace function public.list_my_family_invitations"));
    const where = listing.slice(listing.indexOf("where m.user_id is null"), listing.indexOf("order by"));
    assert.match(where, /m\.user_id is null/u);
    assert.match(where, /m\.active = true/u);
    assert.match(where, /m\.declined_at is null/u);
    assert.match(where, /lower\(m\.email\) = caller_email/u);
  });
});

// ---------------------------------------------------------------------------
// 3. Accept and decline
// ---------------------------------------------------------------------------

describe("the two answers, and what the browser is allowed to do about them", () => {
  const list = read(LIST);

  test("both go through the 053 routines, with the id as the only argument", () => {
    assert.match(list, /rpc\("list_my_family_invitations"\)/u);
    assert.match(list, /rpc\("accept_family_invitation", \{ p_invitation_id: invitation\.invitation_id \}\)/u);
    assert.match(list, /rpc\("decline_family_invitation", \{ p_invitation_id: invitation\.invitation_id \}\)/u);
  });

  test("NO USER ID, NO EMAIL AND NO AREA IS EVER SENT AS AUTHORITY", () => {
    /*
     * The routines resolve the caller from `auth.uid()` and their address from
     * `auth.users`, so there is no parameter to lie in. A browser that sent one
     * would be a browser somebody could edit.
     */
    const body = withoutComments(list);
    for (const smuggled of ["p_user_id", "p_email", "p_area_id", "user_id:", "email:", "areaId"]) {
      assert.ok(!body.includes(smuggled), `the invitee surface must not send ${smuggled}`);
    }
  });

  test("THE BROWSER NEVER WRITES A MEMBERSHIP ITSELF", () => {
    const body = withoutComments(list);
    for (const mutator of [".insert(", ".update(", ".upsert(", ".delete("]) {
      assert.ok(!body.includes(mutator), `the invitee surface must not ${mutator}`);
    }
    assert.ok(!body.includes('from("app_members")'));
  });

  test("one refusal sentence, because the database gives exactly one", () => {
    // A guessed uuid, somebody else's invitation, an already-answered one and a
    // withdrawn one all raise 42501 with the same words. Guessing which it was
    // would invent a distinction 053 deliberately removed.
    assert.match(list, /result\.error\.code === "42501" \? INVITATION_COPY\.refused : INVITATION_COPY\.failed/u);
    assert.match(INVITATION_COPY.refused, /no longer available/iu);
    for (const leak of ["not yours", "belongs to", "does not exist", "already accepted"]) {
      assert.ok(!INVITATION_COPY.refused.toLowerCase().includes(leak));
    }
  });

  test("a failed answer RELOADS rather than guessing what the row now is", () => {
    const answer = list.slice(list.indexOf("const answer = async"));
    const refusal = answer.indexOf("setError(result.error.code");
    const reload = answer.indexOf("await load(true)", refusal);
    assert.ok(refusal > -1 && reload > refusal, "the list is re-read after a refusal");
  });

  test("ACCEPTING DOES NOT FORCE THE READER INTO THE NEW FAMILY", () => {
    /*
     * `accept_family_invitation` returns the Area id, and this deliberately
     * does not select it. Committing the acting Area on somebody's behalf
     * because they accepted an invitation is exactly the silent commitment the
     * chooser exists to prevent.
     */
    const body = withoutComments(list);
    assert.ok(!body.includes('fetch("/api/areas"'), "accepting must not choose a family");
    assert.ok(!body.includes("PUT"), "accepting must not write the Area cookie");
    assert.match(body, /router\.refresh\(\)/u, "but the server components around it are re-run");
  });

  test("declining touches nothing but the one invitation", () => {
    const answer = withoutComments(list.slice(list.indexOf("const answer = async")));
    // One RPC per answer, and the decline branch has no second call in it.
    assert.equal([...answer.matchAll(/rpc\("decline_family_invitation"/gu)].length, 1);
    assert.ok(!answer.includes("Promise.all"), "no fan-out across other invitations or families");
    assert.match(answer, /if \(kind === "accept"\)/u, "the reload is the accept branch's alone");
  });

  test("both controls disable the whole list while one is in flight", () => {
    assert.equal([...list.matchAll(/disabled=\{busy !== null\}/gu)].length, 2);
    assert.match(list, /INVITATION_COPY\.accepting/u);
    assert.match(list, /INVITATION_COPY\.declining/u);
  });
});

// ---------------------------------------------------------------------------
// 4. Nothing joins a family except Accept
// ---------------------------------------------------------------------------

describe("NO SILENT AUTO-JOIN SURVIVES ANYWHERE", () => {
  test("`claim_app_member()` is a no-op with no UPDATE left in it", () => {
    const migration = read(MIGRATION);
    const claim = migration.slice(migration.indexOf("create or replace function public.claim_app_member"));
    const body = claim.slice(0, claim.indexOf("$$;") + 3);
    assert.match(body, /\$\$ select false \$\$/u);
    assert.ok(!/update\s+public\.app_members/iu.test(body), "the auto-join body is gone, not narrowed");
  });

  test("AND NOTHING REPLACED IT: no sign-in path calls accept", () => {
    /*
     * The dangerous shape is not `claim_app_member` -- it returns `false` and
     * writes nothing. It is a NEW automatic claim on one of the paths that runs
     * without the reader asking for it. So every one of them is checked for the
     * routine that actually joins a family.
     */
    for (const path of [
      "src/app/login/page.tsx",
      "src/app/auth/callback/route.ts",
      "src/app/account-setup/page.tsx",
      "src/utils/supabase/account-status-server.ts",
      "src/utils/supabase/account-status-client.ts",
      "src/app/components/family-provider.tsx",
    ]) {
      let body;
      try { body = withoutComments(read(path)); } catch { continue; }
      assert.ok(!body.includes("accept_family_invitation"), `${path} must not accept on somebody's behalf`);
      assert.ok(!body.includes("decline_family_invitation"), `${path} must not answer for them either`);
      assert.ok(!body.includes('from("app_members")') || !/\.(insert|update|upsert)\(/u.test(body),
        `${path} must not write a membership`);
    }
  });

  test("accept is reachable from exactly one place in the whole application", () => {
    const callers = sourceFiles().filter((file) => withoutComments(read(file)).includes("accept_family_invitation"));
    assert.deepEqual(callers, [LIST], "only the invitee's own Accept button calls it");

    const decliners = sourceFiles().filter((file) => withoutComments(read(file)).includes("decline_family_invitation"));
    assert.deepEqual(decliners, [LIST]);
  });

  test("and no new silent-claim helper was invented", () => {
    for (const file of sourceFiles()) {
      const body = withoutComments(read(file));
      assert.ok(!/auto[_-]?join/iu.test(body), `${file} names an auto-join`);
      assert.ok(!/autoAccept|silentClaim|joinFamilyFor/u.test(body), `${file} has a claim helper`);
    }
  });

  test("THE ONE SURVIVING CLAIM CALL IS A NO-OP, AND ITS COMMENT SAYS SO", () => {
    /*
     * `claimInvitations()` still exists and is still called on sign-in, on the
     * auth callback and on account setup. It joins nobody: it calls
     * `claim_app_member()`, which 053 reduced to `select false`, and every
     * caller already treated `false` as the ordinary case. 053 kept the name
     * and the EXECUTE grant deliberately so an in-flight browser session could
     * not start erroring mid-deploy.
     *
     * WHAT WAS ACTUALLY DANGEROUS HERE was not the call but its DOCUMENTATION,
     * which described the pre-053 behaviour as current -- "attach this login to
     * any invitation", "the one routine that may write app_members.user_id".
     * A future reader would have believed the sign-in path still joins people,
     * or worse, "repaired" it. The helper is checked here for saying the truth.
     */
    const helper = read("src/utils/supabase/account-status-server.ts");
    const doc = helper.slice(0, helper.indexOf("export async function claimInvitations"));
    assert.match(doc, /THIS JOINS NOBODY TO ANYTHING/u);
    assert.match(doc, /DO NOT restore an automatic claim/u);
    assert.ok(!/THE ONE ROUTINE THAT MAY WRITE `app_members\.user_id`/u.test(doc),
      "the retired promise must not still be stated as current");

    // And the body cannot write, whatever the comment says.
    const body = withoutComments(helper.slice(helper.indexOf("export async function claimInvitations")));
    assert.match(body, /rpc\("claim_app_member"\)/u);
    assert.ok(!body.includes("accept_family_invitation"), "and it must never be repointed at accept");
    for (const mutator of [".insert(", ".update(", ".upsert("]) {
      assert.ok(!body.includes(mutator));
    }
  });

  test("the old silent-claim copy is gone from the screens that used to promise it", () => {
    for (const file of sourceFiles()) {
      const body = read(file);
      assert.ok(!/automatically join/iu.test(body), `${file} still promises an automatic join`);
      assert.ok(!/you will be added to/iu.test(body), `${file} still promises somebody will be added`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The surfaces, and the approval interaction
// ---------------------------------------------------------------------------

describe("where an invitation actually appears", () => {
  test("the canonical page, and it says what it is in product language", () => {
    const page = read(PAGE);
    assert.match(page, /<FamilyInvitations \/>/u);
    assert.equal(INVITATION_COPY.title, "Your invitations");
    for (const jargon of ["Area", "app_member", "app_members", "auth.uid", "RLS", "RPC"]) {
      assert.ok(!Object.values(INVITATION_COPY).some((value) => typeof value === "string" && value.includes(jargon)),
        `the copy must not say "${jargon}"`);
    }
  });

  test("THE ZERO-FAMILY FRONT DOOR OFFERS THE INVITATION BEFORE 'create a family'", () => {
    /*
     * The onboarding branch used to offer exactly one way forward -- start a
     * family of your own -- to the commonest newcomer there is: somebody a
     * family invited, who has just confirmed their address.
     */
    const root = read("src/app/page.tsx");
    const onboarding = root.slice(root.indexOf('if (entry === "onboarding")'));
    const invitations = onboarding.indexOf("<FamilyInvitations");
    const create = onboarding.indexOf("<CreateAreaForm");
    assert.ok(invitations > -1 && create > invitations, "the invitation is offered above the create form");
    assert.match(onboarding.slice(invitations, create), /compact reloadOnAccept/u);
  });

  test("and so does the family chooser, for somebody already in one family", () => {
    const root = read("src/app/page.tsx");
    assert.match(root, /if \(entry === "chooser"\) return <ChooserWithInvitations areas=\{areas\} \/>;/u);
    assert.match(root, /function ChooserWithInvitations/u);
    const wrapper = root.slice(root.indexOf("function ChooserWithInvitations"));
    assert.match(wrapper, /<FamilyInvitations compact reloadOnAccept \/>/u);
    assert.match(wrapper, /<AreaChooser areas=\{areas\} \/>/u);
  });

  test("`compact` renders NOTHING when nothing is waiting, so those screens are unchanged", () => {
    const list = read(LIST);
    assert.match(list, /invitations\.length === 0 \? \(\s*\n\s*compact \? null : \(/u);
  });

  test("THE PENDING SCREEN CARRIES IT TOO, and explains what accepting will and will not do", () => {
    const pending = read("src/app/account-pending/page.tsx");
    assert.match(pending, /<FamilyInvitations compact \/>/u);
    assert.match(pending, /INVITATION_COPY\.pendingNote/u);
    assert.match(pending, /href=\{INVITATIONS_PATH\}/u);
    // The sentence has to be true of the pending state specifically: joined
    // now, usable on approval, and no second Accept.
    assert.match(INVITATION_COPY.pendingNote, /approved/iu);
    assert.match(INVITATION_COPY.pendingNote, /not have to accept it again/iu);
  });

  test("the success sentence does not over-promise for a pending account", () => {
    // "You have joined X" is true the moment `user_id` is written. "You can now
    // open X" would not be, and this must not say it.
    assert.equal(INVITATION_COPY.accepted("Tricketts"), "You have joined Tricketts.");
    assert.ok(!/now open|start using|ready to use/iu.test(INVITATION_COPY.accepted("Tricketts")));
    assert.equal(INVITATION_COPY.declined("Tricketts"), "You turned down the invitation to Tricketts.");
  });

  test("a global administrator is not thereby a member of anything", () => {
    // Nothing on this surface consults the global admin flag, because being one
    // says nothing about any family -- and the routine would refuse anyway.
    const body = withoutComments(read(LIST));
    assert.ok(!body.includes("isGlobalAdmin"));
    assert.ok(!body.includes("is_global_admin"));
  });

  test("the empty state and the loading state both exist and say something useful", () => {
    const list = read(LIST);
    assert.match(list, /role="status" aria-label="Loading your invitations"/u);
    assert.match(list, /<EmptyState/u);
    assert.match(list, /title=\{INVITATION_COPY\.empty\}/u);
    assert.match(INVITATION_COPY.emptyBody, /email address you sign in with/iu,
      "the empty state has to say why an invitation might not have arrived");
  });
});
