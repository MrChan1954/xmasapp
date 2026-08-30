"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { INPUT_LIMITS, validateEmail } from "@/lib/input-validation";
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

  // Someone already signed in has no business on the sign-in form. `proxy.ts`
  // used to send them home; it cannot run on Cloudflare Workers, so the check
  // happens here. Only an active member is bounced — a revoked account must be
  // able to see the access_denied message rather than be looped back to it.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const db = createClient();
      const auth = await db.auth.getUser();
      if (cancelled || !auth.data.user) return;
      // Any active membership means they are already signed in and belong
      // somewhere. `.limit(1)`: a login in two families has two.
      const member = await db
        .from("app_members")
        .select("id")
        .eq("user_id", auth.data.user.id)
        .eq("active", true)
        .limit(1)
        .maybeSingle();
      if (cancelled || !member.data) return;
      // Same reason as in `submit` below: they belong somewhere, so the browser
      // must know WHICH somewhere before the app is rendered.
      await ensureAreaChosen();
      if (!cancelled) router.replace("/");
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
    // `.limit(1)`: an account in two families has two memberships, and without it
    // `maybeSingle()` errors and locks them out of their own login.
    const member = await db.from("app_members").select("id").eq("user_id", result.data.user.id).eq("active", true).limit(1).maybeSingle();
    if (!member.data) { await db.auth.signOut(); setMessage("This account does not have access to this Christmas."); setBusy(false); return; }
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
     * `FamilyProvider` now recovers from that on its own, so this line is not
     * the only thing standing between somebody and their app. It is here so the
     * FIRST render is already about the right family, instead of a dashboard
     * that appears, discovers it has no Area and reloads itself.
     */
    await ensureAreaChosen();
    router.push("/"); router.refresh();
  };

  return (
    <AuthScreen>
      <form onSubmit={submit}>
        <AuthHeading
          eyebrow="Family gift planner"
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
        {message && <Notice tone="danger" className="mt-4">{message}</Notice>}
      </form>
    </AuthScreen>
  );
}
