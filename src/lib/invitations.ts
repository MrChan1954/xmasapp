/**
 * BEING ASKED TO JOIN A FAMILY, FROM THE OTHER SIDE.
 *
 * ==========================================================================
 *  WHY THIS SURFACE IS GLOBAL AND NOT AREA-SCOPED, WHICH IS THE WHOLE DESIGN.
 * ==========================================================================
 *
 * An invitation has to be readable BY SOMEBODY WHO IS NOT IN THE FAMILY YET.
 * That single sentence rules out almost everywhere it could naturally have
 * lived:
 *
 *   NOT a notification row      `notifications` is behind `is_area_member`, so
 *                               a row telling you about a family you have not
 *                               joined is a row you cannot read. Making it
 *                               readable would mean weakening the policy that
 *                               keeps every other family's notifications
 *                               private, to deliver one sentence.
 *   NOT a screen inside a       every one of those resolves an acting Area
 *   family                      first, and there is none.
 *   NOT the Area chooser alone  an invited account may belong to no family at
 *                               all, so the chooser it would appear in is a
 *                               chooser that never renders.
 *
 * So the source of truth is `list_my_family_invitations()` -- a routine with NO
 * PARAMETER, which resolves the caller from `auth.uid()` and their address from
 * `auth.users`, and therefore cannot be pointed at anybody else. And the
 * surface is a BARE route: no `FamilyProvider`, no acting Area, no `gp_area`,
 * no membership read. A stale cookie naming a family this account has never
 * been in changes nothing here, because nothing here reads it.
 *
 * ==========================================================================
 *  WHAT AN INVITATION IS ALLOWED TO SAY BEFORE IT IS ACCEPTED.
 * ==========================================================================
 *
 * Three fields, and 053 chose each of them:
 *
 *   area_name    you cannot consent to joining a family without being told
 *                which family.
 *   invited_as   nor without being told WHO they think you are. Being invited
 *                as the wrong person is the mistake this catches.
 *   invited_at   how old the offer is.
 *
 * Not one event, budget, purchase, payment, birthday or other person's name --
 * and not even the invitee's own email address. Anything this file wants to
 * display that is not in those three fields would have to be read from
 * somewhere the invitee has no right to read yet, which is the reason it is not
 * displayed.
 *
 * NOTHING HERE IS A PERMISSION. The three routines authorise themselves from
 * the caller's own confirmed address; the id in a card is a SELECTOR and never
 * a credential, so a guessed uuid and somebody else's real invitation produce
 * the same single refusal. This file decides what to draw.
 */

/** One row of `list_my_family_invitations()`, exactly as the routine declares it. */
export type FamilyInvitation = {
  invitation_id: string;
  area_name: string | null;
  /** The invited seat's own person name. Null if the seat names no person. */
  invited_as: string | null;
  invited_at: string | null;
};

export const INVITATIONS_PATH = "/invitations";

/** The family, named safely when the routine returned nothing to name it with. */
export function invitationFamilyName(invitation: FamilyInvitation): string {
  const name = (invitation.area_name ?? "").trim();
  return name === "" ? "a family" : name;
}

export function invitationTitle(invitation: FamilyInvitation): string {
  return `Invitation to ${invitationFamilyName(invitation)}`;
}

/**
 * THE SENTENCE THAT ASKS.
 *
 * It names the person the seat is for whenever the routine sent one, because
 * "you have been invited as Grandma" is how somebody notices they have been
 * invited as the wrong person -- which is the one mistake this screen can catch
 * before it becomes a membership.
 */
export function invitationBody(invitation: FamilyInvitation): string {
  const family = invitationFamilyName(invitation);
  const person = (invitation.invited_as ?? "").trim();
  return person === ""
    ? `You have been invited to join ${family}.`
    : `You have been invited to join ${family} as ${person}.`;
}

/**
 * Newest family first is wrong; the routine already orders by family name and
 * then by when the offer was made, and the screen keeps that order rather than
 * inventing a second one. This exists so a caller with rows from anywhere --
 * a test fixture, a cached payload -- lands on the same order the routine
 * would have produced.
 */
export function sortInvitations(rows: readonly FamilyInvitation[]): FamilyInvitation[] {
  return [...rows].sort((left, right) => {
    const byFamily = invitationFamilyName(left).localeCompare(invitationFamilyName(right));
    if (byFamily !== 0) return byFamily;
    return (left.invited_at ?? "").localeCompare(right.invited_at ?? "");
  });
}

/**
 * COPY, IN ONE PLACE, IN PRODUCT LANGUAGE.
 *
 * No "Area", no "app_member", no "Auth user", no routine name. The person
 * reading this has been invited to a FAMILY, and everything they are told has
 * to be true whether their Gift Planner account is approved or still waiting.
 */
export const INVITATION_COPY = {
  title: "Your invitations",
  lead: "Families that have asked you to join them. Nothing happens until you answer, and you can say no.",
  empty: "No invitations right now.",
  emptyBody:
    "When a family invites you, it will appear here. Ask whoever runs the family to send one to the email address you sign in with.",
  accept: "Accept",
  decline: "Decline",
  accepting: "Joining…",
  declining: "Declining…",
  /** Deliberately not "you have joined": approval may still be outstanding. */
  accepted: (family: string) => `You have joined ${family}.`,
  declined: (family: string) => `You turned down the invitation to ${family}.`,
  /**
   * THE ONE REFUSAL. 053 answers a guessed id, somebody else's invitation, an
   * already-answered one and a withdrawn one with the same sentence, and this
   * does not try to improve on that by guessing which it was.
   */
  refused: "That invitation is no longer available. It may have been answered or withdrawn already.",
  failed: "That could not be saved. Check your connection and try again.",
  /**
   * WHAT ACCEPTING DOES NOT DO WHILE APPROVAL IS OUTSTANDING. Said on the
   * pending screen only, where it is the difference between waiting calmly and
   * assuming the join failed.
   */
  pendingNote:
    "You can answer invitations now. A family you join will open as soon as your Gift Planner account is approved — you will not have to accept it again.",
} as const;
