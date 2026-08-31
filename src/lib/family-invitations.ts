import { validateEmail } from "@/lib/input-validation";

import { areaAccessStatus, type AreaAccessRow } from "@/lib/family-access";

/**
 * ==========================================================================
 *  ISSUING A FAMILY INVITATION, AND THE ONE THING THE ADMINISTRATOR MUST NOT
 *  BE TOLD WHILE IT HAPPENS.
 * ==========================================================================
 *
 * A family administrator types an address and presses one button. Underneath,
 * two completely different things happen depending on whether that address
 * already has a Gift Planner account:
 *
 *   IT DOES        the invitation is created and left alone. No signup email,
 *                  no password-setup email, no account is created or touched.
 *                  The invitee already has a way in and will be offered the
 *                  invitation inside the app.
 *   IT DOES NOT    the invitation is created AND Supabase is asked to send the
 *                  account-setup email, which is the only way that person can
 *                  ever reach the offer.
 *
 * THE ADMINISTRATOR IS TOLD NEITHER. Both branches answer with one sentence,
 * `Invitation created.`, at one status, with one body shape. That is not
 * politeness -- it is the whole security requirement of this module. Anything
 * that varies with the branch is an account-existence oracle handed to somebody
 * whose only entitlement is to run one family. They may invite any address they
 * can type; they may not learn who is already here.
 *
 * HOW THE BRANCH IS TAKEN, AND WHY THERE IS NO LOOKUP.
 *
 * There is no "does this email have an account" call anywhere, because a
 * function that answers that question is a function somebody will eventually
 * expose. `listAllAuthUsers` -- a hundred pages of every account on the
 * installation, fetched to answer a question about one family -- was deleted in
 * Q19 and must never come back.
 *
 * Instead THE INVITE ATTEMPT IS THE BRANCH. `inviteUserByEmail` refuses an
 * address that is already registered, before it sends anything, and that
 * refusal is the only signal used. It never leaves this module: it is folded
 * into `ready`, and `ready` is what both success branches produce.
 *
 * WHAT THIS MODULE IS NOT. It holds no client, no key and no session. Every
 * privileged thing it needs is passed in -- three of them the ADMINISTRATOR'S
 * OWN database session, one of them the Auth Admin boundary -- so the whole
 * decision can be run for real by a test, with the branch chosen by the fake
 * rather than asserted about from a distance.
 */

/**
 * The closed vocabulary `record_invitation_delivery(uuid, text)` accepts, and
 * nothing else. 053 chose it to be BRANCH-BLIND: `ready` covers both success
 * paths, so the family's activity log -- which every member of the family can
 * read, not only its administrator -- cannot become a slower, more durable copy
 * of the oracle this module refuses to be.
 */
export type InvitationDeliveryOutcome = "ready" | "undelivered";

/** What the Auth Admin invite boundary did, reduced to the three cases. */
export type SetupEmailResult =
  /** No account existed; the setup email was accepted for delivery. */
  | { kind: "sent" }
  /** An account already exists, so no email was sent and none was needed. */
  | { kind: "already-registered" }
  /** An account was needed and the send failed. The invitation still stands. */
  | { kind: "failed" };

export type FamilyInvitationDeps = {
  /** `list_area_access()`, through the administrator's own session. */
  listAccess: () => Promise<AreaAccessRow[]>;
  /** `grant_area_access(person, email)`, through the administrator's own session. */
  grantAccess: (personId: string, email: string) => Promise<void>;
  /** `record_invitation_delivery(person, outcome)`, same session, closed vocabulary. */
  recordDelivery: (personId: string, outcome: InvitationDeliveryOutcome) => Promise<void>;
  /**
   * The Auth Admin invitation. THE ONLY SERVICE-ROLE CAPABILITY IN THE FLOW,
   * and the only one no SQL routine can perform, because no SQL routine sends
   * an email.
   */
  sendSetupEmail: (email: string) => Promise<SetupEmailResult>;
};

export type FamilyInvitationRequest = { personId: string; email: string };

export type FamilyInvitationResult =
  | { ok: true; status: 200; message: string }
  | { ok: false; status: number; message: string };

/**
 * THE ONE SUCCESS SENTENCE. Both branches return this string, at status 200,
 * from a body with these exact two fields. A test compares the two responses
 * field for field; if this ever becomes two sentences, that test fails and it
 * is right to.
 */
export const INVITATION_CREATED = "Invitation created.";

/**
 * Restoring a seat that is already ATTACHED TO A LOGIN is a different act and
 * says so. It is not a branch on account existence: the seat's own `claimed`
 * flag is already on the administrator's screen, put there by
 * `list_area_access` for a seat inside their own family. Nothing about an
 * address they have never invited is disclosed by it.
 */
export const ACCESS_RESTORED = "Access restored.";

