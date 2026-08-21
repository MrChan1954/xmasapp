"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { INPUT_LIMITS, validateRequiredText } from "@/lib/input-validation";
import { createClient } from "@/utils/supabase/client";
import { AuthHeading, AuthScreen } from "../components/auth-card";
import { Button, ButtonLink, Field, Input, Notice } from "../components/ui";

type Stage = "checking" | "ready" | "saving" | "error";

export default function AccountSetupPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("checking");
  const [personName, setPersonName] = useState("family member");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");

  // Read the fragment during the first render, BEFORE the effect strips it from
  // the address bar. Reading it inside the effect made this whole flow
  // single-shot: React re-invokes effects in development, and the second pass
  // found an address bar that the first pass had already cleaned, so a perfectly
  // good link reported "no tokens".
  const [link] = useState(() =>
    typeof window === "undefined"
      ? { hash: "", query: "" }
      : { hash: window.location.hash, query: window.location.search },
  );
  // The tokens are single-use: exchanging them twice would burn the link.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const prepareSession = async () => {
      const rawHash = link.hash;
      const rawQuery = link.query;

      // Remove sensitive auth material from the address bar before making any
      // further requests. Tokens are never logged or stored in component state.
      if (rawHash || rawQuery) {
        window.history.replaceState(window.history.state, "", window.location.pathname);
      }
      console.info(`[account-setup] link received | hashLength=${rawHash.length} queryLength=${rawQuery.length}`);
      if (rawHash.length > 20_000 || rawQuery.length > 2_048) {
        setMessage("This setup link is invalid or has expired. Ask the Global Admin for a new link.");
        setStage("error");
        return;
      }

      const hash = new URLSearchParams(rawHash.slice(1));
      const query = new URLSearchParams(rawQuery);
      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      const authError = hash.has("error_description") || hash.has("error") || query.has("error");

      if (authError) {
        // Supabase reports its own rejection reason here (expired OTP, already
        // used, redirect not allowed) — surface it rather than discarding it.
        console.error(
          `[account-setup] provider returned an error | ${hash.get("error") ?? query.get("error") ?? ""} ${hash.get("error_code") ?? query.get("error_code") ?? ""} ${hash.get("error_description") ?? query.get("error_description") ?? ""}`.trim(),
        );
        setMessage("This setup link is invalid or has expired. Ask the Global Admin for a new link.");
        setStage("error");
        return;
      }

      const supabase = createClient();
      if ((accessToken || refreshToken) && (!isReasonableAuthToken(accessToken) || !isReasonableAuthToken(refreshToken))) {
        setMessage("This setup link is invalid or has expired. Ask the Global Admin for a new link.");
        setStage("error");
        return;
      }
      if (accessToken && refreshToken) {
        const session = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (session.error) {
          // Never log the tokens themselves — only why Supabase rejected them.
          // A one-time link that has already been opened, and a link that has
          // simply timed out, produce the same message but need different
          // answers, so the distinction has to be visible somewhere.
          console.error(
            `[account-setup] setSession rejected | status=${session.error.status} code=${session.error.code} message=${session.error.message}`,
          );
          setMessage("This setup link is invalid or has expired. Ask the Global Admin for a new link.");
          setStage("error");
          return;
        }
      } else {
        console.error(
          `[account-setup] no tokens in link | hasAccessToken=${Boolean(accessToken)} hasRefreshToken=${Boolean(refreshToken)}`,
        );
      }

      const userResult = await supabase.auth.getUser();
      if (userResult.error || !userResult.data.user) {
        console.error(
          `[account-setup] getUser failed | status=${userResult.error?.status} code=${userResult.error?.code} message=${userResult.error?.message}`,
        );
        setMessage("This setup link is invalid or has expired. Ask the Global Admin for a new link.");
        setStage("error");
        return;
      }

      // Bind this auth user to the app_members row the admin pre-approved for
      // their email. /auth/callback does this on the PKCE branch, but invite
      // links use Supabase's implicit grant and land here instead — without the
      // claim, user_id stays NULL, the RLS policy on app_members
      // (user_id = auth.uid()) hides the row, and the check below would report a
      // perfectly valid invitee as unapproved.
      //
      // A `false` return just means the row was already claimed; only a genuine
      // error is worth stopping for, and the membership check is the real gate.
      const claim = await supabase.rpc("claim_app_member");
      if (claim.error) {
        await supabase.auth.signOut();
        setMessage("This account is not approved for the Christmas app. Ask the Global Admin for help.");
        setStage("error");
        return;
      }

      const membership = await supabase
        .from("app_members")
        .select("person_id, active")
        .eq("user_id", userResult.data.user.id)
        .maybeSingle();

      if (membership.error || !membership.data?.active || !membership.data.person_id) {
        await supabase.auth.signOut();
        setMessage("This account is not approved for the Christmas app. Ask the Global Admin for help.");
        setStage("error");
        return;
      }

      const person = await supabase
        .from("people")
        .select("name")
        .eq("id", membership.data.person_id)
        .maybeSingle();

      const candidateName = person.data?.name ?? userResult.data.user.user_metadata?.name;
      const safeName = validateRequiredText(candidateName, { field: "a name", maxLength: INPUT_LIMITS.name });
      setPersonName(safeName.ok ? safeName.value : "family member");
      setStage("ready");
    };

    void prepareSession();
    // No cancellation flag: the `started` ref already guarantees this runs once,
    // and a flag set by the development re-invoke would suppress the real run's
    // results, leaving the page stuck on "checking".
  }, [link]);

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 8) {
      setMessage("Use at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }

    setStage("saving");
    setMessage("");
    const result = await createClient().auth.updateUser({ password });
    if (result.error) {
      setMessage("Your password could not be saved. Request a new setup link and try again.");
      setStage("ready");
      return;
    }

    router.replace("/");
    router.refresh();
  };

  return (
    <AuthScreen>
      {stage === "checking" ? (
        <div role="status" className="py-4">
          <AuthHeading title="Opening your secure link" description="Please wait while we verify your account." />
        </div>
      ) : stage === "error" ? (
        <div>
          <AuthHeading title="This link could not be opened" />
          <Notice tone="danger" className="mt-4">{message}</Notice>
          <div className="mt-6">
            <ButtonLink href="/login" size="lg" className="w-full">Back to login</ButtonLink>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void savePassword(event)}>
          <AuthHeading
            eyebrow={`Welcome, ${personName}`}
            title="Create your password"
            description="Choose the password you will use with your email on future visits."
          />
          <Field label="New password" className="mt-6" required>
            <Input
              required
              minLength={8}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field label="Confirm password" className="mt-4" required>
            <Input
              required
              minLength={8}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>
          <Button type="submit" size="lg" disabled={stage === "saving"} className="mt-6 w-full">
            {stage === "saving" ? "Saving..." : "Create password"}
          </Button>
          {message && <Notice tone="danger" className="mt-4">{message}</Notice>}
        </form>
      )}
    </AuthScreen>
  );
}

function isReasonableAuthToken(value: string | null): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8_192 && !/[\u0000-\u0020\u007f-\u009f]/u.test(value);
}
