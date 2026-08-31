/**
 * THE FAMILY-ADMIN SIDE OF A FAMILY INVITATION (roadmap Phase 5A).
 *
 * `scripts/family-invitations.test.mjs` runs migration 053's DATABASE half
 * against a real PostgreSQL. This file is about the runtime that sits on top of
 * it -- the one press an administrator makes, and the one thing they must not
 * learn while making it.
 *
 * THE REQUIREMENT, IN ONE SENTENCE. A family administrator may invite any
 * address they can type; they may not find out whether that address already has
 * a Gift Planner account. Every assertion below is either that requirement or a
 * consequence of it.
 *
 * WHY THE INTERESTING TESTS ARE REAL AND NOT REGEXES. `src/lib/family-
 * invitations.ts` holds no client, no key and no session: the four privileged
 * things it needs are passed in. So the branch can be CHOSEN by a fake and the
 * actual decision run for real -- including the two success responses being
 * compared field for field, which is the proof that matters most and is the one
 * a source-reading test cannot make. The source-reading tests that remain are
 * about shapes that must NOT exist anywhere, which is the other thing a
 * behavioural test cannot prove.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const {
  ACCESS_RESTORED,
  INVITATION_CREATED,
  INVITATION_NOT_FINISHED,
  classifySetupEmailError,
  issueFamilyInvitation,
} = await import("../src/lib/family-invitations.ts");

const {
  AREA_ACCESS_LABELS,
  areaAccessStatus,
  canGrantAccess,
  canReissueInvitation,
  canRevokeAccess,
  isAdminSeat,
} = await import("../src/lib/family-access.ts");

/** Git stores LF and checks out CRLF, so normalise before matching anything. */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
/** The same source with its commentary removed: prose about a rule is not a breach of it. */
const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

function sourceFiles(relative = "src") {
  const found = [];
  for (const entry of readdirSync(new URL(`../${relative}`, import.meta.url), { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...sourceFiles(`${relative}/${entry.name}`));
    else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) found.push(`${relative}/${entry.name}`);
  }
  return found;
}

const ROUTE = "src/app/api/admin/family-access/route.ts";
const SCREEN = "src/app/more/family-access/family-access-client.tsx";
const RUNTIME = "src/lib/family-invitations.ts";
const MIGRATION = "supabase/migrations/202608100053_family_invitation_consent.sql";

const PERSON = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** A row of `list_area_access()`, in the shape the routine really returns. */
const seat = (over = {}) => ({
  person_id: PERSON,
  person_name: "Sam",
  app_member_id: null,
  email: null,
  role: null,
  active: null,
  claimed: null,
  account_status: null,
  email_confirmed: null,
  declined_at: null,
  ...over,
});

/**
 * The four privileged closures, faked.
 *
 * `grantAccess` MUTATES THE ROW THE WAY `grant_area_access` DOES -- it sets the
 * address, switches the seat on, clears `declined_at`, and NEVER writes
 * `user_id`. That last omission is the invariant several tests below read back
 * out of the row afterwards, so the fake has to be faithful about it rather
 * than convenient.
 */
function harness(options = {}) {
  const rows = options.rows ?? [seat()];
  const calls = { grants: [], deliveries: [], emails: [] };

  const deps = {
    listAccess: async () => rows.map((row) => ({ ...row })),
    grantAccess: async (personId, email) => {
      calls.grants.push({ personId, email });
      if (options.grantThrows) throw options.grantThrows;
      const row = rows.find((candidate) => candidate.person_id === personId);
      row.app_member_id = row.app_member_id ?? "seat-1";
      row.email = email;
      row.role = row.role ?? "member";
      row.active = true;
      row.declined_at = null;
      // `user_id` -- and therefore `claimed` -- is untouched, exactly as the
      // routine leaves it. Only `accept_family_invitation` attaches a login.
    },
    recordDelivery: async (personId, outcome) => {
      calls.deliveries.push({ personId, outcome });
      if (options.recordThrows) throw new Error("audit refused");
    },
    sendSetupEmail: async (email) => {
      calls.emails.push(email);
      return options.setupEmail ?? { kind: "sent" };
    },
  };

  return { deps, calls, rows };
}

