/**
 * THE RUNTIME SIDE OF MIGRATION 052.
 *
 * `scripts/global-approval.test.mjs` runs the DATABASE half against a real
 * PostgreSQL: it signs unapproved accounts in and counts what they can see.
 * This file is about the half that lives in this repository -- where each
 * answer leads, what the screens say, and which modules are allowed to know
 * about a family at all.
 *
 * TWO KINDS OF TEST HERE, AND THE FIRST KIND IS WHY THE DECISION IS A PURE
 * FUNCTION. `src/lib/account-status.ts` imports nothing, so the plain runner
 * can call `destinationFor` and `accountStatusFrom` for real -- the actual
 * decision, not a regex over the file that contains it. The rest read source,
 * because Server Components and route handlers need a live Supabase and a
 * browser to run, and what source CAN prove is that the wiring exists and that
 * the dangerous shapes do not.
 *
 * NOTHING BELOW IS THE SECURITY BOUNDARY, and that is worth saying at the top
 * so nobody reads a passing suite as one. `app_accounts` has no privilege for
 * `anon` or `authenticated` and zero policies; every gated routine re-asks
 * `is_globally_approved()` or `is_global_admin()` for itself. These tests are
 * about the app not sending people to the wrong screen, and about it not
 * growing a second way to ask the question.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const {
  ACCOUNT_STATES,
  ACCOUNT_PENDING_PATH,
  ACCOUNT_REJECTED_PATH,
  AUTH_ROUTES,
  CHECK_EMAIL_PATH,
  GLOBAL_ADMIN_PATH,
  GLOBAL_ROUTES,
  HOME_PATH,
  LOGIN_PATH,
  SIGNED_OUT,
  accountStatusFrom,
  appEntryDestinationFor,
  destinationFor,
  isAuthRoute,
  isBareRoute,
  isGlobalRoute,
  isRefused,
} = await import("../src/lib/account-status.ts");

const { areaEntryFor, CREATE_AREA_LABEL, CREATE_AREA_PATH } = await import("../src/lib/areas.ts");

const {
  AREA_ACCESS_EXPLANATIONS,
  AREA_ACCESS_LABELS,
  areaAccessStatus,
  canGrantAccess,
  canRevokeAccess,
  isAdminSeat,
} = await import("../src/lib/family-access.ts");

/** Git stores LF and checks out CRLF, so normalise before matching anything. */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
/** The same source with its commentary removed: prose about a rule is not a breach of it. */
const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

/** Every `.ts`/`.tsx` under `src/`, as repository-relative paths. */
function sourceFiles(relative = "src") {
  const found = [];
  for (const entry of readdirSync(new URL(`../${relative}`, import.meta.url), { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...sourceFiles(`${relative}/${entry.name}`));
    else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) found.push(`${relative}/${entry.name}`);
  }
  return found;
}

/**
 * Every module specifier a file imports, `import` and `export ... from` alike.
 *
 * Deliberately textual. A real resolver would need the bundler's whole
 * configuration; what this needs to know is only "which files can this one
 * reach", and every import in this codebase is a static one.
 */
function importsOf(text) {
  const specifiers = [];
  for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s+["']([^"']+)["']/gu)) {
    specifiers.push(match[1]);
  }
  // A bare side-effect import, e.g. `import "server-only";`.
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/gu)) specifiers.push(match[1]);
  return specifiers;
}

/**
 * A specifier resolved to a file inside `src/`, or `null` for anything else --
 * a package, a stylesheet, or a path that does not exist. `@/x` is the app's
 * alias for `src/x`; the extension list is the one the app itself uses.
 */
