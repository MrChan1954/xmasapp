"use client";

import { signOut } from "@/utils/supabase/sign-out";
import { AuthHeading, AuthScreen } from "../components/auth-card";
import { Button } from "../components/ui";

/**
 * APPROVED TO SIGN IN, NOT APPROVED TO BE HERE.
 *
 * The screen for the state migration 052 exists to create. A missing
 * `app_accounts` row and an explicit `status = 'pending'` row both land here,
 * because undecided is undecided and the answer must not depend on whether a
 * row happens to have been written yet.
 *
 * WHAT THE COPY HAS TO GET RIGHT, and why each sentence is here:
 *
 *   * The address IS confirmed. Somebody who has just followed a link needs to
 *     know that step worked, or they will keep following it.
 *   * The remaining approval is GIFT PLANNER'S, not any family's. An Area
 *     administrator cannot grant it and must not be asked to, so this screen
 *     never suggests chasing one.
 *   * The two things are INDEPENDENT and can happen in either order. A family
 *     may have already granted access -- `grant_area_access` works perfectly
 *     well against an account nobody has approved yet -- and that access simply
 *     starts working the moment approval arrives. Saying so is the difference
 *     between waiting and assuming something has gone wrong.
 *
 * NO APP CHROME. `/account-pending` is a global route: `AppFrame` renders it
 * bare and `FamilyProvider` loads no Area for it, so there is no rail, no tab
 * bar and no membership read. Sign-out is the only control, because it is the
 * only thing this account can actually do.
 */
export default function AccountPendingPage() {
  return (
    <AuthScreen>
      <AuthHeading
        eyebrow="Gift Planner"
        title="Waiting for an admin to approve your account."
        description="Your email address is confirmed. Nothing else is needed from you."
      />
      <div className="mt-6 space-y-4 text-sm leading-6 text-ink-600">
        <p>
          Every Gift Planner account is reviewed by a Gift Planner administrator before it can
          be used. That review is the only thing outstanding, and it is not something a family
          can do for you.
        </p>
        <p>
          Joining a family is a separate step, and the two do not depend on each other. If
          somebody has already given you access to theirs, it will be waiting for you as soon
          as your account is approved — you do not need to ask them again.
        </p>
        <p>
          Sign in again later to check. You will come straight to this screen until the
          decision is made.
        </p>
      </div>
      <Button
        variant="secondary"
        size="lg"
        onClick={() => { void signOut(); }}
        className="mt-6 w-full"
      >
        Sign out
      </Button>
    </AuthScreen>
  );
}
