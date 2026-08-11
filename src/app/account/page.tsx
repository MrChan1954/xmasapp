"use client";

<<<<<<< HEAD
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { createClient } from "../../../utils/supabase/client";
=======
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { createClient } from "../../../utils/supabase/client";
import { AppShell, PageHeader } from "../components/app-shell";
import { Button, Field, Input, Notice } from "../components/ui";
>>>>>>> 7534a2d (redesign and realtime)

export default function AccountPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => { void createClient().auth.getUser().then(({ data }) => setEmail(data.user?.email ?? "")); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 8 || password !== confirm) { setMessage(password !== confirm ? "Passwords do not match." : "Use at least 8 characters."); return; }
    const result = await createClient().auth.updateUser({ password });
    setMessage(result.error ? "Your password could not be updated. Sign in again and retry." : "Password updated.");
    if (!result.error) { setPassword(""); setConfirm(""); }
  };

  const signOut = async () => {
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  };

<<<<<<< HEAD
  return <main className="min-h-screen bg-[#f8f8f6] p-5 sm:p-10"><div className="mx-auto max-w-xl"><Link href="/" className="text-sm font-semibold text-[#28685c]">Back to Home</Link><form onSubmit={submit} className="mt-5 rounded-3xl bg-white p-7"><h1 className="text-3xl font-bold">Account security</h1><p className="mt-3 text-sm text-[#7b8581]">Signed in as {email}</p><label className="mt-6 block text-sm font-semibold">New password<input required minLength={8} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-12 w-full rounded-xl border px-3" /></label><label className="mt-4 block text-sm font-semibold">Confirm new password<input required minLength={8} type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} className="mt-2 h-12 w-full rounded-xl border px-3" /></label><button className="mt-5 rounded-xl bg-[#1f5b50] px-5 py-3 font-bold text-white">Change password</button>{message && <p className="mt-4 text-sm text-[#7b8581]">{message}</p>}</form><section className="mt-5 rounded-3xl bg-white p-7"><h2 className="text-lg font-bold">Sign out</h2><p className="mt-2 text-sm text-[#7b8581]">Sign out of the Christmas app on this device.</p><button onClick={() => void signOut()} className="mt-4 rounded-xl border border-[#e2c8c1] px-5 py-3 font-bold text-[#a5543f]">Sign out</button></section></div></main>;
=======
  return (
    <AppShell width="narrow" parent={{ href: "/more", label: "More" }}>
      <PageHeader
        title="Account & security"
        description={email ? `Signed in as ${email}` : "Loading your account..."}
      />

      <div className="mt-8 max-w-xl space-y-5">
        <form onSubmit={submit} className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-7">
          <h2 className="font-display text-xl font-semibold">Change password</h2>
          <Field label="New password" className="mt-5" required>
            <Input required minLength={8} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Field label="Confirm new password" className="mt-4" required>
            <Input required minLength={8} type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          </Field>
          <Button type="submit" size="lg" className="mt-5 w-full sm:w-auto">Change password</Button>
          {message && (
            <Notice tone={message === "Password updated." ? "success" : "warning"} className="mt-4">{message}</Notice>
          )}
        </form>

        <section className="rounded-2xl border border-line bg-surface px-5 py-4 shadow-card sm:px-7">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-semibold">Sign out</h2>
              <p className="mt-0.5 text-sm leading-6 text-ink-600">Sign out of the Christmas app on this device.</p>
            </div>
            <Button variant="dangerGhost" onClick={() => void signOut()} className="w-full border border-berry-soft-border sm:w-auto">
              Sign out
            </Button>
          </div>
        </section>
      </div>
    </AppShell>
  );
>>>>>>> 7534a2d (redesign and realtime)
}
