"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { INPUT_LIMITS, validateEmail } from "@/lib/input-validation";
import { createClient } from "@/utils/supabase/client";
import { AuthHeading, AuthScreen } from "../components/auth-card";
import { Button, Field, Input, Notice } from "../components/ui";

/**
 * The public front door.
 *
 * WHAT SIGNING UP DOES, AND THE THREE THINGS IT DOES NOT DO. It creates an
 * `auth.users` row and sends a confirmation email. It does NOT approve the
 * account for Gift Planner, does NOT put anybody in a family, and does NOT
 * grant one row of anything -- migration 052 made those three separate facts,
 * and this form only establishes the first.
 *
 * ENUMERATION RESISTANCE IS THE WHOLE OF THE ERROR HANDLING. Every normal
 * outcome -- a brand new address, an address that already has an account, an
 * address that has one and has never confirmed it -- ends on the same sentence,
 * because a form that answers those three differently is a way to find out who
 * has an account here. Supabase already obfuscates the second case when Confirm
 * Email is on; this does not rely on that, and treats a refusal the same way.
 *
 * NO PARALLEL FORM SYSTEM. `AuthScreen`, `AuthHeading`, `Field`, `Input`,
 * `Button` and `Notice` are the same primitives `/login` and `/account-setup`
 * use, so the public entrance matches the app it opens onto.
 */

/** Long enough to matter, and the same rule `/account-setup` already applies. */
const MINIMUM_PASSWORD_LENGTH = 8;

/**
 * The one sentence every successful sign-up ends on. Exported so the test can
 * assert the copy the screen actually renders rather than a copy of it.
 */
export const SIGN_UP_NEUTRAL_SUCCESS = "Check your email to confirm your address.";

export default function SignUpPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const doneHeading = useRef<HTMLDivElement>(null);

  // The form is replaced by a confirmation, which for a screen reader is a
  // silent change of everything. Moving focus to the new heading is the same
  // pattern `/account-setup` uses when its own stage changes.
  useEffect(() => { if (sent) doneHeading.current?.focus(); }, [sent]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    const normalizedEmail = validateEmail(email);
    if (!normalizedEmail.ok) { setError(normalizedEmail.error); setBusy(false); return; }
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
      setBusy(false);
      return;
    }
    if (password !== confirmPassword) { setError("Passwords do not match."); setBusy(false); return; }

    const db = createClient();
    const result = await db.auth.signUp({
      email: normalizedEmail.value,
      password,
      options: {
        // Where the confirmation link comes back to. `/auth/callback` exchanges
        // the code, claims any invitation waiting on this address and then
        // hands over to the status routing like every other entry point.
        emailRedirectTo: new URL("/auth/callback", window.location.origin).toString(),
      },
    });

    if (result.error) {
      /*
       * DELIBERATELY NOT `result.error.message`. Supabase distinguishes "user
       * already registered" from a weak password from a rate limit, and
       * forwarding any of them turns this form into a lookup service. The real
       * reason is worth having, so it is logged where only the server operator
       * sees it and never rendered.
       */
      console.error(`[sign-up] refused | status=${result.error.status} code=${result.error.code}`);
      setSent(true);
      setBusy(false);
      return;
    }

    /*
     * A SESSION HERE MEANS CONFIRM EMAIL IS OFF in the Auth project. That is not
     * the intended configuration and the launch checklist turns it on, but the
     * runtime must not fall over if it is ever off: the account is signed in
     * and unapproved, so a full load sends it through the ordinary status
     * routing, which lands it on `/account-pending`.
     */
    if (result.data.session) {
      window.location.assign(new URL("/", window.location.origin).toString());
      return;
    }

    setSent(true);
    setBusy(false);
  };

  if (sent) {
    return (
      <AuthScreen>
        <div ref={doneHeading} tabIndex={-1} className="outline-none">
          <AuthHeading
            eyebrow="Gift Planner"
            title="Almost there"
            description={SIGN_UP_NEUTRAL_SUCCESS}
          />
        </div>
        <p className="mt-4 text-sm leading-6 text-ink-600">
          Follow the link in that email to confirm you own the address. After that, a Gift
          Planner administrator reviews your account before it can be used — you will not be
          able to open the app until they have.
        </p>
        <p className="mt-4 text-sm leading-6 text-ink-600">
          Nothing arrives in a minute or two? Check the spam folder, then try again with the
          same address.
        </p>
        <Link href="/login" className="mt-6 block text-center text-sm font-semibold text-accent">
          Back to sign in
        </Link>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <form onSubmit={(event) => void submit(event)}>
        <AuthHeading
          eyebrow="Gift Planner"
          title="Create an account"
          description="Plan and share the cost of Christmas, birthdays and every other family occasion."
        />
        <Field label="Email address" className="mt-7" required>
          <Input
            required
            type="email"
            autoComplete="email"
            maxLength={INPUT_LIMITS.email}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field
          label="Password"
          className="mt-4"
          required
          hint={`At least ${MINIMUM_PASSWORD_LENGTH} characters.`}
        >
          <Input
            required
            minLength={MINIMUM_PASSWORD_LENGTH}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label="Confirm password" className="mt-4" required>
          <Input
            required
            minLength={MINIMUM_PASSWORD_LENGTH}
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </Field>
        <Button type="submit" size="lg" disabled={busy} className="mt-6 w-full">
          {busy ? "Creating account…" : "Create account"}
        </Button>
        <Link href="/login" className="mt-5 block text-center text-sm font-semibold text-accent">
          Already have an account? Sign in
        </Link>
        {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
      </form>
    </AuthScreen>
  );
}
