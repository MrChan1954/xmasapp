"use client";

import { signOut } from "@/utils/supabase/sign-out";
import { AuthHeading, AuthScreen } from "../components/auth-card";
import { Button } from "../components/ui";

/**
 * THE REFUSAL, SAID ONCE.
 *
 * `rejected` and `suspended` both arrive here, and that is a security decision
 * rather than a shortcut. They are distinct in the catalogue -- one is a
 * decision about a new account, the other is a decision about an established
 * one -- and telling them apart on this screen would let somebody probe which
 * was taken about them. Neither answer is any use to the person reading it, and
 * the difference is only ever of interest to whoever made the decision.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *
 *   * No reason, and no decision note. The note exists for the administrators'
 *     own record, not to be argued with.
 *   * No family name and no count of families. A refused account is blocked
 *     from every Area at the database, and this screen must not become the one
 *     place that still says which ones it was in.
 *   * No administrator's name or address. Naming a person here turns a system
 *     decision into somebody to pursue.
 *   * No retry, no appeal form and no support address. Gift Planner is a
 *     private family planner with no support desk; inventing one would be a
 *     dead end dressed up as a next step.
 *
 * Sign-out is the only control, and it is genuinely useful: this is how a
 * shared device gets its owner back.
 */
export default function AccountRejectedPage() {
  return (
    <AuthScreen>
      <AuthHeading
        eyebrow="Gift Planner"
        title="This account cannot use Gift Planner"
        description="Your sign-in worked. The account is not able to open the app."
      />
      <p className="mt-4 text-sm leading-6 text-ink-600">
        If you believe this is a mistake, speak to whoever asked you to join.
      </p>
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
