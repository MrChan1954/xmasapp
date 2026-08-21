"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { INPUT_LIMITS, validateEmail } from "@/lib/input-validation";
import { createClient } from "@/utils/supabase/client";
import { AuthHeading, AuthScreen } from "../components/auth-card";
import { Button, Field, Input, Notice } from "../components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    const normalized = validateEmail(email);
    if (!normalized.ok) {
      setMessage(normalized.error);
      setBusy(false);
      return;
    }
    const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;
    const sent = await createClient().auth.resetPasswordForEmail(normalized.value, { redirectTo });

    // The message stays deliberately vague either way — it must not reveal
    // which addresses have accounts. But the failure still has to be visible
    // somewhere, otherwise a dead SMTP configuration is indistinguishable from
    // a successful send and nobody finds out until an invite silently fails.
    if (sent.error) {
      console.error(
        `[forgot-password] reset email failed | status=${sent.error.status} code=${sent.error.code} message=${sent.error.message} redirectTo=${redirectTo}`,
      );
    }

    setMessage("If this email has an active family account, a secure reset link is on its way.");
    setBusy(false);
  };

  return (
    <AuthScreen>
      <form onSubmit={(event) => void submit(event)}>
        <AuthHeading
          title="Reset your password"
          description="We will email you a secure reset link."
        />
        <Field label="Email address" className="mt-6" required>
          <Input
            required
            type="email"
            autoComplete="email"
            maxLength={INPUT_LIMITS.email}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Button type="submit" size="lg" disabled={busy} className="mt-5 w-full">
          {busy ? "Sending..." : "Send reset link"}
        </Button>
        {message && <Notice tone="info" className="mt-4">{message}</Notice>}
        <Link href="/login" className="mt-5 block text-center text-sm font-semibold text-accent">Back to sign in</Link>
      </form>
    </AuthScreen>
  );
}
