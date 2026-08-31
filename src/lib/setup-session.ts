/**
 * ==========================================================================
 *  WHOSE SESSION IS THIS, AND DID THE LINK PUT IT THERE?
 * ==========================================================================
 *
 * THE DEFECT THIS EXISTS TO REMOVE. `/account-setup` established a session from
 * the tokens in the link when there were any, and then asked
 * `supabase.auth.getUser()` for the identity -- WITHOUT CHECKING that the two
 * were the same person. When the link carried no tokens, `getUser()` answered
 * with whatever session the browser already had, and setup silently continued
 * as somebody else:
 *
 *   Sign in as A. Open the invitation email for B in the same browser. The
 *   link's tokens have already been spent, so nothing replaces the session --
 *   and Gift Planner greets you, sets a password and offers onward routing
 *   AS A, while you believe you have just set up B.
 *
 * NOT A DATA BREACH, and worth being exact about why: an invitation is listed
 * and accepted by `list_my_family_invitations()` and
 * `accept_family_invitation()`, which resolve the caller from `auth.uid()` and
 * match the seat on `lower(m.email) = caller_email` read from `auth.users`.
 * A's session can therefore never see or accept B's invitation -- the database
 * refuses it, and there is no parameter to lie in. What was broken is
 * DETERMINISM: which identity a setup link ends up operating on.
 *
 * THE RULE, IN ONE SENTENCE. A setup link operates on the identity THE LINK
 * ESTABLISHED, and on no other -- so a session the link did not create is
 * cleared rather than borrowed.
 *
 * HOW THE LINK NAMES ITS IDENTITY. Two shapes arrive here, and both end up
 * saying who they are:
 *
 *   IMPLICIT   Supabase Admin invite and recovery links carry `access_token`
 *              and `refresh_token` in the URL FRAGMENT, which never reaches a
 *              server. The browser exchanges them with `setSession`, which
 *              REPLACES whatever was there -- so the identity afterwards is the
 *              link's by construction, and `linkUserId` is read back from it.
 *   PKCE       `/auth/callback` exchanges the code server-side and redirects
 *              here. The session cookie is already the link's identity, and the
 *              callback appends that user's id so this side can CHECK rather
 *              than assume.
 *
 * WHY PASSING A USER ID IS SAFE. It is an identifier, not a credential: it
 * grants nothing, and every route re-derives the caller from `auth.uid()`.
 * Forging it cannot promote a session -- the two ids simply disagree, and
 * disagreement always fails closed, to `wrong_identity`.
 */

export const SETUP_IDENTITY_PARAM = "identity";

export type SetupSessionVerdict =
  /** The link established this session itself. Proceed. */
  | "established"
  /** No tokens to spend, but the session already IS the link's identity. Proceed. */
  | "matches"
  /** A session exists and is somebody else. Clear it; the link must be reopened. */
  | "wrong_identity"
  /** Nothing to work with: no tokens, no session. The link is spent or expired. */
  | "no_session";

export type SetupSessionInput = {
  /**
   * The identity the LINK is for.
   *   * implicit: read back from the session the tokens established.
   *   * PKCE: the `identity` query parameter the callback appended.
   *   * null when the link named nobody, which is the ambiguous case.
   */
  linkUserId: string | null;
  /** Who the browser is actually signed in as now, or null. */
  sessionUserId: string | null;
  /** Whether this page exchanged tokens from the link on this visit. */
  establishedFromLink: boolean;
};

/**
 * The whole decision, as one pure function so a test runs the real rule.
 *
 * THE ORDER MATTERS, and each step is where it is for a reason:
 *
 *   1. NO SESSION AT ALL is not an identity mismatch. It is a spent or expired
 *      link, and it gets the message that leads somewhere -- ask for another.
 *   2. A SESSION THE LINK JUST CREATED is trusted, because `setSession`
 *      replaced whatever preceded it. This is the ordinary invited path.
 *   3. AN UNIDENTIFIED LINK OVER AN EXISTING SESSION IS REFUSED. This is the
 *      defect's exact shape: no tokens were spent and the link named nobody, so
 *      there is NO EVIDENCE the session in this browser has anything to do with
 *      the email that was opened. Borrowing it is the bug; the safe answer is
 *      to clear it and make the link be reopened.
 *   4. Otherwise the two ids are compared, and only equality proceeds.
 */
export function setupSessionVerdict(input: SetupSessionInput): SetupSessionVerdict {
  const { linkUserId, sessionUserId, establishedFromLink } = input;

  if (!sessionUserId) return "no_session";
  if (establishedFromLink) {
    // The tokens are spent and the session is theirs. If the link ALSO named an
    // identity, it still has to agree -- a mismatch here would mean the
    // exchange produced somebody other than the person the link was issued to.
    return !linkUserId || linkUserId === sessionUserId ? "established" : "wrong_identity";
  }
  if (!linkUserId) return "wrong_identity";
  return linkUserId === sessionUserId ? "matches" : "wrong_identity";
}

/** Whether the caller must sign the current session out before going on. */
export function mustClearSession(verdict: SetupSessionVerdict): boolean {
  return verdict === "wrong_identity";
}

/** Whether account setup may proceed under the session as it now stands. */
export function mayProceedWithSetup(verdict: SetupSessionVerdict): boolean {
  return verdict === "established" || verdict === "matches";
}

/**
 * WHAT THE PERSON IS TOLD, and why `wrong_identity` does not name the account.
 *
 * Saying "you were signed in as alice@example.com" would disclose one
 * browser-sharer's address to another, on a screen anybody holding a link can
 * reach. The sentence says what happened and what to do, and identifies nobody.
 */
export const SETUP_SESSION_MESSAGES: Record<SetupSessionVerdict, string> = {
  established: "",
  matches: "",
  wrong_identity:
    "This browser was already signed in to a different Gift Planner account, so it has been signed out. Open the link in your email again to finish setting up your account.",
  no_session:
    "This setup link is invalid or has expired. Ask your family’s admin for a new link.",
};