const invite = (harnessed, over = {}) =>
  issueFamilyInvitation(harnessed.deps, { personId: PERSON, email: "sam@example.com", ...over });

// ---------------------------------------------------------------------------
// 1. The existing-account branch
// ---------------------------------------------------------------------------

describe("an address that ALREADY has a Gift Planner account", () => {
  const existing = () => harness({ setupEmail: { kind: "already-registered" } });

  test("the invitation is created, and it is an invitation and not a membership", async () => {
    const world = existing();
    const result = await invite(world);

    assert.equal(result.ok, true);
    assert.deepEqual(world.calls.grants, [{ personId: PERSON, email: "sam@example.com" }]);

    const row = world.rows[0];
    assert.equal(row.app_member_id, "seat-1", "an unclaimed seat exists");
    assert.equal(row.active, true);
    assert.equal(row.declined_at, null);
    assert.notEqual(row.claimed, true, "NO LOGIN IS ATTACHED -- only the invitee may do that");
    assert.equal(areaAccessStatus(row), "invited");
  });

  test("NO SIGNUP OR SETUP EMAIL IS SENT", async () => {
    /*
     * The attempt is how the branch is discovered, and `inviteUserByEmail`
     * refuses an already-registered address BEFORE it sends anything -- which
     * is why the fake answers `already-registered` rather than `sent`. The
     * invitee has a way in already; the offer waits for them inside the app.
     */
    const world = existing();
    await invite(world);
    assert.deepEqual(world.calls.emails, ["sam@example.com"], "one attempt, and it was refused");
    assert.equal((await world.deps.sendSetupEmail("sam@example.com")).kind, "already-registered");
  });

  test("the administrator gets the neutral sentence, and only that", async () => {
    const result = await invite(existing());
    assert.deepEqual(result, { ok: true, status: 200, message: INVITATION_CREATED });
    assert.equal(INVITATION_CREATED, "Invitation created.");
  });

  test("nothing in the answer reveals that the account existed", async () => {
    const result = await invite(existing());
    const serialised = JSON.stringify(result).toLowerCase();
    for (const leak of ["exist", "already", "registered", "sign up", "signup", "account", "email"]) {
      assert.ok(!serialised.includes(leak), `the answer must not mention "${leak}"`);
    }
  });

  test("the delivery audit records the branch-blind word", async () => {
    const world = existing();
    await invite(world);
    assert.deepEqual(world.calls.deliveries, [{ personId: PERSON, outcome: "ready" }]);
  });
});

// ---------------------------------------------------------------------------
// 2. The no-account branch
// ---------------------------------------------------------------------------

describe("an address with NO Gift Planner account", () => {
  const fresh = () => harness({ setupEmail: { kind: "sent" } });

  test("the invitation is created and stays unclaimed", async () => {
    const world = fresh();
    const result = await invite(world);

    assert.equal(result.ok, true);
    const row = world.rows[0];
    assert.equal(row.app_member_id, "seat-1");
    assert.notEqual(row.claimed, true, "no membership is activated by inviting");
    assert.equal(areaAccessStatus(row), "invited");
  });

  test("the account-setup email path IS called", async () => {
    const world = fresh();
    await invite(world);
    assert.deepEqual(world.calls.emails, ["sam@example.com"]);
  });

  test("and the delivery audit is recorded safely", async () => {
    const world = fresh();
    await invite(world);
    assert.deepEqual(world.calls.deliveries, [{ personId: PERSON, outcome: "ready" }]);
  });
});

// ---------------------------------------------------------------------------
// 3. Enumeration resistance -- the point of the whole phase
// ---------------------------------------------------------------------------

