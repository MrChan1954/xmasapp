/**
 * WHAT AN ACCOUNT IS ALLOWED TO BE, AND WHERE EACH ANSWER LEADS.
 *
 * Migration 052 put a second gate above every Area gate:
 *
 *     auth.users        you can sign in
 *       -> app_accounts a human has approved you for Gift Planner
 *          -> app_members  a family has invited you into it
 *             -> role      what you may do inside that family
 *
 * Before it, "has a session" and "belongs here" were the same population and
 * the runtime never had to tell them apart -- which is why the sign-in path
 * used to read `app_members` and sign out anybody with no membership. That is
 * now wrong twice over: an APPROVED account with no family is legitimate and
 * must stay signed in, and a REJECTED account with a family must not be let in
 * whatever `app_members` says.
 *
 * SEPARATE FROM EVERY SUPABASE CALL ON PURPOSE, for the reason
 * `src/lib/navigation.ts` is separate from `nav-items.ts`: everything here is a
 * pure function over plain values, so a test can run the real decision instead
 * of reading the source and hoping. The two adapters that fetch the row live in
 * `src/utils/supabase/account-status-{client,server}.ts` and do no deciding.
 *
 * NOTHING HERE IS A SECURITY BOUNDARY. `app_accounts` carries no privilege for
 * `anon` or `authenticated` and has zero policies, so the browser cannot read
 * it at all; every gated routine re-asks `is_globally_approved()` for itself.
 * This decides what to SHOW, and the database decides what may be shown.
 */

/**
 * The six answers, and the only six.
 *
 * `email_unverified` is a state of `auth.users`, not of `app_accounts` -- an
 * address nobody has proved they own. The other five are the global status.
 */
export const ACCOUNT_STATES = [
  "signed_out",
  "email_unverified",
  "pending",
  "approved",
  "rejected",
  "suspended",
] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

/** One row of `my_account_status()`, exactly as PostgREST returns it. */
export type AccountStatusRow = {
  status?: string | null;
  is_global_admin?: boolean | null;
  email_confirmed?: boolean | null;
};

export type AccountStatus = {
  state: AccountState;
  /** Only ever true for an approved account. See `accountStatusFrom`. */
  isGlobalAdmin: boolean;
  emailConfirmed: boolean;
};

export const SIGNED_OUT: AccountStatus = {
  state: "signed_out",
  isGlobalAdmin: false,
  emailConfirmed: false,
};

/**
 * The row, turned into a decision.
 *
 * FAIL-CLOSED, IN THE SAME ORDER THE DATABASE FAILS CLOSED:
 *
 *   1. No row at all means NOBODY IS SIGNED IN. `my_account_status()` is a
 *      `select ... where u.id = auth.uid()`, so an anonymous caller gets zero
 *      rows rather than a null status. A missing `app_accounts` row is a
 *      different thing entirely and the routine already reports it as
 *      `pending`, which is exactly what undecided is.
 *
 *   2. REFUSAL BEATS EVERYTHING ELSE. A rejected or suspended account is
 *      refused before its email confirmation is even considered: those two are
 *      decisions a person made, and "confirm your address" would be an
 *      instruction that leads nowhere.
 *
 *   3. An unknown status string is `pending`. The CHECK constraint makes one
 *      unreachable; if a later migration adds a sixth status, an old browser
 *      must treat it as undecided rather than as approved.
 *
 *   4. THE ADMIN FLAG IS CLEARED FOR ANYBODY NOT APPROVED. The database
 *      enforces this itself -- `app_accounts_admin_must_be_approved` makes an
 *      unapproved administrator unreachable even by direct SQL -- and it is
 *      restated here so a stale or hand-edited payload cannot light up the
 *      global admin route.
 */
export function accountStatusFrom(row: AccountStatusRow | null | undefined): AccountStatus {
  if (!row) return SIGNED_OUT;

  const emailConfirmed = row.email_confirmed === true;
  const status = typeof row.status === "string" ? row.status : "pending";

  const state: AccountState =
    status === "rejected" ? "rejected"
      : status === "suspended" ? "suspended"
        : !emailConfirmed ? "email_unverified"
          : status === "approved" ? "approved"
            : "pending";

  return {
    state,
    isGlobalAdmin: state === "approved" && row.is_global_admin === true,
    emailConfirmed,
  };
}

/** True for the three states that may not reach one row of family data. */
export function isRefused(state: AccountState): boolean {
  return state === "rejected" || state === "suspended";
}

// ---------------------------------------------------------------------------
// The two kinds of route that carry no family
// ---------------------------------------------------------------------------

/**
 * SIGNED-OUT ENTRY POINTS. They render their own full-screen frame, carry no
 * app chrome, and have no family data to load.
 *
 * `/check-email` is here rather than under the global routes below because it
 * is reachable BEFORE there is an account to have a status: it is where sign-up
 * sends somebody whose address is not confirmed yet, and the confirmation link
 * in that email is the only way out of it.
 */
