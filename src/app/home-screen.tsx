"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { formatPennies } from "../lib/currency";
import { contributorOwedSummary } from "../lib/owed";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath, eventTypeMeta, formatEventDate } from "@/lib/events.ts";
import { AppShell } from "./components/app-shell";
import { GarlandRule } from "./components/festive/garland";
import { FinancialProgressBar } from "./components/financial-progress";
import { IconArrowRight, IconTree } from "./components/icons";
import { Badge, Notice, Skeleton, Stat, cx } from "./components/ui";
import { useRealtimeRefresh } from "./components/use-realtime-refresh";
import { useFamily, useTotals } from "./family-context";
import { loadOwedData } from "./owed/owed-data";
import { OwedSummary } from "./owed/owed-summary";

type OwedTotals = { owedToYouPennies: number; youOwePennies: number };

type ContributorTotal = {
  id: string;
  name: string;
  plannedPennies: number;
  actualResponsibilityPennies: number | null;
  isCurrent: boolean;
  owed: OwedTotals | null;
};

/**
 * Event Home — the screen that used to be "Christmas 2026".
 *
 * `eventId` comes from the route and has already been validated on the server,
 * so every query below is scoped to one event and nothing here has to guess
 * which. The financial arithmetic is untouched: the same totals, from the same
 * tables, filtered to this event's recipients.
 */
