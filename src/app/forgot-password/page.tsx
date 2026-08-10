"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { INPUT_LIMITS, validateEmail } from "@/lib/input-validation";
import { createClient } from "../../../utils/supabase/client";

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
    await createClient().auth.resetPasswordForEmail(normalized.value, { redirectTo });

    setMessage("If this email has an active family account, a secure reset link is on its way.");
    setBusy(false);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8f8f6] px-5">
      <form onSubmit={(event) => void submit(event)} className="w-full max-w-md rounded-3xl bg-white p-7 shadow-sm sm:p-9">
        <h1 className="text-3xl font-bold">Reset your password</h1>
        <p className="mt-3 text-sm text-[#7b8581]">We will email you a secure reset link.</p>
        <label className="mt-6 block text-sm font-semibold">
          Email address
          <input
            required
            type="email"
            autoComplete="email"
            maxLength={INPUT_LIMITS.email}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-2 h-12 w-full rounded-xl border px-3"
          />
        </label>
        <button disabled={busy} className="mt-4 h-12 w-full rounded-xl bg-[#1f5b50] font-bold text-white disabled:opacity-50">
          {busy ? "Sending..." : "Send reset link"}
        </button>
        {message && <p role="status" className="mt-4 text-sm text-[#7b8581]">{message}</p>}
        <Link href="/login" className="mt-5 block text-center text-sm font-semibold text-[#28685c]">Back to sign in</Link>
      </form>
    </main>
  );
}
