import Link from "next/link";
import { CalendarDays, Gift, Lightbulb, Plus, Receipt, Scale, Settings, Users } from "lucide-react";
import { formatPennies } from "@/lib/currency";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { describeDaysAway, formatBirthday, nextBirthdayOccurrence, suggestedBirthdayEventName } from "@/lib/birthdays.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath } from "@/lib/events.ts";
import type { BirthdayOccurrence, BirthdayWorkspace } from "@/utils/supabase/birthdays-server";
import { AppShell, PageHeader } from "../../components/app-shell";
import { GarlandRule } from "../../components/festive/garland";
import { FinancialProgressBar } from "../../components/financial-progress";
import { Badge, ButtonLink, EmptyState, Notice } from "../../components/ui";
// NOT from "./ui": this is a Server Component, and `ui.tsx` is "use client".
// A plain function exported from a client module becomes a client reference,
// and calling one during a server render throws — which is exactly what put
// this page into the global error boundary for every person whose birthday
// planning had been started.
import { cx } from "../../components/cx";

/**
 * Taylor's birthday, not "Taylor's Birthday 2026".
 *
 * WHY THE WORD "EVENT" IS NOT ON THIS PAGE
 *   The family thinks in people and years: whose birthday, and what are we
 *   doing about it this time. The event row underneath is what makes the money
 *   work -- recipients, contributors, purchases, allocations, Owed, payments,
 *   all exactly as they are for Christmas -- but it is machinery, and machinery
 *   does not belong in the sentence.
 *
 *   So the links below go INTO the occurrence's own screens, which are the real
 *   ones, and this page is the front of them.
 *
 * WHAT COUNTS AS HISTORY
 *   A previous year appears only if something actually happened in it. An
 *   occurrence created by accident and never used is not "the year nobody
 *   bought Taylor anything"; it is an empty row, and it is left out.
 */
