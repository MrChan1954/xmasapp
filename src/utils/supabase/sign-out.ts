/*
 * NO "use client" DIRECTIVE, deliberately, for the same reason
 * `current-member-client.ts` and `area-choice-client.ts` have none: a module
 * marked "use client" turns every export into a client reference, and a server
 * module that calls one throws at render. This is browser code by virtue of
 * writing `document.cookie` and reading `window.location`, and it guards those
 * rather than announcing itself.
 */
import { AREA_COOKIE } from "@/lib/areas";
import { LOGIN_PATH } from "@/lib/account-status";
import { createClient } from "./client";

/**
 * SIGNING OUT, IN ONE PLACE.
 *
 * Q18 found this written out twice, byte for byte, in the account screen and
 * the account menu, and deliberately left it alone: verifying a change to the
 * sign-out path means signing the real family out of the live site, which the
 * QA rules forbid. Q19 is where it has to be settled, because there are now
 * FIVE callers -- the two above, plus the pending screen, the refused screen
 * and the global admin queue, none of which have an account menu to reach.
 *
 * THE HAZARD Q18 NAMED, AND WHY IT IS REAL. Both copies called
 * `auth.signOut()` and pushed `/login`; neither cleared `gp_area`. So the
 * browser kept the last family's id, and the NEXT person to sign in on that
 * device started with a cookie naming a family that is very probably not
 * theirs. Nothing leaks -- `claim_active_area` (038) checks the membership
 * table before it believes the header the cookie becomes, and every row is
 * behind row level security either way -- but the first render is about the
 * wrong family, and with Q19's chooser a stale cookie is now also the
 * difference between "ask which family" and "walk straight into one".
 *
 * THREE STEPS, IN THIS ORDER:
 *
 *   1. End the session first. If the network fails between here and step 3 the
 *      device is signed out, which is the safe way round to fail.
 *   2. Forget the Area. Deleted rather than rewritten: `forgetArea` on the
 *      server exists for exactly one other case (leaving your last family), and
 *      this is the second.
 *   3. HARD navigate, not `router.replace`. Every provider in the tree is
 *      holding rows read under the old session, and a client navigation keeps
 *      them mounted; a document load is the only way to be sure the next screen
 *      starts from nothing.
 */
export async function signOut(): Promise<void> {
  await clearSession();
  redirectToLogin();
}

/**
 * THE FIRST TWO STEPS, FOR THE ONE CALLER THAT MUST NOT NAVIGATE.
 *
 * `/account-setup` clears a session when the browser turns out to be signed in
 * to a DIFFERENT account from the one the setup link is for. It then has to
 * stay put and say so: sending that person to `/login` would drop them on a
 * screen that does not render the reason, and they would try the same link
 * again with no idea what happened.
 *
 * Step 3 is all that is left out. The session still ends first and the Area
 * cookie is still forgotten -- the hazard Q18 named, and the reason this module
 * exists -- so a caller cannot half-sign-out by accident. `auth.signOut()`
 * remains in this file and nowhere else, which is what
 * `scripts/canonical-paths.test.mjs` counts.
 */
export async function clearSession(): Promise<void> {
  await createClient().auth.signOut();
  forgetAreaCookie();
}

/**
 * Expire `gp_area` in the browser.
 *
 * The cookie is deliberately not `httpOnly` (see `utils/area-cookie.ts`) so the
 * switcher can read it, which is what lets this be done here rather than by a
 * round trip to a route that exists only to delete it.
 */
function forgetAreaCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${AREA_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  window.location.assign(new URL(LOGIN_PATH, window.location.origin).toString());
}