describe("the two branches are indistinguishable from outside", () => {
  test("THE SUCCESSFUL ANSWERS ARE EQUAL FIELD FOR FIELD", async () => {
    /*
     * THE ASSERTION THIS FILE EXISTS FOR. Not "both say ok", not "both are
     * 200" -- equal, as objects and as serialised bodies. A second sentence, an
     * extra field, a different status, and this fails.
     */
    const withAccount = await invite(harness({ setupEmail: { kind: "already-registered" } }));
    const withoutAccount = await invite(harness({ setupEmail: { kind: "sent" } }));

    assert.deepEqual(withAccount, withoutAccount);
    assert.equal(JSON.stringify(withAccount), JSON.stringify(withoutAccount));
  });

  test("and both leave a row the screen reads as `Invitation pending`", async () => {
    const withAccount = harness({ setupEmail: { kind: "already-registered" } });
    const withoutAccount = harness({ setupEmail: { kind: "sent" } });
    await invite(withAccount);
    await invite(withoutAccount);

    assert.deepEqual(withAccount.rows[0], withoutAccount.rows[0], "the seats are identical too");
    assert.equal(areaAccessStatus(withAccount.rows[0]), "invited");
    assert.equal(AREA_ACCESS_LABELS.invited, "Invitation pending");
  });

  test("and the audit entry is the same word for both", async () => {
    const withAccount = harness({ setupEmail: { kind: "already-registered" } });
    const withoutAccount = harness({ setupEmail: { kind: "sent" } });
    await invite(withAccount);
    await invite(withoutAccount);
    assert.deepEqual(withAccount.calls.deliveries, withoutAccount.calls.deliveries);
  });

  test("THE OLD ACCOUNT-DISTINGUISHING LABELS ARE GONE FROM THE APPLICATION", () => {
    /*
     * "Awaiting sign-up" meant "this address has no account", and it was on a
     * badge. "Invitation sent" would mean the same thing from the other side.
     * Neither may be a state, a label, a filter or a summary tile.
     */
    assert.ok(!Object.values(AREA_ACCESS_LABELS).includes("Awaiting sign-up"));
    assert.ok(!Object.keys(AREA_ACCESS_LABELS).includes("awaiting_signup"));
    for (const file of sourceFiles()) {
      const body = withoutComments(read(file));
      assert.ok(!body.includes("awaiting_signup"), `${file} still knows the old state`);
      assert.ok(!body.includes("Awaiting sign-up"), `${file} still shows the old label`);
      assert.ok(!body.includes("Invitation sent"), `${file} still shows a delivery-revealing label`);
    }
  });

  test("the browser cannot ask Auth anything at all", () => {
    const screen = withoutComments(read(SCREEN));
    assert.ok(!screen.includes("auth.admin"), "the Admin API is not reachable from a browser bundle");
    assert.ok(!screen.includes("listUsers"));
    assert.ok(!screen.includes("inviteUserByEmail"));
    assert.ok(!screen.includes("generateLink"));
    // And the branch is never named in anything the browser can read.
    assert.ok(!screen.includes("already-registered"));
    assert.ok(!screen.includes("email_exists"));
  });

  test("NO PROJECT-WIDE AUTH ENUMERATION IS REINTRODUCED, ANYWHERE", () => {
    for (const file of sourceFiles()) {
      const body = withoutComments(read(file));
      assert.ok(!body.includes("listAllAuthUsers"), `${file} must not resurrect the deleted helper`);
      assert.ok(!body.includes("listUsers"), `${file} must not enumerate Auth accounts`);
    }
  });

  test("the private branch is taken from the invite attempt, not from a lookup", () => {
    const route = withoutComments(read(ROUTE));
    assert.match(route, /inviteUserByEmail/u, "the attempt is the branch");
    assert.ok(!route.includes("getUserByEmail"));
    assert.ok(!route.includes("getUserById"), "no seat-to-account lookup is needed any more");
    // The classification never leaves the server: the browser is sent a
    // message, and the message is a constant.
    assert.ok(!route.includes("kind: \"already-registered\""));
  });

  test("classifying the Auth refusal covers every shape GoTrue sends", () => {
    assert.equal(classifySetupEmailError({ code: "email_exists", status: 422 }).kind, "already-registered");
    assert.equal(classifySetupEmailError({ status: 422, message: "" }).kind, "already-registered");
    assert.equal(
      classifySetupEmailError({ status: 400, message: "A user with this email address has already been registered" }).kind,
      "already-registered",
    );
    // A rate limit or an unallowlisted redirect is NOT an existing account, and
    // guessing that it is would silently skip an email somebody is waiting for.
    assert.equal(classifySetupEmailError({ status: 429, message: "rate limit exceeded" }).kind, "failed");
    assert.equal(classifySetupEmailError({ status: 500, message: "boom" }).kind, "failed");
    assert.equal(classifySetupEmailError(null).kind, "sent");
  });
});