export function BirthdayWorkspaceScreen({ workspace }: { workspace: BirthdayWorkspace }) {
  const { person, current, currentYear, previous, unused, isAdmin, today } = workspace;
  const next = person.birthday ? nextBirthdayOccurrence(person.birthday, today) : null;
  const firstName = person.name.split(" ")[0];

  return (
    <AppShell width="narrow">
      <PageHeader
        eyebrow="Birthdays"
        title={person.name}
        description={person.birthday
          ? `${formatBirthday(person.birthday.month, person.birthday.day)}${next ? ` · ${describeDaysAway(next.daysAway)}` : ""}`
          : "No birthday saved yet."}
        actions={
          <ButtonLink href="/birthdays" variant="secondary" size="lg" className="w-full sm:w-auto">
            All birthdays
          </ButtonLink>
        }
      />

      {next?.isToday && (
        <Notice tone="success" className="mt-6">
          It is {firstName}&apos;s birthday today.
        </Notice>
      )}

      {!person.birthday && (
        <EmptyState
          className="mt-8"
          illustration="star"
          title="No birthday saved"
          body={isAdmin
            ? "Add the date on the Birthdays page and this workspace fills in."
            : "An admin has not recorded this birthday yet."}
        />
      )}

      {person.birthday && (
        <section className="mt-10">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
            <h2 className="font-display text-2xl font-semibold text-ink-900">{currentYear}</h2>
            {current?.status === "archived" && <Badge tone="neutral">Archived</Badge>}
          </div>
          <GarlandRule className="mt-4" />

          {current
            ? <CurrentYear occurrence={current} firstName={firstName} />
            : (
              <div className="mt-6 rounded-2xl border border-dashed border-line-strong bg-surface-2 px-5 py-8 text-center">
                <p className="font-display text-lg font-semibold text-ink-900">
                  Nothing planned for {currentYear} yet
                </p>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-600">
                  {isAdmin
                    ? `Start planning and ${firstName} becomes a recipient, with a budget, gift ideas, purchases and the same Owed and payment tracking as Christmas.`
                    : "An admin has not started this year's planning."}
                </p>
                {isAdmin && next && (
                  <ButtonLink
                    href={startPlanningHref(person.personId, person.name, next.year, next.date)}
                    size="lg"
                    className="mt-5"
                  >
                    <Plus size={18} aria-hidden />
                    Start planning
                  </ButtonLink>
                )}
              </div>
            )}
        </section>
      )}

      {isAdmin && unused.length > 0 && (
        <section className="mt-12">
          <h2 className="font-display text-2xl font-semibold text-ink-900">Unused planning</h2>
          <p className="mt-1.5 text-sm leading-6 text-ink-600">
            Started and never used — nothing was bought, and no ideas were added.
            These are not counted as previous birthdays. Open the settings to tidy
            one up; anything with a purchase or an idea in it can only be archived.
          </p>
          <GarlandRule className="mt-4" />
          <ul className="mt-5 divide-y divide-line rounded-2xl border border-line bg-surface">
            {unused.map((occurrence) => (
              <li
                key={occurrence.eventId}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
              >
                <span className="min-w-0">
                  <span className="block font-semibold text-ink-900">{occurrence.year}</span>
                  <span className="block text-xs text-ink-600">
                    {occurrence.eventDate}{occurrence.status === "archived" ? " · archived" : ""}
                  </span>
                </span>
                <ButtonLink
                  href={eventPath(occurrence.eventId, "settings") ?? "/"}
                  variant="ghost"
                  className="min-h-11"
                >
                  Settings
                </ButtonLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-12">
        <h2 className="font-display text-2xl font-semibold text-ink-900">Previous birthdays</h2>
        <p className="mt-1.5 text-sm leading-6 text-ink-600">
          What was bought, what it cost, and who paid. Years where nothing was
          planned are not listed.
        </p>
        <GarlandRule className="mt-4" />

        {previous.length === 0
          ? <p className="mt-5 text-sm text-ink-600">No previous birthdays recorded yet.</p>
          : (
            <div className="mt-6 space-y-4">
              {previous.map((occurrence) => (
                <PreviousYear key={occurrence.eventId} occurrence={occurrence} firstName={firstName} />
              ))}
            </div>
          )}
      </section>
    </AppShell>
  );
}

/** Pre-fills Create Event from the person's own birthday, so nothing is retyped. */
function startPlanningHref(personId: string, name: string, year: number, date: string): string {
  const query = new URLSearchParams({
    type: "birthday",
    celebrant: personId,
    date,
    name: suggestedBirthdayEventName(name, year),
  });
  return `/events/new?${query.toString()}`;
}

function CurrentYear({ occurrence, firstName }: { occurrence: BirthdayOccurrence; firstName: string }) {
  const hasBudget = occurrence.budgetPennies > 0;

  return (
    <div className="mt-6 rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="text-sm font-semibold text-ink-900">
          {formatPennies(occurrence.spentPennies)}
          <span className="font-medium text-ink-600">
            {hasBudget ? ` of ${formatPennies(occurrence.budgetPennies)} spent` : " spent"}
          </span>
        </p>
        <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-600">
          <CalendarDays size={14} aria-hidden />
          {occurrence.eventDate}
        </p>
      </div>
      {hasBudget && (
        <div className="mt-2">
          <FinancialProgressBar
            actualPennies={occurrence.spentPennies}
            plannedPennies={occurrence.budgetPennies}
            mode="budget"
          />
        </div>
      )}

      {/* Into the real screens. They are the same ones Christmas uses; only the
          words leading to them are different. */}
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <WorkspaceLink
          href={eventPath(occurrence.eventId, "people") ?? "/"}
          icon={<Users size={18} aria-hidden />}
          label="Ideas & budget"
          hint={`What to get ${firstName}, and how much`}
        />
        <WorkspaceLink
          href={eventPath(occurrence.eventId, "add-purchase") ?? "/"}
          icon={<Gift size={18} aria-hidden />}
          label="Add a purchase"
          hint="Record something you have bought"
        />
        <WorkspaceLink
          href={eventPath(occurrence.eventId, "owed") ?? "/"}
          icon={<Scale size={18} aria-hidden />}
          label="Owed"
          hint="Who owes who, for this birthday"
        />
        <WorkspaceLink
          href={eventPath(occurrence.eventId, "payment-log") ?? "/"}
          icon={<Receipt size={18} aria-hidden />}
          label="Payments"
          hint="Money already settled"
        />
        <WorkspaceLink
          href={eventPath(occurrence.eventId, "settings") ?? "/"}
          icon={<Settings size={18} aria-hidden />}
          label="Settings"
          hint="Who takes part, the date, archiving"
        />
      </div>

      {occurrence.gifts.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          <h3 className="text-xs font-semibold tracking-eyebrow text-gold uppercase">Bought so far</h3>
          <GiftList gifts={occurrence.gifts} />
        </div>
      )}
    </div>
  );
}

function PreviousYear({ occurrence, firstName }: { occurrence: BirthdayOccurrence; firstName: string }) {
  return (
    <article className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h3 className="font-display text-lg font-semibold text-ink-900">{occurrence.year}</h3>
        <p className="text-sm font-semibold tabular-nums text-ink-900">
          {formatPennies(occurrence.spentPennies)}
          <span className="font-medium text-ink-600"> spent</span>
        </p>
      </div>

      {occurrence.gifts.length > 0
        ? <GiftList gifts={occurrence.gifts} />
        : (
          <p className="mt-3 text-sm text-ink-600">
            Nothing was bought, but there were ideas.
          </p>
        )}

      {occurrence.openIdeas.length > 0 && (
        <div className="mt-4 border-t border-line pt-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-eyebrow text-gold uppercase">
            <Lightbulb size={14} aria-hidden />
            Ideas nobody bought
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {occurrence.openIdeas.map((idea) => (
              <li
                key={idea.id}
                className="rounded-xl border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-600"
              >
                {idea.title}
                {idea.estimatedPricePennies !== null && (
                  <span className="text-ink-400"> · {formatPennies(idea.estimatedPricePennies)}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-600">Still worth a look for {firstName} this year.</p>
        </div>
      )}
    </article>
  );
}

function GiftList({ gifts }: { gifts: BirthdayOccurrence["gifts"] }) {
  return (
    <ul className="mt-3 divide-y divide-line">
      {gifts.map((gift) => (
        <li key={gift.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
          <span className="min-w-0 break-words text-sm font-medium text-ink-900">{gift.description}</span>
          <span className="flex items-baseline gap-2 text-sm">
            {gift.buyerName && <span className="text-xs font-medium text-ink-600">{gift.buyerName}</span>}
            <span className="font-semibold tabular-nums text-ink-900">{formatPennies(gift.pricePennies)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function WorkspaceLink({
  href,
  icon,
  label,
  hint,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className={cx(
        "flex min-h-11 items-center gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-3 transition",
        "hover:border-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink-900">{label}</span>
        <span className="block text-xs leading-4 text-ink-600">{hint}</span>
      </span>
    </Link>
  );
}
