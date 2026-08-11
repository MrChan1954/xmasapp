"use client";

import Link from "next/link";
<<<<<<< HEAD
import { useEffect, useState } from "react";
import { createClient } from "../../utils/supabase/client";
import { formatPennies } from "../lib/currency";
import { contributorOwedSummary } from "../lib/owed";
import { AppNav } from "./components/app-nav";
import { FinancialProgressBar } from "./components/financial-progress";
=======
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "../../utils/supabase/client";
import { formatPennies } from "../lib/currency";
import { contributorOwedSummary } from "../lib/owed";
import { AppShell } from "./components/app-shell";
import { GarlandRule } from "./components/festive/garland";
import { FinancialProgressBar } from "./components/financial-progress";
import { IconArrowRight, IconTree } from "./components/icons";
import { Badge, Notice, Skeleton, Stat, cx } from "./components/ui";
import { useRealtimeRefresh } from "./components/use-realtime-refresh";
>>>>>>> 7534a2d (redesign and realtime)
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

export default function Home() {
  const { loading, error } = useFamily();
  const { budgetPennies, spentPennies, remainingPennies, active } = useTotals();
  const [contributors, setContributors] = useState<ContributorTotal[]>([]);
  const [financialError, setFinancialError] = useState<string | null>(null);
  const [owedSnapshot, setOwedSnapshot] = useState<{
    summary: OwedTotals | null;
    unavailable: boolean;
    loading: boolean;
  }>({ summary: null, unavailable: false, loading: true });

<<<<<<< HEAD
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const db = createClient();
      setOwedSnapshot({ summary: null, unavailable: false, loading: true });
      const event = await db.from("christmas_events").select("id").eq("year", 2026).maybeSingle();
      if (!mounted) return;
=======
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
      const event = await db.from("christmas_events").select("id").eq("year", 2026).maybeSingle();
      if (!mounted()) return;
>>>>>>> 7534a2d (redesign and realtime)
      if (event.error || !event.data) {
        setFinancialError("Contributor totals could not be loaded.");
        setOwedSnapshot({ summary: null, unavailable: true, loading: false });
        return;
      }

      const [contributorRows, owedResult] = await Promise.all([
        db.from("contributors").select("id,person_id").eq("christmas_event_id", event.data.id).eq("active", true),
        loadOwedData()
          .then((data) => ({ data, failed: false }))
          .catch(() => ({ data: null, failed: true })),
      ]);
<<<<<<< HEAD
      if (!mounted) return;
=======
      if (!mounted()) return;
>>>>>>> 7534a2d (redesign and realtime)
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
<<<<<<< HEAD
      if (!mounted) return;
=======
      if (!mounted()) return;
>>>>>>> 7534a2d (redesign and realtime)
      if (peopleRows.error || plannedRows.error) {
        setFinancialError("Contributor plans could not be loaded.");
        setOwedSnapshot({ summary: null, unavailable: owedResult.failed, loading: false });
        return;
      }

      const purchaseIds = (purchaseRows.data ?? []).map((row) => row.id);
      const responsibilityRows = !purchaseRows.error && purchaseIds.length
        ? await db.from("purchase_allocations").select("purchase_id,contributor_id,responsibility_pennies").in("purchase_id", purchaseIds).in("contributor_id", contributorIds)
        : { data: [], error: purchaseRows.error };
<<<<<<< HEAD
      if (!mounted) return;
=======
      if (!mounted()) return;
>>>>>>> 7534a2d (redesign and realtime)

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
<<<<<<< HEAD
    };
    void load();
    return () => { mounted = false; };
  }, [active]);

  if (loading) {
    return <main className="flex min-h-screen bg-[#f7f6f1] text-[#1d2926]"><AppNav /><div className="flex min-w-0 flex-1 items-center justify-center pb-24"><p className="rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#64716c] shadow-sm">Loading Christmas 2026...</p></div></main>;
=======
    }
  }, [active]);

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
      <AppShell snow>
        <Masthead
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
>>>>>>> 7534a2d (redesign and realtime)
  }

  const purchaseCount = active.reduce((sum, person) => sum + (person.giftCount ?? 0), 0);
  const startedCount = active.filter((person) => (person.spentPennies ?? 0) > 0).length;
