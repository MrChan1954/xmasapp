"use client";

import Link from "next/link";
import { Cake, CalendarDays, ChevronRight, Plus } from "lucide-react";
import { formatPennies } from "@/lib/currency";
import { purchaseProgressStatus, type PurchaseProgressStatus } from "@/lib/purchases";
import type { BirthdayPlanning } from "@/utils/supabase/birthdays-server";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { DASHBOARD_BIRTHDAY_LIMIT, birthdayWorkspacePath, describeDaysAway, formatBirthday, type UpcomingBirthday } from "@/lib/birthdays.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath, eventTypeMeta, formatEventDate, groupDashboardEvents, type EventSummary } from "@/lib/events.ts";
import { AppShell, PageHeader } from "./components/app-shell";
import { GarlandRule } from "./components/festive/garland";
import { FinancialProgressBar } from "./components/financial-progress";
import { Badge, ButtonLink, EmptyState, Notice, cx, type BadgeTone } from "./components/ui";

export type DashboardEvent = EventSummary & {
  spentPennies: number;
  budgetPennies: number;
};

/**
 * The front door of the app.
 *
 * WHAT IS ON IT, AND WHY
 *   Christmas             the thing this app was built for, and what everybody
 *                         opens it looking for.
 *   Upcoming birthdays    the next few, from the PERMANENT dates on people --
 *                         not from events. A birthday appears here whether or
 *                         not anybody has started planning it, which is the
 *                         whole point: it is the family's early warning, and it
 *                         is why there is no longer a one-month push reminder.
 *   Special events        everything else the family plans together.
 *
 * WHAT IS DELIBERATELY NOT ON IT
 *   The event row that holds one year's birthday planning. A family with twenty
 *   birthdays would otherwise get twenty near-identical cards here, drowning
 *   the two sections that matter. Those rows are reached through the person's
 *   birthday workspace, where they read as "Taylor's planning" rather than as
 *   "an event".
 *
 * The two figures on an event card are read, not recomputed: `listEvents` sums
 * the same live-purchase rows and the same active-recipient budgets Event Home
 * uses, so a card and the screen it opens can never disagree.
 */
export function EventsDashboard({
  events,
  birthdays = [],
  planningByPerson = {},
  today,
  isAdmin,
  error,
}: {
  events: DashboardEvent[];
  /** Everyone with a birthday, already ordered by how soon it next falls. */
  birthdays?: UpcomingBirthday[];
  /**
   * The planning for each person's NEXT birthday, where it exists. Absent is a
   * normal state — most birthdays have not been planned yet — and is shown as
   * "planning not started", never as a £0 budget somebody chose.
   */
  planningByPerson?: Record<string, BirthdayPlanning>;
  today: string;
  isAdmin: boolean;
  error?: string | null;
}) {
  const { christmas, special } = groupDashboardEvents(events, today);
  const nextBirthdays = birthdays.slice(0, DASHBOARD_BIRTHDAY_LIMIT);
  const nothingToShow = christmas.length === 0
    && special.upcoming.length === 0
    && special.past.length === 0
    && special.archived.length === 0
    && birthdays.length === 0;

  return (
    <AppShell width="default">
      <PageHeader
        eyebrow="Family gift planner"
        title="Events"
        description="Every occasion the family plans and pays for together. Open one to see its people, purchases and balances."
        actions={(
          <>
            {/* Birthdays sit beside the events rather than inside one, because
                a birthday belongs to a person all year round whether or not
                anybody has planned an event for it. Everybody can look. */}
            <ButtonLink href="/birthdays" variant="secondary" size="lg" className="w-full sm:w-auto">
              <Cake size={18} aria-hidden />
              Birthdays
            </ButtonLink>
            {isAdmin ? (
          <ButtonLink href="/events/new" size="lg" className="w-full sm:w-auto">
            <Plus size={18} aria-hidden />
            Create event
          </ButtonLink>
            ) : null}
          </>
        )}
      />

      {error && <Notice tone="danger" className="mt-6">{error}</Notice>}

      {nothingToShow && !error && (
        <EmptyState
          className="mt-8"
          illustration="tree"
          title="Nothing planned yet"
          body={isAdmin
            ? "Create your first event, or add the family's birthdays, to start planning."
            : "An admin has not set anything up yet."}
        />
      )}

      <EventSection title="Christmas" events={christmas} />
      <UpcomingBirthdaysSection
        birthdays={nextBirthdays}
        total={birthdays.length}
        planningByPerson={planningByPerson}
        isAdmin={isAdmin}
      />
      <EventSection
        title="Special events"
        events={special.upcoming}
        emptyNote={christmas.length > 0 ? "Nothing else coming up." : undefined}
      />
      <EventSection title="Past" events={special.past} />
      <EventSection title="Archived" events={special.archived} muted />
    </AppShell>
  );
}

