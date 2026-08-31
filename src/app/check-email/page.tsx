"use client";

import Link from "next/link";
import { signOut } from "@/utils/supabase/sign-out";
import { AuthHeading, AuthScreen } from "../components/auth-card";
import { Button } from "../components/ui";

/**
 * SIGNED IN, AND THE ADDRESS IS STILL UNPROVEN.
 *
 * The one state that belongs to `auth.users` rather than to `app_accounts`:
 * somebody typed an address into a form and nobody has followed the link that
 * proves they own it. Until that happens the address means nothing --
 * `claim_app_member()` refuses an unconfirmed one (052 added that conjunct,
 * because signing up as somebody else's address used to be enough to walk into
 * their family), and `set_account_status` refuses to approve it.
 *
 * SO THERE IS NOTHING TO DO HERE BUT THE ONE THING. No app chrome, no
 * navigation into the family, and a way out: sign-out, which a shared device or
 * a mistyped address makes necessary.
 */
export default function CheckEmailPage() {
  return (
    <AuthScreen>
      <AuthHeading
        eyebrow="Gift Planner"
        title="Confirm your email address"
        description="Check your email to confirm your address."
      />
      <p className="mt-4 text-sm leading-6 text-ink-600">
        We sent a link to the address you signed up with. Opening it proves the address is
        yours, and it is the only way to carry on.
      </p>
      <p className="mt-4 text-sm leading-6 text-ink-600">
        Confirming your address is not the same as being let in. A Gift Planner administrator
        reviews every new account afterwards, and you will see that step next.
      </p>
      <Button
        variant="secondary"
        size="lg"
        onClick={() => { void signOut(); }}
        className="mt-6 w-full"
      >
        Sign out
      </Button>
      <Link href="/login" className="mt-5 block text-center text-sm font-semibold text-accent">
        Back to sign in
      </Link>
    </AuthScreen>
  );
}
