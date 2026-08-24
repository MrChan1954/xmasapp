"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath } from "@/lib/events.ts";
import { AppShell, PageHeader } from "../components/app-shell";
import { useFestive } from "../components/festive/festive-context";
import { IconBell, IconCake, IconChevronRight, IconHistory, IconPeople, IconReceipt, IconSettings, IconUser } from "../components/icons";
import { IconGift } from "../components/icons";
import { InstallCard } from "../components/install-card";
import { Notice, Skeleton, cx } from "../components/ui";

type AccessState = "checking" | "admin" | "member" | "error";

/** The More screen for one event: its Payment Log, plus family-level tools. */
export function MoreScreen({
  eventId,
  eventName,
  celebrantPersonId = null,
}: {
  eventId: string;
  eventName: string;
  /** Set only for a birthday: whose birthday this year's planning is for. */
  celebrantPersonId?: string | null;
}) {
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
      <PageHeader eyebrow={eventName} title="More" description="Manage your account and app settings." />

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
        {/* Always listed, even where the browser cannot show notifications: the
            page itself explains why rather than the entry silently vanishing. */}
        <div className="mt-3">
          <SettingsLink
            href="/more/notifications"
            title="Notifications"
            description="Choose what you are told about, and on which devices."
            icon={<IconBell size={20} />}
          />
        </div>
      </Group>

      {/* Birthdays belong to people, not to this event, so the link leaves the
          event behind rather than nesting under it. */}
      <Group label="Family">
        {/* The family DIRECTORY, not this event's recipients. On a phone the
            event's own tabs fill the bar, so this is how somebody reaches
            People without leaving the event first. */}
        <div className="mb-3">
          <SettingsLink
            href="/people"
            title="People"
            description="Everyone the family plans for, and what has been bought for them."
            icon={<IconPeople size={20} />}
          />
        </div>
        <SettingsLink
          href="/birthdays"
          title="Birthdays"
          description="Everyone's birthday, and what is coming up."
          icon={<IconCake size={20} />}
        />
      </Group>

      <Group label="Records">
        {celebrantPersonId && (
          <div className="mb-3">
            <SettingsLink
              href={`/birthdays/${celebrantPersonId}/history`}
              title="Previous birthdays"
              description="What was bought in earlier years, what it cost, and who paid."
              icon={<IconGift size={20} />}
            />
          </div>
        )}
        <SettingsLink
          href={eventPath(eventId, "payment-log") ?? "/"}
          title="Payment log"
          description="Search and review recorded payments."
          icon={<IconReceipt size={20} />}
        />
        {/* Not under Admin: every member can read the log, enforced by RLS. */}
        <div className="mt-3">
          <SettingsLink
            href="/more/activity"
            title="Activity"
            description="Everything added or removed, and who did it."
            icon={<IconHistory size={20} />}
          />
        </div>
      </Group>

      {access === "checking" && (
        <Group label="Admin">
          <Skeleton className="h-16" />
        </Group>
      )}

      {access === "admin" && (
        <Group label="Admin">
          {/* Named for the event whose settings these are: contributors and
              recipients are per-event, and this is the only screen that edits
              them. Family Access below is the family-wide one. */}
          <SettingsLink
            href={eventPath(eventId, "settings") ?? "/"}
            title="Event settings"
            description={`Rename ${eventName}, move its date, or choose who takes part.`}
            icon={<IconSettings size={20} />}
          />
          <div className="mt-3">
            <SettingsLink
              href="/more/family-access"
              title="Family access"
              description="Invite family and manage their app access."
              icon={<IconPeople size={20} />}
            />
          </div>
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
