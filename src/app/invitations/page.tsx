import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { destinationFor } from "@/lib/account-status";
import { INVITATION_COPY, INVITATIONS_PATH } from "@/lib/invitations";
import { loadAccountStatus } from "@/utils/supabase/account-status-server";
import { ButtonLink } from "../components/ui";
import { FamilyInvitations } from "./family-invitations";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your invitations",
  description: "Families that have invited you to join them.",
};

/**
 * THE ONE SCREEN THAT WORKS BEFORE YOU BELONG ANYWHERE.
 *
 * A BARE, GLOBAL ROUTE, and it has to be. `/invitations` is listed in
 * `GLOBAL_ROUTES`, so `AppFrame` draws it without chrome and `FamilyProvider`
 * does none of its Area work on it -- no membership resolution, no
 * `ensureAreaChosen`, no realtime subscription. Every other signed-in screen
 * resolves an acting Area first; this one cannot, because the whole point is
 * that the reader may be in no family at all.
 *
 * That also makes a stale `gp_area` irrelevant here rather than dangerous: no
 * code on this path reads it, and none of the three routines behind the list
 * consults the acting Area.
 *
 * WHO MAY BE HERE, AND THE ONE RULE THAT IS NEW.
 *
 *   approved            yes, with or without families.
 *   PENDING             YES -- and this is the addition. Everywhere else,
 *                       `destinationFor` sends a pending account to
 *                       `/account-pending` and keeps it there. Answering an
 *                       invitation is the one thing it may usefully do while
 *                       it waits, and migration 053 permits exactly that:
 *                       accepting while pending creates a membership that
 *                       grants NOTHING until approval, because every
 *                       permission predicate already carries
 *                       `is_globally_approved()`. So there is no new gate to
 *                       write and no new state to reach.
 *   email_unverified    no. `list_my_family_invitations()` returns zero rows
 *                       for an unconfirmed address anyway, so this redirect
 *                       only saves them an empty screen.
 *   rejected/suspended  no. They are sent to the screen that explains itself,
 *                       and 053 refuses their accept independently.
 *   signed out          `/login`.
 *
 * NONE OF THIS IS THE BOUNDARY. `list_my_family_invitations()` resolves the
 * caller from `auth.uid()` and takes no parameter, and accept and decline
 * authorise themselves against the caller's own confirmed address. This decides
 * what is rendered; the database decides what may be read or answered.
 */
export default async function InvitationsPage() {
  const status = await loadAccountStatus();

  const destination = destinationFor(status.state, INVITATIONS_PATH);
  if (destination) redirect(destination);

  const pending = status.state === "pending";

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <div className="text-xs font-semibold tracking-eyebrow text-gold uppercase">Gift Planner</div>
      <h1 className="mt-2 font-display text-[clamp(1.75rem,5vw,2.5rem)] leading-[1.1] font-semibold tracking-tight">
        {INVITATION_COPY.title}
      </h1>
      <p className="mt-3 text-sm leading-6 text-ink-600">{INVITATION_COPY.lead}</p>

      {pending && (
        <p className="mt-4 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm leading-6 text-ink-600">
          {INVITATION_COPY.pendingNote}
        </p>
      )}

      <div className="mt-7">
        <FamilyInvitations />
      </div>

      <div className="mt-8">
        <ButtonLink href={pending ? "/account-pending" : "/"} variant="secondary" size="lg">
          {pending ? "Back to your account" : "Back to Gift Planner"}
        </ButtonLink>
      </div>
    </main>
  );
}
