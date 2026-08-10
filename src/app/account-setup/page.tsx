"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { INPUT_LIMITS, validateRequiredText } from "@/lib/input-validation";
import { createClient } from "../../../utils/supabase/client";

type Stage = "checking" | "ready" | "saving" | "error";

export default function AccountSetupPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("checking");
  const [personName, setPersonName] = useState("family member");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;

    const prepareSession = async () => {
      const rawHash = window.location.hash;
      const rawQuery = window.location.search;

      // Remove sensitive auth material from the address bar before making any
      // further requests. Tokens are never logged or stored in component state.
      if (rawHash || rawQuery) {
        window.history.replaceState(window.history.state, "", window.location.pathname);
      }
      if (rawHash.length > 20_000 || rawQuery.length > 2_048) {
        if (active) {
          setMessage("This setup link is invalid or has expired. Ask the Global Admin for a new link.");
          setStage("error");
        }
        return;
      }

      const hash = new URLSearchParams(rawHash.slice(1));
      const query = new URLSearchParams(rawQuery);
      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      const authError = hash.has("error_description") || hash.has("error") || query.has("error");

      if (authError) {
        if (active) {
          setMessage("This setup link is invalid or has expired. Ask the Global Admin for a new link.");
          setStage("error");
        }
        return;
      }

      const supabase = createClient();
      if ((accessToken || refreshToken) && (!isReasonableAuthToken(accessToken) || !isReasonableAuthToken(refreshToken))) {
        if (active) {
          setMessage("This setup link is invalid or has expired. Ask the Global Admin for a new link.");
          setStage("error");
        }
        return;
      }
      if (accessToken && refreshToken) {
        const session = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (session.error) {
          if (active) {
            setMessage("This setup link is invalid or has expired. Ask the Global Admin for a new link.");
            setStage("error");
          }
          return;
        }
      }

      const userResult = await supabase.auth.getUser();
      if (userResult.error || !userResult.data.user) {
        if (active) {
          setMessage("This setup link is invalid or has expired. Ask the Global Admin for a new link.");
          setStage("error");
        }
        return;
      }

      const membership = await supabase
        .from("app_members")
        .select("person_id, active")
        .eq("user_id", userResult.data.user.id)
        .maybeSingle();

      if (membership.error || !membership.data?.active || !membership.data.person_id) {
        await supabase.auth.signOut();
        if (active) {
          setMessage("This account is not approved for the Christmas app. Ask the Global Admin for help.");
          setStage("error");
        }
        return;
      }

      const person = await supabase
        .from("people")
        .select("name")
        .eq("id", membership.data.person_id)
        .maybeSingle();

      if (active) {
        const candidateName = person.data?.name ?? userResult.data.user.user_metadata?.name;
        const safeName = validateRequiredText(candidateName, { field: "a name", maxLength: INPUT_LIMITS.name });
        setPersonName(safeName.ok ? safeName.value : "family member");
        setStage("ready");
      }
    };

    void prepareSession();
    return () => {
      active = false;
    };
  }, []);

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
    <main className="flex min-h-screen items-center justify-center bg-[#f8f8f6] px-5 py-10 text-[#1d2926]">
      <section className="w-full max-w-md rounded-3xl border border-[#e4e9e6] bg-white p-7 shadow-sm sm:p-9">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#e4f1ed] text-xl text-[#28685c]" aria-hidden>
          *
        </div>

        {stage === "checking" ? (
          <div role="status" className="py-8">
            <h1 className="text-3xl font-bold">Opening your secure link</h1>
            <p className="mt-3 text-sm text-[#75807c]">Please wait while we verify your account.</p>
          </div>
        ) : stage === "error" ? (
          <div className="py-5">
            <h1 className="text-3xl font-bold">This link could not be opened</h1>
            <p role="alert" className="mt-4 rounded-xl bg-[#fff2ed] p-4 text-sm leading-6 text-[#934d3b]">{message}</p>
            <Link href="/login" className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[#1f5b50] px-5 font-bold text-white">
              Back to login
            </Link>
          </div>
        ) : (
          <form onSubmit={(event) => void savePassword(event)} className="pt-5">
            <p className="text-sm font-semibold text-[#28685c]">Welcome, {personName}</p>
            <h1 className="mt-2 text-3xl font-bold">Create your password</h1>
            <p className="mt-3 text-sm leading-6 text-[#75807c]">Choose the password you will use with your email on future visits.</p>

            <label className="mt-6 block text-sm font-semibold">
              New password
              <input
                required
                minLength={8}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-2 h-12 w-full rounded-xl border border-[#dbe2de] px-3 outline-none focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]"
              />
            </label>
            <label className="mt-4 block text-sm font-semibold">
              Confirm password
              <input
                required
                minLength={8}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="mt-2 h-12 w-full rounded-xl border border-[#dbe2de] px-3 outline-none focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]"
              />
            </label>
            <button
              disabled={stage === "saving"}
              className="mt-6 min-h-12 w-full rounded-xl bg-[#1f5b50] px-5 font-bold text-white disabled:opacity-50"
            >
              {stage === "saving" ? "Saving..." : "Create password"}
            </button>
            {message && <p role="alert" className="mt-4 text-sm text-[#a5543f]">{message}</p>}
          </form>
        )}
      </section>
    </main>
  );
}

function isReasonableAuthToken(value: string | null): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8_192 && !/[\u0000-\u0020\u007f-\u009f]/u.test(value);
}
