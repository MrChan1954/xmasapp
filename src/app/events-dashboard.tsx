"use client";

import Link from "next/link";
import { CalendarDays, ChevronRight, Plus } from "lucide-react";
import { formatPennies } from "@/lib/currency";
import { purchaseProgressStatus, type PurchaseProgressStatus } from "@/lib/purchases";
import type { BirthdayPlanning } from "@/utils/supabase/birthdays-server";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { SELF_PRIVATE_DETAIL, SELF_PRIVATE_HEADLINE, birthdayCardState, birthdayWorkspacePath, birthdaysWithinWindow, describeDaysAway, describeTurningAge, formatBirthday, type UpcomingBirthday } from "@/lib/birthdays.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath, eventTypeMeta, formatEventDate, groupDashboardEvents, type EventSummary } from "@/lib/events.ts";
import { AppShell, PageHeader } from "./components/app-shell";
import { GarlandRule } from "./components/festive/garland";
import { FinancialProgressBar } from "./components/financial-progress";
import { Badge, ButtonLink, EmptyState, Notice, cx, type BadgeTone } from "./components/ui";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { SELF_PRIVATE_CTA } from "@/lib/wishlist.ts";

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
  viewerPersonId = null,
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
  /** The reader's own person, so their own card can say it is a surprise. */
  viewerPersonId?: string | null;
  today: string;
  isAdmin: boolean;
  error?: string | null;
}) {
  const { christmas, special } = groupDashboardEvents(events, today);
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
        // Birthdays are NOT a header button. The dashboard already has one
        // route into them -- the Upcoming birthdays section below, and its
        // "All birthdays" link -- and a second, larger control at the top of
        // the same screen was two doors into one room. Removed on desktop and
        // on mobile alike; the dedicated /birthdays page is unchanged.
        actions={isAdmin ? (
          <ButtonLink href="/events/new" size="lg" className="w-full sm:w-auto">
            <Plus size={18} aria-hidden />
            Create event
          </ButtonLink>
        ) : null}
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
        birthdays={birthdays}
        today={today}
        planningByPerson={planningByPerson}
        viewerPersonId={viewerPersonId}
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
 * The glance: birthdays close enough to do something about.
 *
 * ONE ROLLING CALENDAR MONTH, not the year. The front page answers "is anything
 * coming up?", and a birthday in five months answers it with a yes that nobody
 * can act on. `birthdaysWithinWindow` decides the cut, from the family's own
 * date; the whole calendar stays one tap away behind "All birthdays".
 *
 * Filtering here rather than upstream is deliberate. The section is given every
 * birthday the family has, so:
 *
 *   - the "All N birthdays" link can name the REAL total, not the windowed one;
 *   - a family whose birthdays are all months away can be told that, instead of
 *     seeing the same empty state as a family that has recorded none;
 *   - the dashboard's "nothing planned at all" test still sees the truth.
 *
 * No event is involved, and December to January needs no special case: the next
 * occurrence is computed from today, so on the 30th of December a birthday on
 * the 3rd of January is four days away and inside the window.
 */
function UpcomingBirthdaysSection({
  birthdays,
  today,
  planningByPerson,
  viewerPersonId,
  isAdmin,
}: {
  /** EVERY birthday the family has recorded, ordered by how soon it falls. */
  birthdays: UpcomingBirthday[];
  today: string;
  planningByPerson: Record<string, BirthdayPlanning>;
  viewerPersonId: string | null;
  isAdmin: boolean;
}) {
  // Everything in the window, uncapped: a birthday three weeks away is not
  // less urgent for being fifth in the list.
  const shown = birthdaysWithinWindow(birthdays, today);
  // The next one the family has, whether or not it is close enough to show.
  const nextOfAll = birthdays[0];

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
        <h2 className="font-display text-2xl font-semibold text-ink-900">Upcoming birthdays</h2>
        <Link
          href="/birthdays"
          className="min-h-11 text-xs font-semibold tracking-eyebrow text-accent uppercase inline-flex items-center gap-1"
        >
          {birthdays.length > shown.length ? `All ${birthdays.length} birthdays` : "All birthdays"}
          <ChevronRight size={14} aria-hidden />
        </Link>
      </div>
      <GarlandRule className="mt-4" />

      {shown.length === 0
        ? (
          <p className="mt-5 text-sm text-ink-600">
            {nextOfAll
              // Nothing to do this month is worth saying plainly, and saying
              // WHEN stops it reading as a screen that has failed to load.
              ? `Nothing in the next month. Next up is ${nextOfAll.name} on ${formatBirthday(nextOfAll.birthday.month, nextOfAll.birthday.day)}.`
              : "No birthdays saved yet. Add them on the Birthdays page and they appear here."}
          </p>
        )
        : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((person) => (
              <BirthdayCard
                key={person.personId}
                person={person}
                planning={planningByPerson[person.personId]}
                isSelf={person.personId === viewerPersonId}
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
  isSelf,
  isAdmin,
}: {
  person: UpcomingBirthday;
  planning: BirthdayPlanning | undefined;
  /**
   * Is this the reader's own birthday? Then there is nothing to show and
   * nothing to start, and the card says why.
   *
   * `planning` is already undefined here whatever the family has done, because
   * row level security removed the event before this component existed. Without
   * this flag the card would say "Planning not started yet" to the one person
   * who must not be told either way.
   */
  isSelf: boolean;
  isAdmin: boolean;
}) {
  /**
   * ONE STATE, DECIDED ONCE, BEFORE ANY FIGURE IS TOUCHED.
   *
   * `birthdayCardState` puts "this is my own birthday" ahead of every planning
   * question, so there is no arrangement of budgets, gifts or ideas that can
   * change what the reader's own card says -- and therefore nothing about the
   * planning that the SHAPE of the card can leak.
   */
  const state = birthdayCardState({ isSelf, hasPlanning: planning !== undefined });
  const isPrivate = state === "self_private";

  // Every derived figure is gated on the state, not merely unused by the JSX.
  // A badge computed from planning the reader may not see is a leak waiting for
  // somebody to move one line.
  const status: PurchaseProgressStatus | null = state === "planned" && planning
    ? purchaseProgressStatus(planning.spentPennies, planning.budgetPennies)
    : null;
  const hasBudget = state === "planned" && (planning?.budgetPennies ?? 0) > 0;

  // The age is NOT planning. It follows from the date on the person and the
  // occurrence already chosen for this card, so the reader sees their own.
  const turning = describeTurningAge(person.birthday, person.next.year);

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
          {/* The age they turn on THIS occurrence, and only when the year of
              birth is recorded. No year means no age -- never a guess. */}
          {turning && (
            <p className="mt-1 text-xs font-semibold text-accent">{turning}</p>
          )}
        </div>
        {person.next.isToday
          ? <Badge tone="success">Today</Badge>
          : status && <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>}
      </div>

      {isPrivate
        ? (
          <div className="mt-4">
            <p className="text-sm font-medium text-ink-700">🎁 {SELF_PRIVATE_HEADLINE}</p>
            <p className="mt-1 text-xs text-ink-600">{SELF_PRIVATE_DETAIL}</p>
          </div>
        )
        : planning
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

      {/* WHAT YOUR OWN BIRTHDAY CARD OFFERS.
          Still not "Start planning", which would invite somebody to buy their
          own present and would also reveal that nothing had been started; and
          still not "Open", which promises a workspace the reader cannot be
          shown. What it does offer now is the one thing they CAN do here --
          their own wishlist -- and it says exactly that, so the link is not a
          door into something they will be refused.

          The wording is a constant so a test can hold it: "Start planning" or
          "Budget" appearing on this branch would be a privacy failure rather
          than a typo. */}
      <div className="mt-auto flex items-end justify-end pt-4">
        <p className="text-xs font-semibold tracking-eyebrow text-accent uppercase">
          {isPrivate
            ? `${SELF_PRIVATE_CTA} →`
            : planning ? "Open →" : isAdmin ? "Start planning →" : "Open →"}
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
