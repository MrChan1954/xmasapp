"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell, PageHeader } from "../components/app-shell";
import { useFestive } from "../components/festive/festive-context";
import { IconChevronRight, IconPeople, IconReceipt, IconUser } from "../components/icons";
import { InstallCard } from "../components/install-card";
import { Notice, Skeleton, cx } from "../components/ui";

type AccessState = "checking" | "admin" | "member" | "error";

export default function MorePage() {
  const [access, setAccess] = useState<AccessState>("checking");
  const { snow, setSnow, reducedMotion } = useFestive();

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
    <AppShell width="narrow">
      <PageHeader title="More" description="Manage your account and app settings." />

      {access === "error" && (
        <Notice tone="warning" className="mt-6">
          We could not check admin access right now. Your account settings are still available.
        </Notice>
      )}

      {/* Renders nothing — heading included — when the app is already installed
          or the browser offers no install path, so it never becomes permanent
          noise. It owns its own section for exactly that reason. */}
      <InstallCard />

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
  );
}