export const AUTH_ROUTES: readonly string[] = [
  "/login",
  "/sign-up",
  "/check-email",
  "/forgot-password",
  "/reset-password",
  "/account-setup",
  "/auth/callback",
];

/**
 * SIGNED IN, AND STILL NOT IN A FAMILY.
 *
 * These three are the whole of the global scope: two screens for an account
 * that has not been let in, and one for the person who does the letting in.
 * None of them may load an Area, an acting Area, or a membership -- a Gift
 * Planner administrator with no families must be able to work the queue, and
 * `/admin/accounts` deliberately carries no family data of any kind.
 */
export const GLOBAL_ROUTES: readonly string[] = [
  "/account-pending",
  "/account-rejected",
  "/admin/accounts",
];

function matches(routes: readonly string[], pathname: string): boolean {
  return routes.some((route) => pathname === route || pathname.startsWith(route + "/"));
}

export function isAuthRoute(pathname: string): boolean {
  return matches(AUTH_ROUTES, pathname);
}

export function isGlobalRoute(pathname: string): boolean {
  return matches(GLOBAL_ROUTES, pathname);
}

/**
 * A route with no Area behind it, of either kind.
 *
 * `AppFrame` renders these bare and `FamilyProvider` skips all of its Area work
 * on them -- no membership resolution, no `ensureAreaChosen`, no realtime
 * subscription. One predicate, so the frame and the provider cannot disagree
 * about which screens have chrome.
 */
export function isBareRoute(pathname: string): boolean {
  return isAuthRoute(pathname) || isGlobalRoute(pathname);
}

// ---------------------------------------------------------------------------
// Where each state may be
// ---------------------------------------------------------------------------

export const LOGIN_PATH = "/login";
export const CHECK_EMAIL_PATH = "/check-email";
export const ACCOUNT_PENDING_PATH = "/account-pending";
export const ACCOUNT_REJECTED_PATH = "/account-rejected";
export const GLOBAL_ADMIN_PATH = "/admin/accounts";
export const HOME_PATH = "/";

/**
 * Where an account that is mid-confirmation may legitimately be.
 *
 * All four are steps of confirming or of setting a password, and every one of
 * them is reached from a link in an email -- so bouncing them to
 * `/check-email` would break the very journey that ends the state.
 */
const UNVERIFIED_ALLOWED: readonly string[] = [
  CHECK_EMAIL_PATH,
  "/account-setup",
  "/reset-password",
  "/auth/callback",
];

/**
 * The screens an APPROVED account is sent away from. Everything else is theirs,
 * including `/admin/accounts` -- which then asks the database whether they
 * administer Gift Planner and answers a 404 if not.
 */
const APPROVED_EXITS: readonly string[] = [
  LOGIN_PATH,
  "/sign-up",
  CHECK_EMAIL_PATH,
  ACCOUNT_PENDING_PATH,
  ACCOUNT_REJECTED_PATH,
];

/**
 * WHERE THIS PERSON SHOULD BE, given where they are. `null` means "stay".
 *
 * THE ONE RULE THAT USED TO BE MISSING: an approved account with no family is
 * never sent back to the sign-in form. It has somewhere to go -- the onboarding
 * at `/` -- and signing it out was the defect this whole phase exists to fix.
 *
 * THE OTHER: `rejected` and `suspended` share one destination AND one screen.
 * Telling them apart would let somebody probe which decision was taken about
 * them, and neither answer is any use to the person reading it.
 */
export function destinationFor(state: AccountState, pathname: string): string | null {
  if (state === "signed_out") {
    return isAuthRoute(pathname) ? null : LOGIN_PATH;
  }

  if (state === "email_unverified") {
    return matches(UNVERIFIED_ALLOWED, pathname) ? null : CHECK_EMAIL_PATH;
  }

  if (state === "pending") {
    return pathname === ACCOUNT_PENDING_PATH ? null : ACCOUNT_PENDING_PATH;
  }

  if (isRefused(state)) {
    return pathname === ACCOUNT_REJECTED_PATH ? null : ACCOUNT_REJECTED_PATH;
  }

  return matches(APPROVED_EXITS, pathname) ? HOME_PATH : null;
}

/**
 * WHERE THIS STATE MUST GO, ASKED FROM A ROUTE THAT CARRIES A FAMILY.
 *
 * `FamilyProvider` is the client guard, and it only ever runs on routes that
 * are NOT bare -- it returns early on every auth and global route. So the
 * question it has to ask is narrower than `destinationFor`'s: not "may this
 * account be on this exact path", but "may it be inside the application at
 * all". Every answer but `approved` is the same wherever it was asked from.
 *
 * WHY IT IS A SEPARATE FUNCTION RATHER THAN A CALL WITH THE CURRENT PATH.
 * Passing `pathname` would put it in the provider's dependency list, and the
 * provider's loader would then re-run -- `getUser`, the status RPC and the
 * membership read -- on EVERY navigation between ordinary screens, none of
 * which can change the answer. This asks the same question without the cost.
 */
export function appEntryDestinationFor(state: AccountState): string | null {
  return destinationFor(state, HOME_PATH);
}
