"use client";

import Link from "next/link";
import { CalendarDays, Plus } from "lucide-react";
import { formatPennies } from "@/lib/currency";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath, eventTypeMeta, formatEventDate, partitionEvents, type EventSummary } from "@/lib/events.ts";
import { AppShell, PageHeader } from "./components/app-shell";
import { GarlandRule } from "./components/festive/garland";
import { FinancialProgressBar } from "./components/financial-progress";
import { Badge, ButtonLink, EmptyState, Notice, cx } from "./components/ui";

export type DashboardEvent = EventSummary & {
  spentPennies: number;
  budgetPennies: number;
};

/**
 * The Events dashboard: the front door of the app.
 *
 * Opening the app no longer means opening Christmas. Every occasion the family
 * plans is a card here, and choosing one is what puts an event id in the URL --
 * which is what every screen inside then scopes itself to.
 *
 * The two figures on a card are read, not recomputed: `listEvents` sums the
 * same live-purchase rows and the same active-recipient budgets Event Home
 * uses, so a card and the screen it opens can never disagree.
 */
export function EventsDashboard({
  events,
  today,
  isAdmin,
  error,
}: {
  events: DashboardEvent[];
  today: string;
  isAdmin: boolean;
  error?: string | null;
}) {
  const { upcoming, past, archived } = partitionEvents(events, today);

  return (
    <AppShell width="default">
      <PageHeader
        eyebrow="Family gift planner"
        title="Events"
        description="Every occasion the family plans and pays for together. Open one to see its people, purchases and balances."
        actions={isAdmin ? (
          <ButtonLink href="/events/new" size="lg" className="w-full sm:w-auto">
            <Plus size={18} aria-hidden />
            Create event
          </ButtonLink>
        ) : undefined}
      />

      {error && <Notice tone="danger" className="mt-6">{error}</Notice>}

      {events.length === 0 && !error && (
        <EmptyState
          className="mt-8"
          illustration="tree"
          title="No events yet"
          body={isAdmin
            ? "Create your first event to start planning."
            : "An admin has not set up any events yet."}
        />
      )}

      <EventSection title="Upcoming" events={upcoming} emptyNote="Nothing coming up." />
      <EventSection title="Past" events={past} />
      <EventSection title="Archived" events={archived} muted />
    </AppShell>
  );
}

function EventSection({
  title,
  events,
  emptyNote,
  muted = false,
}: {
  title: string;
  events: DashboardEvent[];
  emptyNote?: string;
  muted?: boolean;
}) {
  if (!events.length && !emptyNote) return null;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
        <h2 className="font-display text-2xl font-semibold text-ink-900">{title}</h2>
        <p className="text-xs font-semibold tracking-eyebrow text-ink-600 uppercase">
          {events.length} {events.length === 1 ? "event" : "events"}
        </p>
      </div>
      <GarlandRule className="mt-4" />

      {events.length === 0
        ? <p className="mt-5 text-sm text-ink-600">{emptyNote}</p>
        : (
          // One card per row on a phone, a responsive grid above that. Nothing
          // here can overflow horizontally: names wrap and figures shrink.
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {events.map((event) => <EventCard key={event.id} event={event} muted={muted} />)}
          </div>
        )}
    </section>
  );
}

function EventCard({ event, muted }: { event: DashboardEvent; muted: boolean }) {
  const meta = eventTypeMeta(String(event.type));
  const href = eventPath(event.id) ?? "/";
  const hasBudget = event.budgetPennies > 0;

  return (
    <Link
      href={href}
      className={cx(
        // 44px minimum touch target is met many times over: the whole card is
        // the control, which is also what makes it comfortable on a phone.
        "group flex min-h-[11rem] flex-col rounded-2xl border border-line bg-surface p-5 shadow-sm transition",
        "hover:border-accent/40 hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        muted && "opacity-70",
      )}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-2xl leading-none">{meta.icon}</span>
        <div className="min-w-0 flex-1">
          {/* A long event name wraps instead of pushing the card sideways. */}
          <h3 className="font-display text-lg leading-snug font-semibold text-balance break-words text-ink-900">
            {event.name}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-ink-600">
            <CalendarDays size={14} aria-hidden className="shrink-0" />
            {formatEventDate(event.eventDate)}
            <span aria-hidden>·</span>
            <span>{meta.label}</span>
          </p>
        </div>
        {event.status === "archived" && <Badge tone="neutral">Archived</Badge>}
      </div>

      <div className="mt-auto pt-5">
        {hasBudget
          ? (
            <>
              <p className="text-sm font-semibold text-ink-900">
                {formatPennies(event.spentPennies)}
                <span className="font-medium text-ink-600"> of {formatPennies(event.budgetPennies)} spent</span>
              </p>
              <div className="mt-2">
                <FinancialProgressBar
                  actualPennies={event.spentPennies}
                  plannedPennies={event.budgetPennies}
                  mode="budget"
                />
              </div>
            </>
          )
          : (
            <p className="text-sm font-medium text-ink-600">
              {event.spentPennies > 0
                ? `${formatPennies(event.spentPennies)} spent`
                : "No budget set yet"}
            </p>
          )}
        <p className="mt-4 text-xs font-semibold tracking-eyebrow text-accent uppercase">
          Open event →
        </p>
      </div>
    </Link>
  );
}