/**
 * THE FAILURE SENTENCE, WHICH NAMES NOTHING.
 *
 * It has to cover a failed send AND a failed delivery record, because those two
 * must be indistinguishable: only the no-account branch can fail to send, so a
 * message mentioning email, sending or accounts would be exactly the oracle the
 * success path is so careful about, arrived at the long way round. It says the
 * true and useful part -- the invitation exists, try again -- and stops.
 */
export const INVITATION_NOT_FINISHED =
  "The invitation was created, but Gift Planner could not finish setting it up. Try again in a moment.";

const NOT_IN_THIS_FAMILY = "This family member was not found.";
const ADMIN_SEAT_PROTECTED =
  "The family administrator’s access is changed by handing over the family, not here.";

/**
 * TURN THE AUTH ADMIN'S REFUSAL INTO ONE OF THREE WORDS.
 *
 * GoTrue answers an already-registered address with 422 and, on versions that
 * carry one, the code `email_exists`; older builds send only the sentence. All
 * three shapes are matched, and the fall-through is `failed` rather than
 * `already-registered` -- because guessing "they already have an account" when
 * something else went wrong would silently skip an email somebody is waiting
 * for, and a spurious retry costs nothing.
 */
export function classifySetupEmailError(error: {
  code?: string | null;
  status?: number | null;
  message?: string | null;
} | null | undefined): SetupEmailResult {
  if (!error) return { kind: "sent" };
  const code = (error.code ?? "").toLowerCase();
  const message = (error.message ?? "").toLowerCase();
  if (
    code === "email_exists" ||
    code === "user_already_exists" ||
    error.status === 422 ||
    /already (been )?registered|already exists|user already/u.test(message)
  ) {
    return { kind: "already-registered" };
  }
  return { kind: "failed" };
}

/**
 * The invitation, start to finish.
 *
 * THE ORDER IS THE DESIGN, and each step is placed where a failure of it does
 * the least harm:
 *
 *   1. THE ADDRESS IS CHECKED BEFORE ANYTHING IS SENT OR WRITTEN. A malformed
 *      one is a 400 that never reached Auth and never reached the database.
 *   2. THE PERSON IS FOUND IN THE ADMINISTRATOR'S OWN LISTING, so the Area is
 *      the acting one by construction. There is no Area parameter to get
 *      wrong: `list_area_access()` does not take one, and somebody in another
 *      family is simply absent from the answer -- the same 404 as an id that
 *      names nobody.
 *   3. THE PROTECTED SEAT IS REFUSED HERE AS WELL AS IN THE DATABASE.
 *      `grant_area_access` refuses `role = 'admin'` for itself, so this is the
 *      second of two locks rather than the only one; it exists so the refusal
 *      is a sentence rather than a raised exception.
 *   4. THE INVITATION IS CREATED FIRST, DELIVERY SECOND. That order is not
 *      arbitrary: if delivery fails, an invitation that exists can be sent
 *      again, whereas an email sent for an invitation that was never created
 *      leads somebody to a door that is not there.
 *   5. A CLAIMED SEAT SENDS NOTHING. There is a login on it already, so there
 *      is no account to set up -- and `record_invitation_delivery` would refuse
 *      it anyway, because it records open invitations only.
 */
export async function issueFamilyInvitation(
  deps: FamilyInvitationDeps,
  request: FamilyInvitationRequest,
): Promise<FamilyInvitationResult> {
  const email = validateEmail(request.email);
  if (!email.ok) return { ok: false, status: 400, message: email.error };

  const rows = await deps.listAccess();
  const row = rows.find((candidate) => candidate.person_id === request.personId) ?? null;
  if (!row) return { ok: false, status: 404, message: NOT_IN_THIS_FAMILY };
  if (row.role === "admin") return { ok: false, status: 409, message: ADMIN_SEAT_PROTECTED };

  /*
   * READ BEFORE THE WRITE, DELIBERATELY. After `grant_area_access` every seat
   * looks the same shape, so whether this was a restore or an invitation has to
   * be decided from what was there beforehand.
   */
  const wasClaimed = row.claimed === true && areaAccessStatus(row) !== "declined";

  await deps.grantAccess(request.personId, email.value);

  if (wasClaimed) return { ok: true, status: 200, message: ACCESS_RESTORED };

  const delivery = await deps.sendSetupEmail(email.value);
  const outcome: InvitationDeliveryOutcome = delivery.kind === "failed" ? "undelivered" : "ready";

  /*
   * RECORDED EITHER WAY, AND BEFORE THE ANSWER. `undelivered` is the only
   * honest thing to leave behind when an email did not go out, and it is the
   * thing a retry is judged against later.
   */
  try {
    await deps.recordDelivery(request.personId, outcome);
  } catch {
    // The invitation is real and the seat is correct; only the audit entry is
    // missing. Reported with the same sentence a failed send gets, so the two
    // cannot be told apart from outside.
    return { ok: false, status: 502, message: INVITATION_NOT_FINISHED };
  }

  if (outcome === "undelivered") {
    return { ok: false, status: 502, message: INVITATION_NOT_FINISHED };
  }

  return { ok: true, status: 200, message: INVITATION_CREATED };
}
