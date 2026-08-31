"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { HOME_PATH, destinationFor } from "@/lib/account-status.ts";
import { INPUT_LIMITS, validateEmail } from "@/lib/input-validation";
import { loadAccountStatusClient } from "@/utils/supabase/account-status-client";
import { ensureAreaChosen } from "@/utils/supabase/area-choice-client";
import { createClient } from "@/utils/supabase/client";
import { AuthHeading, AuthScreen } from "../components/auth-card";
import { Button, Field, Input, Notice } from "../components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // Supabase only honours `redirect_to` when it matches the project's allowed
  // Redirect URLs; otherwise it falls back to the Site URL and an invite or
  // recovery link lands here instead of on /auth/callback — with perfectly
  // valid tokens sitting in the fragment that this page would otherwise ignore,
  // leaving the person staring at a sign-in form they have no password for.
  //
  // Hand the fragment on to /account-setup, which is the same handoff
  // /auth/callback performs for the implicit grant. It establishes the session,
  // claims the membership and sets a password. `replace` keeps the tokens out
  // of history.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || hash.length > 20_000) return;
    if (!/(?:^|[#&])(?:access_token|error|error_description)=/.test(hash)) return;
    window.location.replace(`/account-setup${hash}`);
  }, []);

  /*
   * SOMEBODY ALREADY SIGNED IN HAS NO BUSINESS ON THE SIGN-IN FORM, and where
   * they DO belong is now a question with five answers rather than two.
   *
   * This used to read `app_members` and bounce anybody holding an active
   * membership, which quietly meant that everybody else -- including an
   * approved account with no family, and including a rejected one -- was left
   * sitting on a form they had already filled in. The global status answers it
   * properly: `destinationFor` sends an unconfirmed address to `/check-email`,
   * an undecided account to `/account-pending`, a refused one to
   * `/account-rejected`, and an approved one into the app.
   *
   * `proxy.ts` used to do this; it cannot run on Cloudflare Workers.
   */
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const db = createClient();
      const auth = await db.auth.getUser();
      if (cancelled || !auth.data.user) return;
      const status = await loadAccountStatusClient();
      if (cancelled) return;
      const destination = destinationFor(status.state, "/login");
      if (!destination) return;
      // Only the approved go on into the app, and only they need a family
      // chosen before the first render. See `submit` below for why.
      if (destination === HOME_PATH) await ensureAreaChosen();
      if (!cancelled) router.replace(destination);
    };
    void check();
    return () => { cancelled = true; };
  }, [router]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage("");
    const normalizedEmail = validateEmail(email);
    if (!normalizedEmail.ok) { setMessage(normalizedEmail.error); setBusy(false); return; }
    const db = createClient();
    const result = await db.auth.signInWithPassword({ email: normalizedEmail.value, password });
    if (result.error) { setMessage("Email or password is incorrect."); setBusy(false); return; }

    /*
     * TAKE UP ANY INVITATION WAITING ON THIS ADDRESS, BEFORE ASKING WHERE TO GO.
     *
     * `claim_app_member()` is the only routine that may write
     * `app_members.user_id`, and it is safe to call on every sign-in: it
     * refuses an unconfirmed address (052), refuses a second seat in a family
     * this login already sits in, and returns false rather than raising when
     * there is nothing to claim.
     *
     * IT HAS TO RUN HERE AND NOT ONLY ON THE CONFIRMATION LINK. A family can
     * grant access at any time, including long after somebody signed up and
     * confirmed. Claiming only at `/auth/callback` would mean that invitation
     * sat unclaimed until the person happened to be sent another email.
     *
     * An error is swallowed on purpose. The claim improves this account's
     * situation; it is not the permission check, and letting a database hiccup
     * turn a valid sign-in into a refusal is exactly the failure Q19 exists to
     * remove.
     */
    await db.rpc("claim_app_member");

    /*
     * WHERE THIS ACCOUNT ACTUALLY BELONGS.
     *
     * WHAT THIS REPLACES, AND WHY IT WAS WRONG. Signing in used to read
     * `app_members` and, finding nothing, call `signOut()` and say "This
     * account does not have access to this Christmas." Under public sign-up
     * that is wrong in both directions at once:
     *
     *   an APPROVED account with no family was signed out of an account it is
     *     perfectly entitled to -- the commonest state there is, five minutes
     *     after being approved -- and
     *   a REJECTED account with a family was let in, because the membership row
     *     was all anybody asked about.
     *
     * Membership is not the question. The question is the global status, and
     * the database is the only thing that knows it.
     */
    const status = await loadAccountStatusClient();
    const destination = destinationFor(status.state, "/login");
    if (destination && destination !== HOME_PATH) { router.replace(destination); return; }

    /*
     * WHICH FAMILY THEY ARE SIGNING IN TO, settled here rather than left to the
     * first screen to discover.
     *
     * Signing in never wrote the Area cookie. For an account in one family that
     * was invisible -- every lookup falls back to the only membership there is.
     * For an account in two it was a LOCKOUT: `getCurrentMemberClient` refuses
     * to guess between memberships, `FamilyProvider` reads that refusal as
     * revoked access, and the session was signed out mid-render. Sign in, get
     * signed out, for ever.
     *
     * `FamilyProvider` now recovers from that on its own, and no longer signs
     * anybody out for it, so this line is not the only thing standing between
     * somebody and their app. It is here so the FIRST render is already about
     * the right family, instead of a dashboard that appears, discovers it has
     * no Area and reloads itself. An account with no family at all gets
     * "none" back and simply carries on to the onboarding at `/`.
     */
    await ensureAreaChosen();
    router.push(HOME_PATH); router.refresh();
  };

  return (
    <AuthScreen>
      <form onSubmit={submit}>
        <AuthHeading
          eyebrow="Gift planner"
          title="Welcome back"
          description="Sign in with your private family account."
        />
        <Field label="Email address" className="mt-7" required>
          <Input required type="email" autoComplete="email" maxLength={INPUT_LIMITS.email} value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Password" className="mt-4" required>
          <Input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <Button type="submit" size="lg" disabled={busy} className="mt-6 w-full">{busy ? "Signing in…" : "Sign in"}</Button>
        <Link href="/forgot-password" className="mt-5 block text-center text-sm font-semibold text-accent">Forgot password?</Link>
        {/*
          THE PUBLIC FRONT DOOR, and a real route rather than a development
          affordance. Ruled off from the sign-in form above it so it reads as
          the other thing you can do here, not as one more field.
        */}
        <div className="mt-6 border-t border-line pt-5 text-center">
          <p className="text-sm text-ink-600">New to Gift Planner?</p>
          <Link href="/sign-up" className="mt-1 inline-block text-sm font-semibold text-accent">
            Create an account
          </Link>
        </div>
        {message && <Notice tone="danger" className="mt-4">{message}</Notice>}
      </form>
    </AuthScreen>
  );
}
