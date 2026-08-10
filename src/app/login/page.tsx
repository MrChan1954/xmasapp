"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { INPUT_LIMITS, validateEmail } from "@/lib/input-validation";
import { createClient } from "../../../utils/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage("");
    const normalizedEmail = validateEmail(email);
    if (!normalizedEmail.ok) { setMessage(normalizedEmail.error); setBusy(false); return; }
    const db = createClient();
    const result = await db.auth.signInWithPassword({ email: normalizedEmail.value, password });
    if (result.error) { setMessage("Email or password is incorrect."); setBusy(false); return; }
    const member = await db.from("app_members").select("id").eq("user_id", result.data.user.id).eq("active", true).maybeSingle();
    if (!member.data) { await db.auth.signOut(); setMessage("This account does not have access to this Christmas."); setBusy(false); return; }
    router.push("/"); router.refresh();
  };

  return <main className="flex min-h-screen items-center justify-center bg-[#f8f8f6] px-5"><form onSubmit={submit} className="w-full max-w-md rounded-3xl bg-white p-7 shadow-sm sm:p-9"><p className="text-sm font-semibold text-[#28685c]">Christmas 2026</p><h1 className="mt-2 text-3xl font-bold">Family Christmas Planner</h1><p className="mt-3 text-sm text-[#7b8581]">Sign in with your private family account.</p><label className="mt-7 block text-sm font-semibold">Email address<input required type="email" autoComplete="email" maxLength={INPUT_LIMITS.email} value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 h-12 w-full rounded-xl border px-3" /></label><label className="mt-4 block text-sm font-semibold">Password<input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-12 w-full rounded-xl border px-3" /></label><button disabled={busy} className="mt-5 h-12 w-full rounded-xl bg-[#1f5b50] font-bold text-white disabled:opacity-50">{busy ? "Signing in..." : "Sign in"}</button><Link href="/forgot-password" className="mt-5 block text-center text-sm font-semibold text-[#28685c]">Forgot password?</Link>{message && <p className="mt-4 text-sm text-[#a5543f]">{message}</p>}</form></main>;
}