// ---------------------------------------------------------------------------
// 4. Decline, and inviting again
// ---------------------------------------------------------------------------

describe("a declined invitation can be asked again", () => {
  const declined = () => harness({
    rows: [seat({
      app_member_id: "seat-1",
      email: "sam@example.com",
      role: "member",
      active: false,
      claimed: false,
      declined_at: "2026-08-30T10:00:00Z",
    })],
  });

  test("`declined_at` is the state, and it is not `revoked`", () => {
    const row = declined().rows[0];
    assert.equal(areaAccessStatus(row), "declined");
    assert.equal(AREA_ACCESS_LABELS.declined, "Declined");
    assert.ok(canGrantAccess(row), "a declined seat may be invited again");
    assert.ok(canReissueInvitation(row));
  });

  test("reissuing clears the decline and leaves an OPEN INVITATION", async () => {
    const world = declined();
    const result = await invite(world);

    assert.equal(result.ok, true);
    const row = world.rows[0];
    assert.equal(row.declined_at, null, "the decline is cleared");
    assert.equal(row.active, true);
    assert.notEqual(row.claimed, true, "NO MEMBERSHIP IS CREATED -- they must accept again");
    assert.equal(areaAccessStatus(row), "invited");
  });

  test("and it is just as neutral the second time", async () => {
    const withAccount = declined();
    withAccount.deps.sendSetupEmail = async () => ({ kind: "already-registered" });
    const first = await invite(withAccount);
    const second = await invite(harness({ setupEmail: { kind: "sent" } }));
    assert.deepEqual(first, second);
    assert.equal(AREA_ACCESS_LABELS.invited, "Invitation pending");
  });
});

// ---------------------------------------------------------------------------
// 5. Authorization, and the seat that is not for sale
// ---------------------------------------------------------------------------