export function EventHome({ eventId, eventName, eventType, eventDate }: {
  eventId: string;
  eventName: string;
  eventType: string;
  eventDate: string;
}) {
  const { loading, error } = useFamily();
  const { budgetPennies, spentPennies, remainingPennies, active } = useTotals();
  const [contributors, setContributors] = useState<ContributorTotal[]>([]);
  const [financialError, setFinancialError] = useState<string | null>(null);
  const [owedSnapshot, setOwedSnapshot] = useState<{
    summary: OwedTotals | null;
    unavailable: boolean;
    loading: boolean;
  }>({ summary: null, unavailable: false, loading: true });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // `quiet` leaves the current figures on screen while a background refresh runs,
  // so a change made on another device swaps the numbers in place instead of
  // flashing the Owed panel back to its loading state.
  const load = useCallback(async (quiet = false) => {
    const mounted = () => mountedRef.current;
    {
      const db = createClient();
      if (!quiet) setOwedSnapshot({ summary: null, unavailable: false, loading: true });
      const [contributorRows, owedResult] = await Promise.all([
        db.from("contributors").select("id,person_id").eq("christmas_event_id", eventId).eq("active", true),
        loadOwedData(eventId)
          .then((data) => ({ data, failed: false }))
          .catch(() => ({ data: null, failed: true })),
      ]);
      if (!mounted()) return;
      if (contributorRows.error) {
        setFinancialError("Contributor totals could not be loaded.");
        setOwedSnapshot({ summary: null, unavailable: owedResult.failed, loading: false });
        return;
      }

      const contributorIds = contributorRows.data.map((row) => row.id);
      const personIds = contributorRows.data.map((row) => row.person_id);
      const recipientIds = active.map((person) => person.id);
      const [peopleRows, plannedRows, purchaseRows] = await Promise.all([
        personIds.length
          ? db.from("people").select("id,name").in("id", personIds)
          : Promise.resolve({ data: [], error: null }),
        contributorIds.length && recipientIds.length
          ? db.from("recipient_contributions").select("contributor_id,planned_amount_pennies").in("contributor_id", contributorIds).in("christmas_recipient_id", recipientIds)
          : Promise.resolve({ data: [], error: null }),
        recipientIds.length
          ? db.from("purchases").select("id").in("christmas_recipient_id", recipientIds).is("deleted_at", null)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (!mounted()) return;
      if (peopleRows.error || plannedRows.error) {
        setFinancialError("Contributor plans could not be loaded.");
        setOwedSnapshot({ summary: null, unavailable: owedResult.failed, loading: false });
        return;
      }

      const purchaseIds = (purchaseRows.data ?? []).map((row) => row.id);
      const responsibilityRows = !purchaseRows.error && purchaseIds.length
        ? await db.from("purchase_allocations").select("purchase_id,contributor_id,responsibility_pennies").in("purchase_id", purchaseIds).in("contributor_id", contributorIds)
        : { data: [], error: purchaseRows.error };
      if (!mounted()) return;

      const names = new Map(peopleRows.data.map((row) => [row.id, row.name]));
      const planned = new Map<string, number>();
      for (const row of plannedRows.data) {
        planned.set(row.contributor_id, (planned.get(row.contributor_id) ?? 0) + row.planned_amount_pennies);
      }
      const actual = new Map<string, number>();
      if (!responsibilityRows.error) {
        for (const row of responsibilityRows.data ?? []) {
          actual.set(row.contributor_id, (actual.get(row.contributor_id) ?? 0) + row.responsibility_pennies);
        }
      }
      const owedData = owedResult.data;
      const currentOwed = owedData
        ? contributorOwedSummary(owedData.balances, owedData.currentContributorId)
        : null;
      setContributors(contributorRows.data.flatMap((row) => {
        const name = names.get(row.person_id);
        if (!name) return [];
        const canShowOwed = Boolean(owedData && (owedData.isAdmin || row.id === owedData.currentContributorId));
        return [{
          id: row.id,
          name,
          plannedPennies: planned.get(row.id) ?? 0,
          actualResponsibilityPennies: responsibilityRows.error ? null : (actual.get(row.id) ?? 0),
          isCurrent: row.id === owedData?.currentContributorId,
          owed: canShowOwed && owedData ? contributorOwedSummary(owedData.balances, row.id) : null,
        }];
      }).sort((left, right) => left.name.localeCompare(right.name)));
      setOwedSnapshot({ summary: currentOwed, unavailable: owedResult.failed, loading: false });
      setFinancialError(purchaseRows.error || responsibilityRows.error
        ? "Contributor spending totals are unavailable until the Purchases migration is applied."
        : null);
    }
  }, [active, eventId]);

  // Deferred to a timeout for the same reason as the family context: it keeps
  // the first paint free of a synchronous state update from an effect body.
  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  // Contributor cards and the Owed panel are derived from these tables, so a
  // change on another device should land here without a reload. `people` and
  // `christmas_recipients` drive the family context instead, which refreshes
  // itself.
  useRealtimeRefresh(
    ["contributors", "recipient_contributions", "purchases", "purchase_allocations", "settlements"],
    () => load(true),
  );

  if (loading) {
    return (
      <AppShell snow={eventType === "christmas"}>
        <Masthead
          eventName={eventName}
          eventType={eventType}
          eventDate={eventDate}
          spentPennies={null}
          budgetPennies={0}
          activeCount={0}
          startedCount={0}
          purchaseCount={0}
          loading
        />
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
        <Skeleton className="mt-10 h-8 w-56" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </AppShell>
    );
  }

  const purchaseCount = active.reduce((sum, person) => sum + (person.giftCount ?? 0), 0);
  const startedCount = active.filter((person) => (person.spentPennies ?? 0) > 0).length;
  const overBudget = remainingPennies !== null && remainingPennies < 0;

  return (
    <AppShell snow={eventType === "christmas"}>
      <Masthead
        eventName={eventName}
        eventType={eventType}
        eventDate={eventDate}
        spentPennies={spentPennies}
        budgetPennies={budgetPennies}
        activeCount={active.length}
        startedCount={startedCount}
        purchaseCount={purchaseCount}
      />

      {(error || financialError) && (
        <div className="mt-6 space-y-3">
          {error && <Notice tone="danger">{error}</Notice>}
          {financialError && <Notice tone="warning">{financialError}</Notice>}
        </div>
      )}

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Budget overview">
        <Stat label="Total budget" value={formatPennies(budgetPennies)} tone="primary" detail="Across every active recipient" />
        <Stat label="Spent so far" value={spentPennies === null ? "Unavailable" : formatPennies(spentPennies)} detail={`${purchaseCount} ${purchaseCount === 1 ? "gift purchased" : "gifts purchased"}`} className="shadow-none" />
        <Stat
          label={overBudget ? "Over budget" : "Remaining"}
          value={remainingPennies === null ? "Unavailable" : formatPennies(Math.abs(remainingPennies))}
          tone={overBudget ? "warning" : "default"}
          detail={overBudget ? "Spending has exceeded the total plan." : "Still available to spend"}
          className={overBudget ? "" : "shadow-none"}
        />
      </section>

      <section className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-eyebrow text-gold uppercase">Family plan</p>
            <h2 className="mt-1.5 font-display text-2xl font-semibold">Contributors</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-600">Spent means each person&apos;s purchase responsibility. Owed also accounts for who paid and any payments recorded.</p>
          </div>
        </div>
        <GarlandRule className="mt-5" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {contributors.map((contributor) => <ContributorCard key={contributor.id} contributor={contributor} eventId={eventId} />)}
        </div>
      </section>

      <OwedSummary eventId={eventId} snapshot={owedSnapshot} />
    </AppShell>
  );
}

/**
 * The editorial cover: the year set large, with the one number that matters
 * most — overall spending against the plan — pulled up beside it rather than
 * buried in a card further down the page.
 */
function Masthead({
  eventName,
  eventType,
  eventDate,
  spentPennies,
  budgetPennies,
  activeCount,
  startedCount,
  purchaseCount,
  loading = false,
}: {
  eventName: string;
  eventType: string;
  eventDate: string;
  spentPennies: number | null;
  budgetPennies: number;
  activeCount: number;
  startedCount: number;
  purchaseCount: number;
  loading?: boolean;
}) {
  return (
    <header className="relative">
      <GarlandRule variant="swag" />
      <p className="mt-5 text-xs font-semibold tracking-eyebrow text-gold uppercase">
        {eventTypeMeta(eventType).icon} {eventTypeMeta(eventType).label} · {formatEventDate(eventDate)}
      </p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="min-w-0">
          {/* The active event, set large. Long names wrap rather than
              overflowing a phone, and nothing here is Christmas-specific. */}
          <h1 className="font-display text-[clamp(2.25rem,7vw,4rem)] leading-[1.02] font-semibold tracking-tight text-balance break-words text-ink-900">
            {eventName}
          </h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-ink-600">
            {loading
              ? "Loading this event's plan…"
              : <>{activeCount} {activeCount === 1 ? "person" : "people"} on the list · {startedCount} started · {purchaseCount} {purchaseCount === 1 ? "gift" : "gifts"} bought</>}
          </p>
        </div>

        <div className="w-full min-w-0 sm:max-w-sm">
          <div className="flex items-center gap-2.5">
            <IconTree size={18} className="shrink-0 text-gold" />
            <p className="text-xs font-semibold tracking-eyebrow text-ink-600 uppercase">Overall progress</p>
          </div>
          {loading || spentPennies === null
            ? <p className="mt-3 text-sm font-medium text-ink-600">Spending progress is unavailable.</p>
            : <FinancialProgressBar actualPennies={spentPennies} plannedPennies={budgetPennies} mode="budget" />}
        </div>
      </div>
      <GarlandRule className="mt-8" />
    </header>
  );
}

function ContributorCard({ contributor, eventId }: { contributor: ContributorTotal; eventId: string }) {
  const actual = contributor.actualResponsibilityPennies;
  const remaining = actual === null ? null : contributor.plannedPennies - actual;
  const overPlan = remaining !== null && remaining < 0;
  const owedPennies = contributor.owed?.youOwePennies ?? null;

  return (
    <article className={cx("relative flex min-w-0 flex-col rounded-2xl border bg-surface p-5 shadow-card", overPlan ? "border-berry-soft-border" : "border-line")}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 className="min-w-0 truncate font-display text-xl font-semibold">{contributor.name}</h3>
        {contributor.isCurrent && <Badge tone="success" dot={false}>You</Badge>}
      </div>

      <p className="mt-4 text-xs font-medium tracking-eyebrow text-ink-600 uppercase">Planned</p>
      <p className="mt-1 font-display text-3xl font-semibold tabular-nums text-ink-900">
        {formatPennies(contributor.plannedPennies)}
      </p>

      <dl className="mt-4 divide-y divide-line border-t border-line">
        <MetricRow label="Spent" value={actual === null ? "—" : formatPennies(actual)} />
        <MetricRow
          label="Owed"
          value={owedPennies === null ? "Unavailable" : formatPennies(owedPennies)}
          valueClass={owedPennies === null ? "text-ink-400" : owedPennies > 0 ? "text-berry" : "text-accent"}
        />
        <MetricRow
          label={overPlan ? "Over plan" : "Remaining"}
          value={remaining === null ? "—" : formatPennies(Math.abs(remaining))}
          valueClass={overPlan ? "text-berry" : undefined}
        />
      </dl>

      {actual === null
        ? <p className="mt-4 text-xs font-medium text-ink-600">Progress unavailable</p>
        : <FinancialProgressBar actualPennies={actual} plannedPennies={contributor.plannedPennies} mode="plan" showDifference={false} />}

      <Link href={eventPath(eventId, "owed") ?? "/"} className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent hover:gap-2.5">
        View Owed details
        <IconArrowRight size={15} />
      </Link>
    </article>
  );
}

function MetricRow({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-sm text-ink-600">{label}</dt>
      <dd className={cx("min-w-0 truncate text-sm font-semibold tabular-nums", valueClass)}>{value}</dd>
    </div>
  );
}
