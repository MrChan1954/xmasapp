"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "../../../utils/supabase/client";
import { AuthHeading, AuthScreen } from "../components/auth-card";
import { Button, Field, Input, Notice } from "../components/ui";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 8) { setMessage("Use at least 8 characters."); return; }
    if (password !== confirm) { setMessage("Passwords do not match."); return; }
    const result = await createClient().auth.updateUser({ password });
    if (result.error) { setMessage("Your password could not be saved. Request a new reset link and try again."); return; }
    router.push("/");
    router.refresh();
  };

  return (
    <AuthScreen>
      <form onSubmit={submit}>
        <AuthHeading title="Choose your password" />
        <Field label="New password" className="mt-6" required>
          <Input required minLength={8} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <Field label="Confirm password" className="mt-4" required>
          <Input required minLength={8} type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        </Field>
        <Button type="submit" size="lg" className="mt-6 w-full">Save password</Button>
        {message && <Notice tone="danger" className="mt-4">{message}</Notice>}
      </form>
    </AuthScreen>
  );
}