function resolveWithin(fromFile, specifier) {
  let base;
  if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) {
    const dir = fromFile.slice(0, fromFile.lastIndexOf("/"));
    base = new URL(specifier, `file:///${dir}/`).pathname.replace(/^\//u, "");
  } else return null;

  base = base.replace(/\.tsx?$/u, "");
  for (const candidate of [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    try {
      readFileSync(new URL(`../${candidate}`, import.meta.url));
      return candidate;
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

const AREA = { id: "area-1", name: "Alpha", archivedAt: null };
const BRAVO = { id: "area-2", name: "Bravo", archivedAt: null };

// ---------------------------------------------------------------------------
// 1. The row, turned into a state
// ---------------------------------------------------------------------------

describe("what the database says about an account, turned into one word", () => {
  test("NO ROW AT ALL MEANS NOBODY IS SIGNED IN", () => {
    // `my_account_status()` is a select against `auth.users` keyed on
    // `auth.uid()`, so an anonymous caller gets zero rows rather than a null
    // status. That is a different thing from a missing `app_accounts` row.
    assert.deepEqual(accountStatusFrom(null), SIGNED_OUT);
    assert.deepEqual(accountStatusFrom(undefined), SIGNED_OUT);
    assert.equal(SIGNED_OUT.state, "signed_out");
  });

  test("A MISSING app_accounts ROW IS `pending`, because undecided is what it is", () => {
    /*
     * FAIL-CLOSED IS THE WHOLE DESIGN. The routine already coalesces a missing
     * row to the string 'pending' precisely so the answer does not depend on
     * whether a row happens to have been written yet -- and this side must
     * agree, or a brand new account would look like something else.
     */
    assert.equal(accountStatusFrom({ status: "pending", is_global_admin: false, email_confirmed: true }).state, "pending");
    // And a row whose status never arrived at all is treated the same way.
    assert.equal(accountStatusFrom({ email_confirmed: true }).state, "pending");
    assert.equal(accountStatusFrom({ status: null, email_confirmed: true }).state, "pending");
  });

  test("AN UNKNOWN STATUS IS `pending` TOO, never approved", () => {
    // The CHECK constraint makes one unreachable today. If a later migration
    // adds a sixth status, an old browser must treat it as undecided.
    assert.equal(accountStatusFrom({ status: "probationary", email_confirmed: true }).state, "pending");
  });

  test("a rejected row is `rejected`, and a suspended one is `suspended`", () => {
    assert.equal(accountStatusFrom({ status: "rejected", email_confirmed: true }).state, "rejected");
    assert.equal(accountStatusFrom({ status: "suspended", email_confirmed: true }).state, "suspended");
    assert.ok(isRefused("rejected"));
    assert.ok(isRefused("suspended"));
    assert.ok(!isRefused("pending"));
    assert.ok(!isRefused("approved"));
  });

  test("REFUSAL BEATS AN UNCONFIRMED ADDRESS, in both directions", () => {
    /*
     * A rejected account with an unconfirmed address must not be told to go and
     * confirm it: that is an instruction leading nowhere, and it would also be
     * a way to find out that the refusal exists. The order of the questions is
     * the whole of this test.
     */
    assert.equal(accountStatusFrom({ status: "rejected", email_confirmed: false }).state, "rejected");
    assert.equal(accountStatusFrom({ status: "suspended", email_confirmed: false }).state, "suspended");
    // Whereas an undecided account with an unconfirmed address has something to do.
    assert.equal(accountStatusFrom({ status: "pending", email_confirmed: false }).state, "email_unverified");
    // And so does one somebody has approved but whose address is somehow unconfirmed --
    // `set_account_status` refuses that combination, and this stays fail-closed anyway.
    assert.equal(accountStatusFrom({ status: "approved", email_confirmed: false }).state, "email_unverified");
  });

  test("THE GLOBAL-ADMIN FLAG IS CLEARED FOR ANYBODY NOT APPROVED", () => {
    /*
     * The database makes this unreachable on its own --
     * `app_accounts_admin_must_be_approved` refuses an unapproved administrator
     * even by direct SQL -- and it is restated here so a stale or hand-edited
     * payload cannot light up `/admin/accounts` in a browser.
     */
    assert.equal(accountStatusFrom({ status: "approved", is_global_admin: true, email_confirmed: true }).isGlobalAdmin, true);
    for (const status of ["pending", "rejected", "suspended"]) {
      assert.equal(accountStatusFrom({ status, is_global_admin: true, email_confirmed: true }).isGlobalAdmin, false,
        `a ${status} account must never read as a Gift Planner administrator`);
    }
    assert.equal(accountStatusFrom({ status: "approved", is_global_admin: true, email_confirmed: false }).isGlobalAdmin, false,
      "and neither may an unconfirmed one");
  });

  test("there are six states, and the list is closed", () => {
    assert.deepEqual([...ACCOUNT_STATES],
      ["signed_out", "email_unverified", "pending", "approved", "rejected", "suspended"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Where each state leads
// ---------------------------------------------------------------------------

describe("where each state may be, and where it is sent instead", () => {
  test("signed out: the auth routes, and nowhere else", () => {
    for (const route of AUTH_ROUTES) {
      assert.equal(destinationFor("signed_out", route), null, `${route} must be reachable signed out`);
    }
    for (const route of ["/", "/people", "/settings", GLOBAL_ADMIN_PATH, ACCOUNT_PENDING_PATH]) {
      assert.equal(destinationFor("signed_out", route), LOGIN_PATH);
    }
  });

  test("the public front door is one of them", () => {
    // The whole point of this phase: `/sign-up` is reachable by somebody with
    // no account at all.
    assert.ok(AUTH_ROUTES.includes("/sign-up"));
    assert.equal(destinationFor("signed_out", "/sign-up"), null);
  });

  test("unverified: the four screens that are steps of confirming, and no further", () => {
    /*
     * Every one of these is reached from a link in an email, so bouncing them
     * to `/check-email` would break the very journey that ends the state.
     */
    for (const route of [CHECK_EMAIL_PATH, "/account-setup", "/reset-password", "/auth/callback"]) {
      assert.equal(destinationFor("email_unverified", route), null, `${route} is part of confirming`);
    }
    for (const route of ["/", "/login", "/sign-up", GLOBAL_ADMIN_PATH]) {
      assert.equal(destinationFor("email_unverified", route), CHECK_EMAIL_PATH);
    }
  });

  test("pending: `/account-pending`, and it stays there", () => {
    assert.equal(destinationFor("pending", ACCOUNT_PENDING_PATH), null, "no redirect loop");
    for (const route of ["/", "/login", "/people", GLOBAL_ADMIN_PATH, ACCOUNT_REJECTED_PATH]) {
      assert.equal(destinationFor("pending", route), ACCOUNT_PENDING_PATH);
    }
  });

  test("REJECTED AND SUSPENDED SHARE ONE DESTINATION, on purpose", () => {
    /*
     * They are distinct in the catalogue -- one is a decision about a new
     * account, the other about an established one -- and telling them apart on
     * screen would let somebody probe which was taken about them. Neither
     * answer is any use to the person reading it.
     */
    for (const state of ["rejected", "suspended"]) {
      assert.equal(destinationFor(state, ACCOUNT_REJECTED_PATH), null, "no redirect loop");
      for (const route of ["/", "/login", "/people", GLOBAL_ADMIN_PATH, ACCOUNT_PENDING_PATH]) {
        assert.equal(destinationFor(state, route), ACCOUNT_REJECTED_PATH);
      }
    }
  });

  test("APPROVED WITH NO FAMILY IS NEVER SENT BACK TO THE SIGN-IN FORM", () => {
    /*
     * THE DEFECT THIS WHOLE PHASE EXISTS TO REMOVE. Sign-in, the auth callback
     * and account setup each read `app_members`, found nothing, and signed the
     * account out. A brand new account has no membership BY DEFINITION, so
     * everybody who ever signed up would have confirmed their address and been
     * thrown out for it.
     *
     * `destinationFor` cannot express that: `approved` has no refusal branch at
     * all, and `/` -- where the onboarding is -- is somewhere it may stay.
     */
    assert.equal(destinationFor("approved", HOME_PATH), null);
    assert.equal(destinationFor("approved", "/areas/new"), null);
    assert.notEqual(destinationFor("approved", HOME_PATH), LOGIN_PATH);
    for (const route of ["/people", "/settings", "/more/family-access", GLOBAL_ADMIN_PATH]) {
      assert.equal(destinationFor("approved", route), null);
    }
  });

  test("and is shown the app rather than the way into it", () => {
    // Somebody signed in has no business on the sign-in form, the sign-up form,
    // or either explanation screen.
    for (const route of [LOGIN_PATH, "/sign-up", CHECK_EMAIL_PATH, ACCOUNT_PENDING_PATH, ACCOUNT_REJECTED_PATH]) {
      assert.equal(destinationFor("approved", route), HOME_PATH);
    }
    // But a password link is still a password link.
    assert.equal(destinationFor("approved", "/account-setup"), null);
    assert.equal(destinationFor("approved", "/reset-password"), null);
  });

  test("the app-entry question is the same question, asked without a path", () => {
    /*
     * `FamilyProvider` only ever runs on routes that carry a family, so it asks
     * "may this account be inside the application at all". Keeping it a
     * separate function is what keeps `pathname` out of the loader's dependency
     * list -- otherwise `getUser`, the status RPC and the membership read would
     * fire on every navigation between ordinary screens.
     */
    for (const state of ACCOUNT_STATES) {
      assert.equal(appEntryDestinationFor(state), destinationFor(state, HOME_PATH));
    }
    assert.equal(appEntryDestinationFor("approved"), null);
    assert.equal(appEntryDestinationFor("pending"), ACCOUNT_PENDING_PATH);
    assert.equal(appEntryDestinationFor("rejected"), ACCOUNT_REJECTED_PATH);
    assert.equal(appEntryDestinationFor("suspended"), ACCOUNT_REJECTED_PATH);
    assert.equal(appEntryDestinationFor("email_unverified"), CHECK_EMAIL_PATH);
    assert.equal(appEntryDestinationFor("signed_out"), LOGIN_PATH);
  });
});

// ---------------------------------------------------------------------------
// 3. Which routes carry no family
// ---------------------------------------------------------------------------

describe("the routes with no family behind them", () => {
  test("the three global routes are recognised, including below themselves", () => {
    /*
     * FOUR SINCE 053. `/invitations` is global for the same reason the other
     * three are, and for one more: an invitation has to be readable by
     * somebody who is NOT IN THE FAMILY YET, so a screen that resolves an
     * acting Area first is a screen they can never open.
     */
    assert.deepEqual([...GLOBAL_ROUTES], [ACCOUNT_PENDING_PATH, ACCOUNT_REJECTED_PATH, GLOBAL_ADMIN_PATH, "/invitations"]);
    for (const route of GLOBAL_ROUTES) {
      assert.ok(isGlobalRoute(route));
      assert.ok(isGlobalRoute(route + "/anything"), "a child of a global route is still global");
      assert.ok(!isAuthRoute(route), "global is not the same as signed-out");
    }
  });

  test("and an ordinary screen is neither", () => {
    for (const route of ["/", "/people", "/settings", "/events/abc", "/more/family-access"]) {
      assert.ok(!isAuthRoute(route));
      assert.ok(!isGlobalRoute(route));
      assert.ok(!isBareRoute(route));
    }
  });

  test("a route that merely starts with the same letters is not one of them", () => {
    // `/admin/accounts-export` would be a different route, and matching it as
    // global would render it with no chrome and no Area for no reason.
    assert.ok(!isGlobalRoute("/admin/accounts-export"));
    assert.ok(!isAuthRoute("/login-help"));
  });

  test("`isBareRoute` is the union, and it is what the frame and the provider both ask", () => {
    for (const route of [...AUTH_ROUTES, ...GLOBAL_ROUTES]) assert.ok(isBareRoute(route));

    const frame = read("src/app/components/app-frame.tsx");
    assert.match(frame, /if \(isBareRoute\(pathname\)\) return <>\{children\}<\/>;/u);
    const provider = read("src/app/family-context.tsx");
    assert.match(provider, /const bareRoute = isBareRoute\(pathname\);/u);
    assert.match(provider, /if \(bareRoute\) \{ setLoading\(false\); return; \}/u,
      "the provider must load nothing at all on a bare route");
    assert.match(provider, /\{ enabled: !bareRoute \}/u, "and subscribe to nothing");
  });

  test("the route tables are written down once, in a module that imports nothing", () => {
    // `nav-items.ts` pulls in lucide's icon components, which the plain runner
    // cannot load -- which is exactly why the lists moved next door and are
    // re-exported from there.
    const navItems = read("src/app/components/nav-items.ts");
    assert.match(navItems, /export \{ AUTH_ROUTES, GLOBAL_ROUTES, isAuthRoute, isBareRoute, isGlobalRoute \};/u);
    assert.ok(!navItems.includes("const AUTH_ROUTES = new Set"), "no second copy of the list");
  });
});

// ---------------------------------------------------------------------------
// 4. The screens each state lands on
// ---------------------------------------------------------------------------

describe("the screens", () => {
  test("`/sign-up` uses the canonical form system and the canonical validation", () => {
    const page = read("src/app/sign-up/page.tsx");
    assert.match(page, /from "\.\.\/components\/auth-card"/u, "the same frame as /login");
    assert.match(page, /<AuthScreen>/u);
    assert.match(page, /<AuthHeading/u);
    assert.match(page, /<Field label="Email address"/u);
    assert.match(page, /<Field\s*\n?\s*label="Password"/u);
    assert.match(page, /label="Confirm password"/u);
    assert.match(page, /validateEmail\(email\)/u, "the one email validator");
    assert.match(page, /maxLength=\{INPUT_LIMITS\.email\}/u, "and the one length limit");
    assert.match(page, /Passwords do not match\./u);
    assert.match(page, /MINIMUM_PASSWORD_LENGTH = 8/u,
      "the same minimum /account-setup already applies");
    assert.match(page, /supabase\.auth\.signUp|db\.auth\.signUp/u);
  });

  test("EVERY SIGN-UP OUTCOME ENDS ON THE SAME SENTENCE", () => {
    /*
     * ENUMERATION RESISTANCE IS THE WHOLE OF THE ERROR HANDLING. A brand new
     * address, an address that already has an account, and one that has never
     * confirmed must be indistinguishable -- a form that answers those three
     * differently is a way to find out who has an account here.
     */
    const page = read("src/app/sign-up/page.tsx");
    assert.match(page, /SIGN_UP_NEUTRAL_SUCCESS = "Check your email to confirm your address\."/u);
    assert.match(page, /description=\{SIGN_UP_NEUTRAL_SUCCESS\}/u, "and that is what is rendered");

    // The refusal branch sets the SAME state the success branch does.
    const refusal = page.slice(page.indexOf("if (result.error)"), page.indexOf("if (result.data.session)"));
    assert.match(refusal, /setSent\(true\);/u, "a refusal shows the neutral confirmation");
    assert.ok(!/setError\(result\.error/u.test(refusal),
      "Supabase's own message distinguishes 'already registered' and must not be forwarded");
    assert.match(refusal, /console\.error/u, "the real reason is logged where only the operator sees it");
  });

  test("and it offers the way back to signing in", () => {
    const page = read("src/app/sign-up/page.tsx");
    assert.match(page, /Already have an account\? Sign in/u);
    assert.match(page, /href="\/login"/u);
  });

  test("`/login` offers the way to creating one, as a real route", () => {
    const page = read("src/app/login/page.tsx");
    assert.match(page, /href="\/sign-up"/u);
    assert.match(page, /Create an account/u);
  });

  test("the pending screen says what is outstanding and who can end it", () => {
    const page = read("src/app/account-pending/page.tsx");
    assert.match(page, /title="Waiting for an admin to approve your account\."/u,
      "the h1 the phase specifies, verbatim");
    // Its four jobs, each of which somebody acts on if it is missing.
    assert.match(page, /email address is confirmed/iu, "1. the confirmation step worked");
    assert.match(page, /Gift Planner administrator/u, "2. and the remaining approval is Gift Planner's");
    assert.match(page, /separate step/iu, "3. joining a family is independent of it");
    // Whitespace-insensitive: the copy is wrapped for reading, not for matching.
    assert.match(page.replace(/\s+/gu, " "), /waiting for you as soon as your account is approved/u,
      "4. and access already granted starts working on approval");
    // What it must NOT say: that a family admin can approve globally.
    assert.ok(!/ask your family/iu.test(page));
    assert.match(page, /import \{ signOut \}/u, "and there is a way out");
    assert.ok(!page.includes("AppShell"), "no app chrome on a global route");
  });

  test("the refused screen names nothing and offers nothing", () => {
    const page = read("src/app/account-rejected/page.tsx");
    const body = withoutComments(page);
    // Neutral: it must not disclose which decision was taken, who took it, or
    // which families the account was in.
    assert.ok(!/rejected|suspended/iu.test(body.replace(/AccountRejectedPage|account-rejected/gu, "")),
      "the screen must not say which decision was taken");
    assert.ok(!/support|contact us|appeal|help@|mailto:/iu.test(body),
      "there is no support desk, so inventing one would be a dead end");
    assert.match(page, /import \{ signOut \}/u, "sign-out is the one control");
    assert.ok(!page.includes("AppShell"));
  });

  test("both refused states share the one screen, which is why there is one", () => {
    assert.equal(appEntryDestinationFor("rejected"), appEntryDestinationFor("suspended"));
  });
});

// ---------------------------------------------------------------------------
// 5. The global admin route, and what it must not drag in
// ---------------------------------------------------------------------------

describe("/admin/accounts", () => {
  const page = read("src/app/admin/accounts/page.tsx");
  const screen = read("src/app/admin/accounts/global-accounts-screen.tsx");

  test("it authorises from the global status, and works with ZERO families", () => {
    assert.match(page, /loadAccountStatus\(\)/u);
    assert.match(page, /destinationFor\(status\.state, "\/admin\/accounts"\)/u);
    assert.match(page, /if \(!status\.isGlobalAdmin\) notFound\(\);/u);
  });

  test("A FAMILY ADMINISTRATOR GETS A 404, NOT A 403", () => {
    // A 403 confirms that the route exists and that there is a queue behind it,
    // to somebody who has just gone looking for one. The CODE, not the
    // commentary: the page has to be able to explain why it answers a 404.
    assert.match(page, /notFound\(\)/u);
    assert.ok(!withoutComments(page).includes("403"));
  });

  test("IT DRAGS IN NO AREA, NO MEMBERSHIP AND NO ACTING AREA", () => {
    /*
     * THE POINT OF THE WHOLE SEPARATION. A Gift Planner administrator with no
     * family must see no gift, no budget, no birthday and no name. Every other
     * route in the app resolves a membership, an acting Area, or both; this one
     * resolves neither.
     *
     * WALKED TRANSITIVELY, not read off the two files. A direct import is easy
     * to notice in review; the way this rule actually breaks is somebody adding
     * a helper that looks harmless and itself imports `getCurrentMember` three
     * modules down. So the whole reachable graph from the page is collected.
     *
     * THE ONE DELIBERATE EXEMPTION IS THE BASE SUPABASE CLIENT, and it is worth
     * stating rather than hiding. `client.ts` and `server.ts` read `AREA_COOKIE`
     * to attach `x-area-id`, so `@/lib/areas` is reachable from anything that
     * talks to the database at all -- which is everything. That header is not a
     * family resolution and cannot become one here: `my_account_status()` and
     * `list_accounts()` take no parameter and consult no acting Area, and
     * `stamp_audit_area` returns early for `app_accounts` and SETS `area_id` to
     * null so a caller standing in a family cannot smuggle a global decision
     * into its log. What is forbidden is anything that RESOLVES a family.
     */
    const ALLOWED_AREA_COOKIE_READERS = new Set([
      // Where the name is DEFINED, reached through the clients below.
      "src/lib/areas.ts",
      // The two base clients, which attach `x-area-id`. See above.
      "src/utils/supabase/client.ts",
      "src/utils/supabase/server.ts",
      /*
       * And the canonical sign-out, which CLEARS the cookie. The admin queue
       * has a sign-out button precisely because a Gift Planner administrator
       * with no family has no account menu to reach -- and clearing the cookie
       * is the one thing sign-out does with an Area. Forgetting a family is not
       * resolving one.
       */
      "src/utils/supabase/sign-out.ts",
    ]);

    const reachable = new Set();
    const walk = (file) => {
      if (reachable.has(file)) return;
      reachable.add(file);
      for (const specifier of importsOf(read(file))) {
        const resolved = resolveWithin(file, specifier);
        if (resolved) walk(resolved);
      }
    };
    walk("src/app/admin/accounts/page.tsx");

    // The screen is reached through the page, so the walk should have found it.
    assert.ok(reachable.has("src/app/admin/accounts/global-accounts-screen.tsx"));

    const forbidden = [
      "src/utils/supabase/current-member.ts",         // the member Area resolver
      "src/utils/supabase/current-member-client.ts",  // and its browser mirror
      "src/utils/supabase/areas-server.ts",           // the acting-Area loader
      "src/utils/supabase/area-choice-client.ts",     // and what writes the choice
      "src/app/family-context.tsx",                   // FamilyProvider
      "src/app/components/use-areas.ts",              // the switcher's list
      "src/app/components/app-shell.tsx",             // TopBar -> AccountMenu -> useFamily
      "src/app/components/account-menu.tsx",
      "src/app/components/icon-rail.tsx",
      "src/app/components/bottom-tabs.tsx",
    ];
    for (const banned of forbidden) {
      assert.ok(!reachable.has(banned),
        `/admin/accounts reaches ${banned} -- it must work for an account with no family at all`);
    }

    const areaCookieReaders = [...reachable].filter((file) => read(file).includes("AREA_COOKIE"));
    assert.deepEqual(areaCookieReaders.filter((file) => !ALLOWED_AREA_COOKIE_READERS.has(file)), [],
      "only the base Supabase clients may know the Area cookie exists");

    assert.ok(!screen.includes("useFamily("), "and the screen must not read the family context");
    assert.ok(!screen.includes("gp_area"), "nor name the cookie itself");

    /*
     * THE POSITIVE CONTROL, without which the walk above could pass by simply
     * not working. Family Access is the same shape of route -- a server page
     * that renders a client screen -- and it genuinely does resolve a family,
     * so the identical walk MUST find one of the forbidden modules there.
     * A resolver that silently returned null for everything would fail here.
     */
    const control = new Set();
    const walkControl = (file) => {
      if (control.has(file)) return;
      control.add(file);
      for (const specifier of importsOf(read(file))) {
        const resolved = resolveWithin(file, specifier);
        if (resolved) walkControl(resolved);
      }
    };
    walkControl("src/app/more/family-access/page.tsx");
    assert.ok(control.has("src/utils/supabase/current-member.ts"),
      "the walk must be capable of finding a family resolver -- it finds none in /admin/accounts");
    assert.ok(reachable.size > 5, "and it must actually traverse the admin route, not stop at its first import");
  });

  test("every read and every write is one of the four routines", () => {
    assert.match(screen, /rpc\("list_accounts", \{ p_status: null \}\)/u);
    assert.match(screen, /rpc\("set_account_status"/u);
    assert.match(screen, /"grant_global_admin" : "revoke_global_admin"/u);
    assert.ok(!withoutComments(screen).includes('from("app_accounts")'),
      "the table is unreadable from a browser");
  });

  test("it offers all five filters, and counts them from the one fetch", () => {
    for (const label of ["Pending", "Approved", "Rejected", "Suspended", "All"]) {
      assert.ok(screen.includes(`label: "${label}" }`), `the ${label} filter must exist`);
    }
    // One `list_accounts` call, filtered in the browser: calling it five times
    // to fill in five counts would be five queries where one already carries
    // every row the counts are made of.
    assert.equal((screen.match(/rpc\("list_accounts"/gu) ?? []).length, 1);
    assert.match(screen, /count=\{counts\[item\.value\]\}/u);
  });

  test("it shows what a decision needs, and no family data at all", () => {
    assert.match(screen, /\{row\.email \?\? "No email on record"\}/u);
    assert.match(screen, /Email confirmed" : "Email not confirmed/u);
    assert.match(screen, /Signed up/u);
    assert.match(screen, /Decided/u);
    assert.match(screen, /row\.decision_note/u);
    /*
     * AND NOT ONE WORD OF FAMILY DATA. `list_accounts` carries none -- no
     * person, no Area, no amount -- so a screen that mentioned any of this
     * would have had to go and fetch it.
     *
     * "Gift" is excluded from the sweep because "Gift Planner" is the product's
     * own name and appears throughout; the words below have no such excuse.
     */
    const body = withoutComments(screen);
    for (const leak of ["budget", "pennies", "birthday", "recipient", "purchase", "area_id", "person_id"]) {
      assert.ok(!new RegExp(leak, "iu").test(body), `the global queue must not mention ${leak}`);
    }
  });

  test("consequential actions confirm first, and the note is bounded", () => {
    assert.match(screen, /<ConfirmDialog/u, "an AlertDialog, which a stray backdrop click cannot dismiss");
    assert.match(screen, /NOTE_LIMIT = 500/u, "the same 500 `set_account_status` enforces");
    assert.match(screen, /maxLength=\{NOTE_LIMIT\}/u);
  });

  test("AN UNCONFIRMED ACCOUNT CANNOT BE APPROVED, and nobody decides their own", () => {
    // Both are refused by `set_account_status` itself; withholding the control
    // is the courtesy, and offering a button that is going to be refused is
    // worse than offering none.
    assert.match(screen, /const canApprove = row\.email_confirmed && row\.status !== "approved" && !isSelf;/u);
    assert.match(screen, /Nobody decides their own account\./u);
  });

  test("standing yourself down is offered, because the database allows exactly that", () => {
    // `revoke_global_admin` refuses only the LAST administrator, so self-revoke
    // is a legitimate thing to do -- and it takes this screen with it.
    assert.match(screen, /Stand down as administrator/u);
    assert.match(screen, /if \(!grant && row\.user_id === self\)/u);
  });

  test("and the route is reachable, for the accounts that may reach it", () => {
    // A 404 is the right refusal and a terrible way to find a screen: without a
    // link the only route to it is knowing the path and typing it.
    const menu = read("src/app/components/account-menu.tsx");
    assert.match(menu, /loadAccountStatusClient\(\)/u);
    assert.match(menu, /\{isGlobalAdmin && \(/u);
    assert.match(menu, /href=\{GLOBAL_ADMIN_PATH\}/u);
    // And it is NOT the family admin flag beside it, which is a different question.
    assert.match(menu, /const \{ isAdmin \} = useFamily\(\);/u);
  });
});

// ---------------------------------------------------------------------------
// 6. The front door: nought, one and many families
// ---------------------------------------------------------------------------

describe("what the front door renders", () => {
  test("NO FAMILY IS ONBOARDING, and it is a legitimate state", () => {
    assert.equal(areaEntryFor([], null), "onboarding");
    assert.equal(areaEntryFor([], "area-1"), "onboarding", "even with a stale cookie");
  });

  test("A REMEMBERED FAMILY THAT IS STILL THEIRS GOES STRAIGHT IN", () => {
    assert.equal(areaEntryFor([AREA], AREA.id), "dashboard");
    assert.equal(areaEntryFor([AREA, BRAVO], BRAVO.id), "dashboard");
  });

  test("NO VALID CHOICE IS THE CHOOSER -- EVEN FOR EXACTLY ONE FAMILY", () => {
    /*
     * The part that looks wrong and is not. `resolveActiveArea` would happily
     * pick the only one, and for every other screen it should -- opening a
     * bookmarked event with no cookie must show the event. But the FRONT DOOR
     * is where the app commits to whose people, whose money and whose history
     * it is about, and making that commitment silently is how a stale cookie
     * used to walk a two-family login into the wrong family without saying so.
     */
    assert.equal(areaEntryFor([AREA], null), "chooser");
    assert.equal(areaEntryFor([AREA], "a-family-they-have-left"), "chooser");
    assert.equal(areaEntryFor([AREA, BRAVO], null), "chooser");
    assert.equal(areaEntryFor([AREA, BRAVO], undefined), "chooser");
  });

  test("the root renders all three rather than redirecting to any of them", () => {
    const page = read("src/app/page.tsx");
    /*
     * 053 PUT AN INVITATION ABOVE TWO OF THE THREE. The onboarding branch used
     * to offer exactly one way forward -- start a family of your own -- to the
     * commonest newcomer there is: somebody a family invited. Both branches
     * still RENDER, which is the rule this test protects; what they render now
     * carries the offer, and `compact` draws nothing when none is waiting.
     */
    assert.ok(page.includes(String.raw`if (entry === "onboarding") {`));
    assert.ok(page.includes(String.raw`<CreateAreaForm first />`));
    assert.ok(page.includes('if (entry === "chooser") return <ChooserWithInvitations areas={areas} />;'));
    assert.ok(page.includes(String.raw`<AreaChooser areas={areas} />`));
    assert.match(page, /<EventsDashboard/u);
    // The one redirect it performs is the global status, and nothing else.
    assert.deepEqual(page.match(/\bredirect\([^)]*\)/gu), ["redirect(destination)"]);
  });

  test("the chooser lists every family and always offers a new one", () => {
    const chooser = read("src/app/area-chooser.tsx");
    assert.match(chooser, /ordered\.map\(\(area\) =>/u);
    assert.match(chooser, /sortAreas\(areas\)/u, "the switcher's own order, not a second one");
    assert.match(chooser, /href=\{CREATE_AREA_PATH\}/u);
    assert.match(chooser, /\{CREATE_AREA_LABEL\}/u);
    assert.equal(CREATE_AREA_PATH, "/areas/new");
    assert.equal(CREATE_AREA_LABEL, "Create new family");
  });

  test("choosing writes the cookie through the existing route, then reloads", () => {
    const chooser = read("src/app/area-chooser.tsx");
    assert.match(chooser, /fetch\("\/api\/areas", \{\s*\n\s*method: "PUT"/u,
      "the canonical Area-selection API, not a second one");
    assert.match(chooser, /window\.location\.assign/u,
      "a reload, for the same reason switching family reloads");
  });

  test("AND THERE IS STILL EXACTLY ONE WAY TO CREATE A FAMILY", () => {
    /*
     * Three screens now offer it -- the onboarding, the chooser and the account
     * menu -- and all three are links to `/areas/new`, which renders the one
     * `CreateAreaForm`, which posts to the one route, which calls the one
     * `create_area`. Nothing creates a family anywhere else.
     */
    const creators = sourceFiles()
      .filter((file) => /rpc\("create_area"|"create_area"/u.test(withoutComments(read(file))));
    assert.deepEqual(creators, ["src/app/api/areas/route.ts"]);

    const forms = sourceFiles().filter((file) => /export function CreateAreaForm\(/u.test(read(file)));
    assert.deepEqual(forms, ["src/app/areas/new/create-area-form.tsx"]);
  });

  test("and the account menu keeps offering it to anybody who already has one", () => {
    const menu = read("src/app/components/account-menu.tsx");
    assert.match(menu, /href=\{CREATE_AREA_PATH\}/u);
    assert.match(menu, /\{canCreate && \(/u);
  });
});

// ---------------------------------------------------------------------------
// 7. Claiming an invitation
// ---------------------------------------------------------------------------

describe("taking up an invitation", () => {
  test("CLAIMING RUNS ON SIGN-IN TOO, not only on an email link", () => {
    /*
     * A family can grant access at any time, including long after somebody
     * signed up and confirmed. Claiming only at `/auth/callback` would leave
     * that invitation unclaimed until the person happened to be sent another
     * email.
     */
    const login = read("src/app/login/page.tsx");
    assert.match(login, /await db\.rpc\("claim_app_member"\);/u);
    /*
     * And it happens BEFORE the status is read, so an account approved and
     * invited in the same sitting walks straight into its family.
     *
     * Measured inside `submit` only. The already-signed-in effect above it
     * reads the status too, and searching the whole file would compare the
     * claim against that one instead.
     */
    const submit = login.slice(login.indexOf("const submit = async (event: FormEvent)"));
    const claim = submit.indexOf('rpc("claim_app_member")');
    const status = submit.indexOf("const status = await loadAccountStatusClient();");
    assert.ok(claim > 0 && status > claim, "claim first, then decide where to go");
  });

  test("and AFTER confirmation on the callback, because 052 requires it", () => {
    /*
     * `claim_app_member()` now requires `email_confirmed_at is not null` --
     * without it, signing up as somebody else's address was enough to walk into
     * their family. The code exchange is what sets that column for a
     * confirmation link, so the claim has to come after it.
     */
    const callback = read("src/app/auth/callback/route.ts");
    const exchange = callback.indexOf("exchangeCodeForSession");
    const claim = callback.indexOf("await claimInvitations()");
    assert.ok(exchange > 0 && claim > exchange, "exchange, then claim");
  });

  test("a failed claim is never fatal, at any of the three callers", () => {
    // The claim improves the caller's situation; it is not the permission
    // check, and letting a database hiccup turn a valid sign-in into a refusal
    // is the failure this phase exists to remove.
    const callback = read("src/app/auth/callback/route.ts");
    assert.ok(!/if \(claim\.error\)[\s\S]{0,120}signOut/u.test(callback));
    const setup = read("src/app/account-setup/page.tsx");
    const branch = setup.slice(setup.indexOf("if (claim.error)"), setup.indexOf("if (claim.error)") + 200);
    assert.match(branch, /console\.error/u);
    assert.ok(!branch.includes("setStage(\"error\")"), "a missing invitation is not an error any more");
  });
});

// ---------------------------------------------------------------------------
// 8. Family Access
// ---------------------------------------------------------------------------

describe("family access, as five states", () => {
  const seat = (over) => ({
    person_id: "p1", person_name: "Sam", app_member_id: "m1", email: "sam@example.com",
    role: "member", active: true, claimed: true, account_status: "approved", email_confirmed: true,
    ...over,
  });

  test("no seat at all is `no_access`", () => {
    assert.equal(areaAccessStatus(seat({ app_member_id: null, email: null, role: null, active: null, claimed: null, account_status: null, email_confirmed: null })), "no_access");
  });

  test("AN UNCLAIMED INVITATION IS `invited`, AND SAYS NOTHING ELSE", () => {
    /*
     * IT USED TO BE `awaiting_signup`, and that word was an account-existence
     * oracle: it told the family administrator that the address they typed had
     * no Gift Planner account. One word replaces it, and it reads the same
     * whether the invitee already had an account or has just been sent a setup
     * email. Migration 053's own contract is what keeps that true -- for an
     * unclaimed seat, every account-shaped column `list_area_access` returns is
     * null EITHER WAY, because all of them are reached only through
     * `m.user_id`.
     */
    assert.equal(areaAccessStatus(seat({ claimed: false, account_status: null, email_confirmed: null })), "invited");
  });

  test("and a declined one is its own state, which is what 053 added", () => {
    // Before `declined_at`, "they said no" was byte-identical to "I switched
    // them off". Declined is asked BEFORE revoked because the CHECK constraint
    // makes a declined row `active = false` as well.
    assert.equal(
      areaAccessStatus(seat({ claimed: false, active: false, account_status: null, email_confirmed: null, declined_at: "2026-08-30T10:00:00Z" })),
      "declined",
    );
  });

  test("A CLAIMED SEAT WITH AN UNAPPROVED ACCOUNT IS ITS OWN STATE", () => {
    /*
     * THE ONE Q19 ADDED, AND THE REASON THE OTHER FOUR WERE NOT ENOUGH. The old
     * `pending` meant "invited, has not set a password" and was hiding two
     * situations with different people to chase. Here the family administrator
     * can do NOTHING, and telling them so is the point -- otherwise they resend
     * the invitation, change the address, and eventually ask the person to sign
     * up again, none of which can possibly help.
     */
    assert.equal(areaAccessStatus(seat({ account_status: "pending" })), "awaiting_global_approval");
    assert.equal(areaAccessStatus(seat({ account_status: "rejected" })), "awaiting_global_approval");
    assert.equal(areaAccessStatus(seat({ email_confirmed: false })), "awaiting_global_approval");
  });

  test("claimed and approved is `active`", () => {
    assert.equal(areaAccessStatus(seat()), "active");
  });

  test("REVOKED BEATS EVERYTHING THE SEAT STILL REMEMBERS", () => {
    // `active = false` keeps `user_id` and the address deliberately, so
    // restoring access restores the same person's seat rather than opening it
    // to whoever asks -- which means a revoked seat still looks claimed and
    // approved, and the order of the questions is what stops it reading so.
    assert.equal(areaAccessStatus(seat({ active: false })), "revoked");
    assert.equal(areaAccessStatus(seat({ active: false, claimed: false })), "revoked");
  });

  test("the labels are the phase's, verbatim", () => {
    assert.equal(AREA_ACCESS_LABELS.no_access, "No access");
    assert.equal(AREA_ACCESS_LABELS.invited, "Invitation pending");
    assert.equal(AREA_ACCESS_LABELS.awaiting_global_approval, "Waiting for Gift Planner approval");
    assert.equal(AREA_ACCESS_LABELS.active, "Active");
    assert.equal(AREA_ACCESS_LABELS.declined, "Declined");
    assert.equal(AREA_ACCESS_LABELS.revoked, "Revoked");
    // The two that told an administrator whether an address had an account.
    assert.ok(!("awaiting_signup" in AREA_ACCESS_LABELS));
    assert.ok(!Object.values(AREA_ACCESS_LABELS).includes("Awaiting sign-up"));
  });

  test("and the sentence that stops an administrator chasing the wrong thing", () => {
    assert.equal(
      AREA_ACCESS_EXPLANATIONS.awaiting_global_approval,
      "This family’s access is ready. Their Gift Planner account is still waiting for approval, which only a Gift Planner administrator can give.",
    );
  });

  test("ADMINISTRATORS ARE NOT MANAGED HERE, and the database agrees", () => {
    // `grant_area_access` refuses the administrator's own seat and
    // `revoke_area_access` refuses `role = 'admin'`, because an Area has
    // exactly one active administrator and neither routine knows that
    // invariant. Offering a control that is going to be refused is worse than
    // offering none.
    const admin = seat({ role: "admin" });
    assert.ok(isAdminSeat(admin));
    assert.ok(!canGrantAccess(admin));
    assert.ok(!canRevokeAccess(admin));
    assert.ok(canRevokeAccess(seat()));
    assert.ok(canGrantAccess(seat({ app_member_id: null, active: null, claimed: null })));
    assert.ok(canGrantAccess(seat({ active: false })), "restoring a revoked seat is a grant");
  });

  test("the screen reads and writes through the routines and nothing else", () => {
    const screen = read("src/app/more/family-access/family-access-client.tsx");
    assert.match(screen, /rpc\("list_area_access"\)/u);
    assert.match(screen, /rpc\("revoke_area_access"/u);
    assert.ok(!screen.includes('from("app_accounts")'));
    assert.ok(!screen.includes('from("app_members")'), "membership rows come from the routine");

    /*
     * `grant_area_access` LEFT THE BROWSER IN PHASE 5A, and it is the only one
     * that did. Inviting used to be two presses -- grant here, then a separate
     * "Send invitation" offered only on a seat labelled "Awaiting sign-up" --
     * and that second button existed to be offered when the address had no
     * account. The grant and the delivery are one act now, behind the route, so
     * there is no intermediate state for the screen to read the answer off.
     * The routine still runs as the ADMINISTRATOR'S OWN SESSION there; see
     * `scripts/family-invitation-runtime.test.mjs`.
     */
    assert.ok(!withoutComments(screen).includes('rpc("grant_area_access"'));
    assert.match(screen, /action: "invite"/u);
  });

  test("NO PROJECT-WIDE AUTH ENUMERATION ANYWHERE IN FAMILY ACCESS", () => {
    /*
     * `listAllAuthUsers` fetched up to a hundred pages of every account on the
     * installation to answer a question about one family, and it is how Family
     * Access could tell whether an address had an account somewhere its
     * administrator cannot see. `list_area_access()` takes no email parameter,
     * so there is nothing left to point anywhere.
     */
    for (const path of [
      "src/app/api/admin/family-access/route.ts",
      "src/utils/supabase/family-access-admin.ts",
      "src/app/more/family-access/family-access-client.tsx",
      "src/app/more/family-access/page.tsx",
    ]) {
      const body = withoutComments(read(path));
      assert.ok(!body.includes("listUsers"), `${path} must not enumerate Auth accounts`);
      assert.ok(!body.includes("listAllAuthUsers"), `${path} must not call the removed helper`);
    }
    // And the helper is gone from the codebase entirely.
    const survivors = sourceFiles().filter((file) => withoutComments(read(file)).includes("listAllAuthUsers"));
    assert.deepEqual(survivors, []);
  });

  test("the retained elevated actions are the ones Auth alone can do", () => {
    /*
     * TWO NOW, NOT THREE. `copy-setup-link` minted
     * `generateLink({ type: "invite" })`, which GoTrue REFUSES for an address
     * that already has an account -- so it answered with a link for a stranger
     * and an error for a member. That is the cleanest account-existence oracle
     * the application had, and there is no version of it that keeps the
     * convenience and loses the disclosure. `send-invite` went with it: sending
     * is part of inviting now, so there is no second press to observe.
     */
    const route = read("src/app/api/admin/family-access/route.ts");
    assert.match(route, /const actions = new Set<Action>\(\["invite", "copy-reset-link"\]\);/u);
    assert.match(route, /inviteUserByEmail/u);
    assert.match(route, /generateLink/u);
    assert.ok(!withoutComments(route).includes('"send-invite"'));
    assert.ok(!withoutComments(route).includes('"copy-setup-link"'));
    // Ordinary password reset is a public Auth call the browser makes for
    // itself, so routing it through the service role added a privilege and no
    // capability. The CODE, not the commentary that explains its removal.
    const body = withoutComments(route);
    assert.ok(!body.includes("resetPasswordForEmail"));
    assert.ok(!body.includes("send-reset"));
  });

  test("and the page itself no longer asks for the service role to render", () => {
    // Asking for the most privileged client in the application in order to
    // decide whether to draw a heading is a privilege taken for no capability.
    const page = read("src/app/more/family-access/page.tsx");
    assert.ok(!withoutComments(page).includes("requireFamilyAccessAdmin"));
    assert.match(page, /getCurrentMember\(\)/u);
    assert.match(page, /member\.role !== "admin"/u);
  });
});

// ---------------------------------------------------------------------------
// 9. The table nothing may read
// ---------------------------------------------------------------------------

describe("app_accounts is never queried directly, from anywhere", () => {
  test("NOT ONE FILE IN src/ SELECTS FROM IT", () => {
    /*
     * It holds no privilege for `anon` or `authenticated` and has zero
     * policies, so a browser query would fail whatever this test said -- and a
     * SERVER query with the service role would succeed, bypassing every gate
     * 052 exists to install. That second case is why this sweeps all of `src/`
     * rather than only the client files.
     *
     * `my_account_status()` is the whole read surface for one's own status and
     * `list_accounts()` for everybody's.
     */
    const offenders = sourceFiles().filter((file) => {
      const body = withoutComments(read(file));
      return /from\(\s*["']app_accounts["']\s*\)/u.test(body) || /public\.app_accounts/u.test(body);
    });
    assert.deepEqual(offenders, []);
  });

  test("and the status arrives through the one routine, in both runtimes", () => {
    const client = read("src/utils/supabase/account-status-client.ts");
    const server = read("src/utils/supabase/account-status-server.ts");
    assert.match(client, /rpc\("my_account_status"\)/u);
    assert.match(server, /rpc\("my_account_status"\)/u);
    // Both hand the row to the same pure function, so a server render and the
    // browser that hydrates it cannot reach different conclusions.
    assert.match(client, /accountStatusFrom\(firstRow\(data\)\)/u);
    assert.match(server, /accountStatusFrom\(firstRow\(data\)\)/u);
    // A failed call is signed-out, never approved.
    assert.match(client, /if \(error\) return SIGNED_OUT;/u);
    assert.match(server, /if \(error\) return SIGNED_OUT;/u);
  });

  test("every caller of the status goes through one of those two", () => {
    const askers = sourceFiles().filter((file) => read(file).includes('rpc("my_account_status")'));
    assert.deepEqual(askers, [
      "src/utils/supabase/account-status-client.ts",
      "src/utils/supabase/account-status-server.ts",
    ]);
  });
});