describe("the acting Area decides, and the administrator's own seat is protected", () => {
  test("a person in another family is simply absent, and reads as not found", async () => {
    /*
     * `list_area_access()` TAKES NO AREA PARAMETER, so this is not a filter
     * that could be forgotten -- it is the absence of anything to point
     * elsewhere. A person in Area B is not in Area A's answer, and the runtime
     * refuses an id it cannot see with the same 404 an id that names nobody
     * gets.
     */
    const world = harness();
    const result = await issueFamilyInvitation(world.deps, { personId: OTHER, email: "sam@example.com" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.deepEqual(world.calls.grants, [], "nothing was written");
    assert.deepEqual(world.calls.emails, [], "and nothing was sent");
  });

  test("THE PROTECTED FAMILY-ADMIN SEAT CANNOT BE INVITED OVER", async () => {
    const world = harness({
      rows: [seat({ app_member_id: "seat-1", email: "boss@example.com", role: "admin", active: true, claimed: true, account_status: "approved", email_confirmed: true })],
    });
    const result = await issueFamilyInvitation(world.deps, { personId: PERSON, email: "someone@example.com" });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.deepEqual(world.calls.grants, [], "the grant is never even attempted");
    assert.deepEqual(world.calls.emails, []);

    const row = world.rows[0];
    assert.ok(isAdminSeat(row));
    assert.ok(!canGrantAccess(row), "and the screen offers no control for it either");
    assert.ok(!canRevokeAccess(row));
    assert.ok(!canReissueInvitation(row));
  });

  test("and the database refuses it a second time, which is the one that counts", () => {
    const migration = read(MIGRATION);
    assert.match(
      migration,
      /if seat\.id is not null and seat\.role = 'admin' then\n\s+raise exception/u,
      "grant_area_access refuses the administrator's own seat",
    );
    assert.match(migration, /or seat\.role = 'admin' then\n\s+raise exception 'That family member has no open invitation'/u);
  });

  test("EVERY ROUTINE IN THIS FLOW AUTHORISES ITSELF, AND THE ROUTE USES THE ADMIN'S OWN SESSION", () => {
    const route = withoutComments(read(ROUTE));
    /*
     * THE WHOLE POINT. `grant_area_access`, `record_invitation_delivery` and
     * `list_area_access` are SECURITY DEFINER routines that check
     * `require_acting_area` and `is_area_admin` from `auth.uid()`. Calling them
     * with the SERVICE ROLE would remove the only thing checking them, because
     * the service role has no `auth.uid()` and bypasses both row level security
     * and migration 037's write barrier.
     */
    for (const rpc of ["grant_area_access", "record_invitation_delivery", "list_area_access"]) {
      assert.match(route, new RegExp(`session\\.rpc\\("${rpc}"`, "u"), `${rpc} must run as the administrator`);
      assert.ok(!new RegExp(`admin\\.rpc\\("${rpc}"`, "u").test(route), `${rpc} must never run as the service role`);
    }
    // The service role is down to Auth, and reads no table at all.
    assert.ok(!route.includes("admin.from("), "the service role reads no table here");
    for (const mutator of [".insert(", ".update(", ".upsert(", ".delete("]) {
      assert.ok(!route.includes(mutator), `the route must not ${mutator}`);
    }

    const migration = read(MIGRATION);
    for (const routine of ["grant_area_access", "record_invitation_delivery"]) {
      const body = migration.slice(migration.indexOf(`create or replace function public.${routine}`));
      assert.match(body.slice(0, 4000), /perform public\.require_acting_area\(target_area\);/u);
      assert.match(body.slice(0, 4000), /if not public\.is_area_admin\(target_area\) then/u);
    }
  });

  test("an ordinary member and a Gift Planner administrator are both refused at the door", () => {
    const gate = withoutComments(read("src/utils/supabase/family-access-admin.ts"));
    // The role is read from the membership in the family ON SCREEN. Being a
    // global administrator is not a family role, and is not consulted here.
    assert.match(gate, /member\.role !== "admin"/u);
    assert.match(gate, /!member\.active/u);
    assert.ok(!gate.includes("is_global_admin"), "global administration is not a family role");
    assert.match(gate, /const areaId = \(member\.area_id as string \| null\) \?\? null;/u);
  });
});

// ---------------------------------------------------------------------------
// 6. The failure paths
// ---------------------------------------------------------------------------

describe("when something goes wrong, nothing is activated and nothing is disclosed", () => {
  test("an invalid address is refused BEFORE anything is written or sent", async () => {
    const world = harness();
    const result = await issueFamilyInvitation(world.deps, { personId: PERSON, email: "not-an-address" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.deepEqual(world.calls.grants, []);
    assert.deepEqual(world.calls.emails, []);
    assert.deepEqual(world.calls.deliveries, []);
  });

  test("a collision is deterministic: the database refuses, and nothing else happens", async () => {
    /*
     * The unique index on `(area_id, lower(email))` is what stops two people in
     * one family sharing a login, and `grant_area_access` says so out loud
     * rather than letting a constraint name reach the screen. The runtime does
     * not swallow it, and -- because the grant comes first -- no email is sent
     * for an invitation that was never created.
     */
    const refusal = Object.assign(new Error("Somebody else in this family already uses that email address"), { code: "23505" });
    const world = harness({ grantThrows: refusal });
    await assert.rejects(() => invite(world), /already uses that email address/u);
    assert.deepEqual(world.calls.emails, []);
    assert.deepEqual(world.calls.deliveries, []);
  });

  test("A FAILED SEND DOES NOT ACTIVATE A MEMBERSHIP, and leaves the invitation standing", async () => {
    const world = harness({ setupEmail: { kind: "failed" } });
    const result = await invite(world);

    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    const row = world.rows[0];
    assert.equal(row.app_member_id, "seat-1", "the invitation exists and is not lost");
    assert.equal(row.active, true);
    assert.notEqual(row.claimed, true, "and nobody was joined to the family by a broken mailbox");
    assert.equal(areaAccessStatus(row), "invited");
  });

  test("and it is recorded as `undelivered`, which is the only honest word", async () => {
    const world = harness({ setupEmail: { kind: "failed" } });
    await invite(world);
    assert.deepEqual(world.calls.deliveries, [{ personId: PERSON, outcome: "undelivered" }]);
  });

  test("THE FAILURE SENTENCE NAMES NEITHER THE BRANCH NOR THE MECHANISM", async () => {
    /*
     * Only the no-account branch can fail to send, so a message mentioning
     * email, sending or accounts would be the oracle the success path is so
     * careful about, arrived at the long way round. A refused audit write gets
     * the SAME sentence, so the two cannot be told apart from outside either.
     */
    const sendFailed = await invite(harness({ setupEmail: { kind: "failed" } }));
    const auditFailed = await invite(harness({ recordThrows: true }));
    assert.deepEqual(sendFailed, auditFailed);
    assert.equal(sendFailed.message, INVITATION_NOT_FINISHED);

    const words = INVITATION_NOT_FINISHED.toLowerCase();
    for (const leak of ["email", "account", "sign up", "signup", "register", "exist", "smtp", "supabase"]) {
      assert.ok(!words.includes(leak), `the failure must not mention "${leak}"`);
    }
    assert.match(INVITATION_NOT_FINISHED, /invitation was created/iu, "but it must say the invitation is real");
  });

  test("retrying after a failure succeeds, and is still neutral", async () => {
    const world = harness({ setupEmail: { kind: "failed" } });
    await invite(world);

    world.deps.sendSetupEmail = async (email) => { world.calls.emails.push(email); return { kind: "sent" }; };
    const retried = await invite(world);

    assert.deepEqual(retried, { ok: true, status: 200, message: INVITATION_CREATED });
    assert.deepEqual(world.calls.deliveries.at(-1), { personId: PERSON, outcome: "ready" });
    assert.notEqual(world.rows[0].claimed, true, "a retry never attaches a login either");
  });

  test("neither the setup link nor the token nor the address reaches a log line", () => {
    const route = read(ROUTE);
    for (const logged of route.matchAll(/console\.(error|warn|log|info)\(([\s\S]*?)\n\s*\);/gu)) {
      const line = logged[2];
      assert.ok(!/\bemail\b/u.test(line), `a log line must not carry the address: ${line.trim()}`);
      assert.ok(!/action_link|properties|token|redirectTo/u.test(line), `a log line must not carry a link: ${line.trim()}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The seat that already has a login, and the audit vocabulary
// ---------------------------------------------------------------------------

describe("restoring a claimed seat is a different act, and says so", () => {
  test("no email is sent and no delivery is recorded for a seat with a login on it", async () => {
    /*
     * This is NOT a branch on account existence. `claimed` is a fact about a
     * row inside the administrator's own family, already on their screen,
     * placed there by `list_area_access`. And `record_invitation_delivery`
     * would refuse it anyway: it records OPEN INVITATIONS only.
     */
    const world = harness({
      rows: [seat({ app_member_id: "seat-1", email: "sam@example.com", role: "member", active: false, claimed: true, account_status: "approved", email_confirmed: true })],
    });
    const result = await invite(world);

    assert.deepEqual(result, { ok: true, status: 200, message: ACCESS_RESTORED });
    assert.deepEqual(world.calls.grants, [{ personId: PERSON, email: "sam@example.com" }]);
    assert.deepEqual(world.calls.emails, []);
    assert.deepEqual(world.calls.deliveries, []);
  });

  test("the audit vocabulary is the migration's, closed and branch-blind", async () => {
    const world = harness();
    await invite(world);
    for (const entry of world.calls.deliveries) {
      assert.ok(["ready", "undelivered"].includes(entry.outcome), "053 accepts these two words and no others");
    }
    const migration = read(MIGRATION);
    assert.match(migration, /p_outcome not in \('ready', 'undelivered'\)/u);
    // And the runtime writes no audit row of its own.
    assert.ok(!withoutComments(read(ROUTE)).includes("audit_log"));
    assert.ok(!withoutComments(read(RUNTIME)).includes("audit_log"));
  });
});

// ---------------------------------------------------------------------------
// 8. The screen
// ---------------------------------------------------------------------------

describe("Family Access, as the administrator sees it", () => {
  const screen = read(SCREEN);

  test("inviting is ONE press, and it goes through the trusted boundary", () => {
    assert.match(screen, /action: "invite"/u);
    assert.match(screen, /"\/api\/admin\/family-access"/u);
    // The grant left the browser with the invitation, because delivery has to
    // happen in the same act or the two-step is an oracle again.
    assert.ok(!withoutComments(screen).includes('rpc("grant_area_access"'),
      "the grant is part of the invitation now, not a separate browser call");
    // Everything that needs no Auth is still the caller's own session.
    assert.match(screen, /rpc\("list_area_access"\)/u);
    assert.match(screen, /rpc\("revoke_area_access"/u);
    assert.match(screen, /rpc\("set_family_contributor"/u);
  });

  test("the two removed actions are removed from the route as well as the screen", () => {
    const route = read(ROUTE);
    assert.match(route, /const actions = new Set<Action>\(\["invite", "copy-reset-link"\]\);/u);
    for (const gone of ["send-invite", "copy-setup-link"]) {
      assert.ok(!withoutComments(screen).includes(gone), `${gone} must not be reachable from the screen`);
      assert.ok(!withoutComments(route).includes(`"${gone}"`), `${gone} must not be an action`);
    }
  });

  test("the six states, and the one word each of them shows", () => {
    assert.deepEqual(AREA_ACCESS_LABELS, {
      no_access: "No access",
      invited: "Invitation pending",
      awaiting_global_approval: "Waiting for Gift Planner approval",
      active: "Active",
      declined: "Declined",
      revoked: "Revoked",
    });
    assert.equal(areaAccessStatus(seat()), "no_access");
    assert.equal(areaAccessStatus(seat({ app_member_id: "m", active: true, claimed: false })), "invited");
    assert.equal(areaAccessStatus(seat({ app_member_id: "m", active: false, declined_at: "2026-01-01" })), "declined");
    assert.equal(areaAccessStatus(seat({ app_member_id: "m", active: false, claimed: true })), "revoked");
    assert.equal(areaAccessStatus(seat({ app_member_id: "m", active: true, claimed: true, account_status: "pending" })), "awaiting_global_approval");
    assert.equal(areaAccessStatus(seat({ app_member_id: "m", active: true, claimed: true, account_status: "approved", email_confirmed: true })), "active");
  });

  test("DECLINED IS ASKED BEFORE REVOKED, or every decline reads as the admin's doing", () => {
    // 053's CHECK constraint makes a declined row `active = false` too, so the
    // order of the questions is the whole of the distinction.
    const row = seat({ app_member_id: "m", active: false, claimed: false, declined_at: "2026-01-01" });
    assert.equal(areaAccessStatus(row), "declined");
  });

  test("every state the screen can draw has a sentence and a tone", () => {
    for (const status of Object.keys(AREA_ACCESS_LABELS)) {
      assert.match(screen, new RegExp(`^\\s+${status}: "`, "mu"), `${status} needs a badge tone`);
    }
    assert.match(screen, /value: "invited", label: AREA_ACCESS_LABELS\.invited/u);
    assert.match(screen, /value: "declined", label: AREA_ACCESS_LABELS\.declined/u);
    assert.match(screen, /<Summary label="Invitation pending" value=\{counts\.invited\} \/>/u);
  });

  test("and the action labels never guess which branch an invitation took", () => {
    const drawn = withoutComments(screen);
    assert.match(drawn, /"Invite again"/u);
    assert.ok(!drawn.includes("Resend the email"));
    assert.ok(!drawn.includes("Copy setup link"));
  });
});