<<<<<<< HEAD

  return (
    <main className="flex min-h-screen bg-[#f7f6f1] text-[#1d2926]">
      <AppNav />
      <div className="min-w-0 flex-1 pb-24 lg:pb-10">
        <div className="mx-auto max-w-[1360px] px-5 py-8 sm:px-8 lg:px-12">
          {error && <p className="mb-5 rounded-xl bg-[#f7e7df] p-4 text-sm text-[#a5543f]">{error}</p>}
          {financialError && <p className="mb-5 rounded-xl bg-[#fff8e4] p-4 text-sm text-[#715b1c]">{financialError}</p>}
          <p className="text-sm font-semibold text-[#a64235]">Good morning</p>
          <div className="mt-1 flex items-center gap-3"><h1 className="text-4xl font-bold">Christmas 2026</h1><span className="hidden h-8 w-8 items-center justify-center rounded-full bg-[#c5a65a] text-[#103f36] sm:flex" aria-hidden>✦</span></div>

          <section className="mt-8 grid gap-4 md:grid-cols-3">
            <Summary label="Total budget" value={formatPennies(budgetPennies)} primary />
            <Summary label="Spent" value={spentPennies === null ? "Unavailable" : formatPennies(spentPennies)} />
            <Summary label={remainingPennies !== null && remainingPennies < 0 ? "Over budget" : "Remaining"} value={remainingPennies === null ? "Unavailable" : formatPennies(Math.abs(remainingPennies))} warning={remainingPennies !== null && remainingPennies < 0} />
          </section>

          <section className="mt-6 rounded-2xl border border-[#e2e1d8] bg-white p-5 shadow-sm sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#a64235]">Family plan</p>
            <h2 className="mt-1 text-lg font-bold">Contributors</h2>
            <p className="mt-1 text-xs leading-5 text-[#7b8581]">Spent means each person&apos;s purchase responsibility. Owed also accounts for who paid and any payments recorded.</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
              {contributors.map((contributor) => <ContributorCard key={contributor.id} contributor={contributor} />)}
            </div>
          </section>

          <OwedSummary snapshot={owedSnapshot} />

          <section className="mt-6 rounded-2xl border border-[#e2e1d8] bg-white p-6 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#a64235]">Season overview</p>
            <h2 className="mt-1 text-lg font-bold">Christmas progress</h2>
            <p className="mt-3 text-sm text-[#7b8581]">{active.length} active people · {startedCount} started · {purchaseCount} {purchaseCount === 1 ? "gift purchased" : "gifts purchased"}</p>
            {spentPennies === null
              ? <p className="mt-3 text-sm font-semibold text-[#7b8581]">Spending progress is unavailable.</p>
              : <FinancialProgressBar actualPennies={spentPennies} plannedPennies={budgetPennies} mode="budget" />}
          </section>
        </div>
      </div>
    </main>
=======
  const overBudget = remainingPennies !== null && remainingPennies < 0;

  return (
    <AppShell snow>
      <Masthead
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
          detail={overBudget ? "Christmas spending has exceeded the total plan." : "Still available to spend"}
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
          {contributors.map((contributor) => <ContributorCard key={contributor.id} contributor={contributor} />)}
        </div>
      </section>

      <OwedSummary snapshot={owedSnapshot} />
    </AppShell>
  );
}

/**
 * The editorial cover: the year set large, with the one number that matters
 * most — overall spending against the plan — pulled up beside it rather than
 * buried in a card further down the page.
 */
