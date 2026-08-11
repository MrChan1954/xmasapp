"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
<<<<<<< HEAD
import { AppNav } from "../components/app-nav";
=======
import { AppShell, PageHeader } from "../components/app-shell";
import { useFestive } from "../components/festive/festive-context";
import { IconChevronRight, IconPeople, IconReceipt, IconUser } from "../components/icons";
import { Notice, Skeleton, cx } from "../components/ui";
>>>>>>> 7534a2d (redesign and realtime)

type AccessState = "checking" | "admin" | "member" | "error";

export default function MorePage() {
  const [access, setAccess] = useState<AccessState>("checking");
<<<<<<< HEAD
=======
  const { snow, setSnow, reducedMotion } = useFestive();
>>>>>>> 7534a2d (redesign and realtime)

  useEffect(() => {
    let active = true;

    const checkAccess = async () => {
      try {
        const response = await fetch("/api/admin/family-access", {
          method: "GET",
          cache: "no-store",
        });
        if (!active) return;
        if (response.ok) setAccess("admin");
        else if (response.status === 401 || response.status === 403) setAccess("member");
        else setAccess("error");
      } catch {
        if (active) setAccess("error");
      }
    };

    void checkAccess();
    return () => {
      active = false;
    };
  }, []);

  return (
<<<<<<< HEAD
    <main className="flex min-h-screen bg-[#f7f6f1] text-[#1d2926]">
      <AppNav />
      <div className="min-w-0 flex-1 pb-24 lg:pb-0">
      <div className="mx-auto max-w-[1100px] px-5 py-8 sm:px-8 sm:py-10 lg:px-12 lg:py-12">
        <header>
          <p className="text-sm font-semibold text-[#a64235]">Christmas 2026</p>
          <h1 className="mt-1 text-4xl font-bold tracking-tight">More</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[#75807c]">
            Manage your account and app settings.
          </p>
        </header>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <Link
            href="/account"
            className="group flex min-h-32 items-center gap-4 rounded-2xl border border-[#e4e9e6] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#cddbd6] hover:shadow-md"
          >
            <FeatureIcon kind="account" />
            <span className="min-w-0 flex-1">
              <span className="block text-lg font-bold">Account &amp; security</span>
              <span className="mt-1 block text-sm leading-5 text-[#75807c]">
                Change your password or sign out.
              </span>
            </span>
            <Chevron />
          </Link>

          <Link
            href="/payment-log"
            className="group flex min-h-32 items-center gap-4 rounded-2xl border border-[#e4e1d6] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#d2c390] hover:shadow-md"
          >
            <FeatureIcon kind="payments" />
            <span className="min-w-0 flex-1">
              <span className="block text-lg font-bold">Payment Log</span>
              <span className="mt-1 block text-sm leading-5 text-[#75807c]">
                Search and review recorded payments.
              </span>
            </span>
            <Chevron />
          </Link>

          {access === "checking" && (
            <div className="min-h-32 animate-pulse rounded-2xl border border-[#e4e9e6] bg-white p-5">
              <div className="h-12 w-12 rounded-xl bg-[#edf1ef]" />
              <div className="mt-4 h-4 w-36 rounded bg-[#edf1ef]" />
            </div>
          )}

          {access === "admin" && (
            <Link
              href="/more/family-access"
              className="group flex min-h-32 items-center gap-4 rounded-2xl border border-[#d8e6e1] bg-[#f5faf8] p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#b9d5cb] hover:shadow-md"
            >
              <FeatureIcon kind="family" />
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-bold">Family Access</span>
                <span className="mt-1 block text-sm leading-5 text-[#62736d]">
                  Invite family and manage their app access.
                </span>
              </span>
              <Chevron />
            </Link>
          )}
        </div>

        {access === "error" && (
          <p role="status" className="mt-5 rounded-xl border border-[#ead7cf] bg-[#fff8f4] p-4 text-sm text-[#914d3c]">
            We could not check admin access right now. Your account settings are still available.
          </p>
        )}
      </div>
      </div>
    </main>
  );
}

function FeatureIcon({ kind }: { kind: "account" | "family" | "payments" }) {
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#e4f1ed] text-[#28685c]">
      {kind === "account" ? (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="8" r="4" />
          <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
        </svg>
      ) : kind === "family" ? (
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2" />
          <path d="M16 5.5a3 3 0 0 1 0 5.8M17 13a5 5 0 0 1 4 4.9V20" />
        </svg>
      ) : (
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 6.5h16v11H4z" />
          <path d="M8 10h8M8 14h5" />
          <path d="M7 4v2.5M17 4v2.5" />
        </svg>
      )}
    </span>
  );
}

function Chevron() {
  return (
    <svg className="shrink-0 text-[#9aa39f] transition group-hover:translate-x-0.5" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
=======
    <AppShell width="narrow">
      <PageHeader title="More" description="Manage your account and app settings." />

      {access === "error" && (
        <Notice tone="warning" className="mt-6">
          We could not check admin access right now. Your account settings are still available.
        </Notice>
      )}

      <Group label="Appearance">
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
              <h3 className="font-display text-lg font-semibold">Falling snow</h3>
              <p className="mt-1 text-sm leading-6 text-ink-600">
                {reducedMotion
                  ? "Off while your device asks for reduced motion."
                  : "Decorative snow on the dashboard."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={snow && !reducedMotion}
              disabled={reducedMotion}
              onClick={() => setSnow(!snow)}
              className={cx(
                "relative h-7 w-12 shrink-0 rounded-full border transition disabled:opacity-50",
                snow && !reducedMotion ? "border-accent bg-accent" : "border-line-strong bg-surface-3",
              )}
            >
              <span className="sr-only">Falling snow</span>
              <span
                aria-hidden
                className={cx(
                  "absolute top-1/2 block h-5 w-5 -translate-y-1/2 rounded-full bg-surface shadow-card transition-[left]",
                  snow && !reducedMotion ? "left-[calc(100%-1.375rem)]" : "left-0.5",
                )}
              />
            </button>
          </div>
        </div>
      </Group>

      <Group label="Your account">
        <SettingsLink
          href="/account"
          title="Account & security"
          description="Change your password or sign out."
          icon={<IconUser size={20} />}
        />
      </Group>

      <Group label="Records">
        <SettingsLink
          href="/payment-log"
          title="Payment log"
          description="Search and review recorded payments."
          icon={<IconReceipt size={20} />}
        />
      </Group>

      {access === "checking" && (
        <Group label="Admin">
          <Skeleton className="h-16" />
        </Group>
      )}

      {access === "admin" && (
        <Group label="Admin">
          <SettingsLink
            href="/more/family-access"
            title="Family access"
            description="Invite family and manage their app access."
            icon={<IconPeople size={20} />}
          />
        </Group>
      )}
    </AppShell>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold tracking-eyebrow text-gold uppercase">{label}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Hairline list row rather than a tile: quieter, and scales as settings grow. */
function SettingsLink({
  href,
  title,
  description,
  icon,
}: {
  href: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-2xl border border-line bg-surface px-5 py-4 shadow-card transition hover:border-line-strong"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-display text-lg font-semibold">{title}</span>
        <span className="mt-0.5 block text-sm leading-5 text-ink-600">{description}</span>
      </span>
      <IconChevronRight size={20} className="shrink-0 text-ink-400 transition group-hover:translate-x-0.5 group-hover:text-accent" />
    </Link>
>>>>>>> 7534a2d (redesign and realtime)
  );
}