/**
 * The glance: the nearest few birthdays, straight from the permanent dates.
 *
 * No event is involved. December to January is handled by the ordering the
 * model already does — the next occurrence is computed from today, so on the
 * 30th of December a birthday on the 3rd of January is two entries above one in
 * the following November.
 */
function UpcomingBirthdaysSection({
  birthdays,
  total,
  planningByPerson,
  isAdmin,
}: {
  birthdays: UpcomingBirthday[];
  total: number;
  planningByPerson: Record<string, BirthdayPlanning>;
  isAdmin: boolean;
}) {
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
        <h2 className="font-display text-2xl font-semibold text-ink-900">Upcoming birthdays</h2>
        <Link
          href="/birthdays"
          className="min-h-11 text-xs font-semibold tracking-eyebrow text-accent uppercase inline-flex items-center gap-1"
        >
          {total > birthdays.length ? `All ${total} birthdays` : "All birthdays"}
          <ChevronRight size={14} aria-hidden />
        </Link>
      </div>
      <GarlandRule className="mt-4" />

      {birthdays.length === 0
        ? (
          <p className="mt-5 text-sm text-ink-600">
            No birthdays saved yet. Add them on the Birthdays page and they appear here.
          </p>
        )
        : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {birthdays.map((person) => (
              <BirthdayCard
                key={person.personId}
                person={person}
                planning={planningByPerson[person.personId]}
                isAdmin={isAdmin}
              />
            ))}
          </div>
        )}
    </section>
  );
}

/**
 * One person's next birthday, with the money if there is any.
 *
 * The figures are the SAME ones Event Home shows, read from the same rows by
 * `loadFamilyBirthdays`. Status and progress come from
 * `purchaseProgressStatus` and `FinancialProgressBar` — the helpers every other
 * financial card already uses — so there is no second progress engine here.
 *
 * Where no planning exists the card says so plainly. "£0 spent of £0" would
 * read as a budget somebody had chosen, which is worse than saying nothing.
 */
function BirthdayCard({
  person,
  planning,
  isAdmin,
}: {
  person: UpcomingBirthday;
  planning: BirthdayPlanning | undefined;
  isAdmin: boolean;
}) {
  const status: PurchaseProgressStatus | null = planning
    ? purchaseProgressStatus(planning.spentPennies, planning.budgetPennies)
    : null;
  const hasBudget = (planning?.budgetPennies ?? 0) > 0;

  return (
    <Link
      href={birthdayWorkspacePath(person.personId)}
      className={cx(
        "group flex min-h-[8.5rem] flex-col rounded-2xl border border-line bg-surface p-5 shadow-sm transition",
        "hover:border-accent/40 hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        person.next.isToday && "border-accent/50 bg-accent-soft",
      )}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-2xl leading-none">🎂</span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg leading-snug font-semibold break-words text-ink-900">
            {person.name}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs font-semibold text-ink-600">
            {formatBirthday(person.birthday.month, person.birthday.day)}
            <span aria-hidden>·</span>
            <span className={person.next.daysAway <= 7 ? "text-accent" : undefined}>
              {describeDaysAway(person.next.daysAway)}
            </span>
          </p>
        </div>
        {person.next.isToday
          ? <Badge tone="success">Today</Badge>
          : status && <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>}
      </div>

      {planning
        ? (
          <div className="mt-4">
            <p className="text-sm font-semibold text-ink-900">
              {formatPennies(planning.spentPennies)}
              <span className="font-medium text-ink-600">
                {hasBudget ? ` of ${formatPennies(planning.budgetPennies)} budget` : " spent"}
              </span>
            </p>
            {hasBudget && (
              <div className="mt-2">
                <FinancialProgressBar
                  actualPennies={planning.spentPennies}
                  plannedPennies={planning.budgetPennies}
                  mode="budget"
                />
              </div>
            )}
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-ink-600">
              <span>🎁 {planning.giftCount} {planning.giftCount === 1 ? "gift" : "gifts"}</span>
              <span>✨ {planning.ideaCount} {planning.ideaCount === 1 ? "idea" : "ideas"}</span>
            </p>
          </div>
        )
        : (
          <div className="mt-4">
            <p className="text-sm font-medium text-ink-600">Planning not started yet</p>
          </div>
        )}

      <div className="mt-auto flex items-end justify-end pt-4">
        <p className="text-xs font-semibold tracking-eyebrow text-accent uppercase">
          {planning ? "Open →" : isAdmin ? "Start planning →" : "Open →"}
        </p>
      </div>
    </Link>
  );
}

/** The app's existing status vocabulary, not a second one. */
function statusLabel(status: PurchaseProgressStatus): string {
  if (status === "not_started") return "Not started";
  if (status === "in_progress") return "In progress";
  if (status === "budget_reached") return "Complete";
  return "Over budget";
}

function statusTone(status: PurchaseProgressStatus): BadgeTone {
  if (status === "not_started") return "neutral";
  if (status === "in_progress") return "gold";
  if (status === "budget_reached") return "success";
  return "warning";
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