function Masthead({
  spentPennies,
  budgetPennies,
  activeCount,
  startedCount,
  purchaseCount,
  loading = false,
}: {
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
      <p className="mt-5 text-xs font-semibold tracking-eyebrow text-gold uppercase">Family gift planner</p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="min-w-0">
          <h1 className="font-display text-[clamp(2.75rem,8vw,4.5rem)] leading-[0.95] font-semibold tracking-tight text-ink-900">
            Christmas<span className="block text-gold">2026</span>
          </h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-ink-600">
            {loading
              ? "Loading this year's plan…"
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
>>>>>>> 7534a2d (redesign and realtime)
  );
}

function ContributorCard({ contributor }: { contributor: ContributorTotal }) {
  const actual = contributor.actualResponsibilityPennies;
  const remaining = actual === null ? null : contributor.plannedPennies - actual;
<<<<<<< HEAD
  const owedPennies = contributor.owed?.youOwePennies ?? null;

  return (
    <article className={`min-w-0 rounded-xl border p-4 ${remaining !== null && remaining < 0 ? "border-[#e3a79e] bg-[#fff7f4]" : "border-[#e7e5dc] bg-[#faf9f5]"}`}>
      <div className="flex min-w-0 items-start justify-between gap-3"><h3 className="min-w-0 break-words font-bold">{contributor.name}</h3>{contributor.isCurrent && <span className="shrink-0 rounded-full bg-[#e4f1ed] px-2 py-1 text-[10px] font-bold uppercase text-[#28685c]">You</span>}</div>
      <dl className="mt-4 grid min-w-0 grid-cols-2 gap-x-4 gap-y-4 text-sm">
        <div className="min-w-0"><dt className="text-[11px] font-bold uppercase tracking-wide text-[#7b8581]">Planned</dt><dd className="mt-1 break-words text-lg font-bold tabular-nums text-[#28685c]">{formatPennies(contributor.plannedPennies)}</dd></div>
        <div className="min-w-0"><dt className="text-[11px] font-bold uppercase tracking-wide text-[#7b8581]">Spent</dt><dd className="mt-1 break-words text-lg font-bold tabular-nums">{actual === null ? "—" : formatPennies(actual)}</dd></div>
        <div className="min-w-0"><dt className="text-[11px] font-bold uppercase tracking-wide text-[#7b8581]">Owed</dt><dd className={`mt-1 break-words text-lg font-bold tabular-nums ${owedPennies === null ? "text-[#7b8581]" : owedPennies > 0 ? "text-[#9a503c]" : "text-[#174f45]"}`}>{owedPennies === null ? "Unavailable" : formatPennies(owedPennies)}</dd></div>
        <div className="min-w-0"><dt className="text-[11px] font-bold uppercase tracking-wide text-[#7b8581]">{remaining !== null && remaining < 0 ? "Over plan" : "Remaining"}</dt><dd className={`mt-1 break-words text-lg font-bold tabular-nums ${remaining !== null && remaining < 0 ? "text-[#a63f33]" : ""}`}>{remaining === null ? "—" : formatPennies(Math.abs(remaining))}</dd></div>
      </dl>
      {actual === null ? <p className="mt-4 text-xs font-semibold text-[#7b8581]">Progress unavailable</p> : <FinancialProgressBar actualPennies={actual} plannedPennies={contributor.plannedPennies} mode="plan" showDifference={false} />}
      <Link href="/owed" className="mt-4 inline-flex min-h-11 items-center text-xs font-bold text-[#28685c]">View Owed details</Link>
=======
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

      <Link href="/owed" className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent hover:gap-2.5">
        View Owed details
        <IconArrowRight size={15} />
      </Link>
>>>>>>> 7534a2d (redesign and realtime)
    </article>
  );
}

<<<<<<< HEAD
function Summary({ label, value, primary = false, warning = false }: { label: string; value: string; primary?: boolean; warning?: boolean }) {
  return <div className={`rounded-2xl border p-6 shadow-sm ${primary ? "border-[#2c655a] bg-[#123f37] text-white" : warning ? "border-[#e3a79e] bg-[#fff3f0] text-[#8e3027]" : "border-[#e2e1d8] bg-white"}`}><p className={primary ? "text-[#d5e3df]" : warning ? "font-semibold text-[#a64235]" : "text-[#89938f]"}>{label}</p><p className="mt-3 text-3xl font-bold">{value}</p>{warning && <p className="mt-2 text-xs font-semibold">Christmas spending has exceeded the total plan.</p>}</div>;
=======
function MetricRow({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-sm text-ink-600">{label}</dt>
      <dd className={cx("min-w-0 truncate text-sm font-semibold tabular-nums", valueClass)}>{value}</dd>
    </div>
  );
>>>>>>> 7534a2d (redesign and realtime)
}
