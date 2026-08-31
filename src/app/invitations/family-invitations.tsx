"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  INVITATION_COPY,
  invitationBody,
  invitationFamilyName,
  invitationTitle,
  sortInvitations,
  type FamilyInvitation,
} from "@/lib/invitations";
import { describeThrown } from "@/lib/supabase-error";
import { createClient } from "@/utils/supabase/client";
import { Button, EmptyState, Notice, Skeleton } from "../components/ui";

/**
 * THE INVITATION LIST, AND THE TWO ANSWERS.
 *
 * ==========================================================================
 *  ONE COMPONENT, FOUR PLACES, BECAUSE THE ANSWER MUST NOT DEPEND ON WHERE IT
 *  WAS ASKED.
 * ==========================================================================
 *
 * It renders on `/invitations`, on the pending-account screen, on the
 * zero-family onboarding and above the family chooser. Four surfaces, one
 * implementation -- so an invitation cannot be actionable on one screen and
 * silently different on another, and there is one place to get the refusal
 * copy right.
 *
 * IT READS AND WRITES ONLY THROUGH THE THREE ROUTINES, WITH THE CALLER'S OWN
 * SESSION.
 *
 *   list_my_family_invitations()      no parameter at all. It resolves the
 *                                     caller from `auth.uid()` and their
 *                                     address from `auth.users`, so there is
 *                                     nothing here to point at anybody else,
 *                                     and no email or user id is ever sent.
 *   accept_family_invitation(id)      the id is a SELECTOR, never a
 *   decline_family_invitation(id)     credential. A guessed uuid and a real
 *                                     invitation belonging to somebody else
 *                                     produce the same refusal, so knowing one
 *                                     buys nothing.
 *
 * THIS FILE NEVER WRITES `app_members`. Attaching a login to a seat is
 * `accept_family_invitation`'s single two-column UPDATE and nothing else's,
 * because only the invitee can prove which login is theirs and only they can
 * consent. There is no `.from("app_members")` here and there must never be one.
 *
 * AND IT IS NOT AREA-SCOPED. No `FamilyProvider`, no acting Area, no `gp_area`.
 * `createClient()` will attach an `x-area-id` header if the cookie happens to
 * exist, and it changes nothing: none of the three routines reads the acting
 * Area, so a cookie naming a family this account has never been in is inert
 * here. That is what lets somebody with no families at all use this screen.
 *
 * ZERO ROWS IS NOT AN ERROR, and the routine is built so it cannot be told from
 * one: signed out, unconfirmed address, and nothing pending all return an empty
 * set rather than raising. So the empty state below is the honest answer to all
 * three and discloses none of them.
 */
export function FamilyInvitations({
  reloadOnAccept = false,
  compact = false,
}: {
  /**
   * Whether joining a family should reload the page rather than merely refresh
   * the server components around this one. The ROOT passes true: its family
   * chooser and its onboarding branch were both chosen on the server from an
   * `areas` list that is now one family short, and which of the three shapes
   * the front door takes has genuinely changed. `/invitations` passes false,
   * because refreshing this list IS the whole update there.
   *
   * A boolean rather than a callback, so a Server Component can set it.
   */
  reloadOnAccept?: boolean;
  /** Render nothing at all when there is nothing waiting. */
  compact?: boolean;
} = {}) {
  const router = useRouter();
  const [invitations, setInvitations] = useState<FamilyInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await createClient().rpc("list_my_family_invitations");
      if (result.error) {
        setError(INVITATION_COPY.failed);
        return;
      }
      setError(null);
      setInvitations(sortInvitations((result.data ?? []) as FamilyInvitation[]));
    } catch (thrown) {
      setError(describeThrown(thrown, INVITATION_COPY.failed));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  /**
   * BOTH ANSWERS GO THROUGH HERE, because their failure handling has to be
   * identical. 053 refuses a guessed id, another person's invitation, an
   * already-answered one and a withdrawn one with ONE sentence at 42501, and
   * this shows one sentence back rather than trying to work out which it was.
   * Then it reloads: whatever the row's real state is, the list is now it.
   */
  const answer = async (
    invitation: FamilyInvitation,
    kind: "accept" | "decline",
  ) => {
    setBusy(`${kind}:${invitation.invitation_id}`);
    setError(null);
    setNotice(null);
    const family = invitationFamilyName(invitation);
    try {
      const db = createClient();
      const result = kind === "accept"
        ? await db.rpc("accept_family_invitation", { p_invitation_id: invitation.invitation_id })
        : await db.rpc("decline_family_invitation", { p_invitation_id: invitation.invitation_id });

      if (result.error) {
        setError(result.error.code === "42501" ? INVITATION_COPY.refused : INVITATION_COPY.failed);
        await load(true);
        return;
      }

      setNotice(kind === "accept" ? INVITATION_COPY.accepted(family) : INVITATION_COPY.declined(family));
      await load(true);

      if (kind === "accept") {
        /*
         * THE FAMILY LIST IS NOW STALE EVERYWHERE ELSE, and only the server
         * knows the new one -- `areas` sits behind `is_area_member`, so the
         * membership that was just created is the thing that changes the
         * answer. `router.refresh()` re-runs the server components around this
         * one; the root additionally hands us a full reload, because its
         * chooser was rendered before this membership existed.
         *
         * NOBODY IS FORCED INTO THE NEW FAMILY. `accept_family_invitation`
         * returns the Area id and this deliberately does not select it: the
         * acting Area is the reader's choice, and switching it because they
         * accepted an invitation is exactly the silent commitment the chooser
         * exists to prevent.
         */
        router.refresh();
        if (reloadOnAccept) window.location.assign(new URL("/", window.location.origin).toString());
      }
    } catch (thrown) {
      setError(describeThrown(thrown, INVITATION_COPY.failed));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div role="status" aria-label="Loading your invitations" className="space-y-3">
        <Skeleton className="h-28 rounded-2xl" />
        {!compact && <Skeleton className="h-28 rounded-2xl" />}
      </div>
    );
  }

  return (
    <div>
      <div aria-live="polite" aria-atomic="true">
        {notice && <Notice tone="success" className="mb-4" onDismiss={() => setNotice(null)}>{notice}</Notice>}
        {error && <Notice tone="danger" className="mb-4" onDismiss={() => setError(null)}>{error}</Notice>}
      </div>

      {invitations.length === 0 ? (
        compact ? null : (
          <EmptyState
            illustration="wreath"
            title={INVITATION_COPY.empty}
            body={INVITATION_COPY.emptyBody}
          />
        )
      ) : (
        <ul className="space-y-3">
          {invitations.map((invitation) => {
            const working = busy?.endsWith(`:${invitation.invitation_id}`) ?? false;
            return (
              <li
                key={invitation.invitation_id}
                className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"
              >
                <h2 className="font-display text-lg leading-tight font-semibold">
                  {invitationTitle(invitation)}
                </h2>
                <p className="mt-2 text-sm leading-6 text-ink-600">{invitationBody(invitation)}</p>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <Button
                    size="lg"
                    disabled={busy !== null}
                    onClick={() => void answer(invitation, "accept")}
                  >
                    {working && busy?.startsWith("accept:") ? INVITATION_COPY.accepting : INVITATION_COPY.accept}
                  </Button>
                  <Button
                    variant="secondary"
                    size="lg"
                    disabled={busy !== null}
                    onClick={() => void answer(invitation, "decline")}
                  >
                    {working && busy?.startsWith("decline:") ? INVITATION_COPY.declining : INVITATION_COPY.decline}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
