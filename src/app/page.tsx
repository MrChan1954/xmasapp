"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "../../utils/supabase/client";
import { formatPennies } from "../lib/currency";
import { contributorOwedSummary } from "../lib/owed";
import { AppNav } from "./components/app-nav";
import { FinancialProgressBar } from "./components/financial-progress";
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

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const db = createClient();
      setOwedSnapshot({ summary: null, unavailable: false, loading: true });
      const event = await db.from("christmas_events").select("id").eq("year", 2026).maybeSingle();
      if (!mounted) return;
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
      if (!mounted) return;
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
      if (!mounted) return;
      if (peopleRows.error || plannedRows.error) {
        setFinancialError("Contributor plans could not be loaded.");
        setOwedSnapshot({ summary: null, unavailable: owedResult.failed, loading: false });
        return;
      }

      const purchaseIds = (purchaseRows.data ?? []).map((row) => row.id);
      const responsibilityRows = !purchaseRows.error && purchaseIds.length
        ? await db.from("purchase_allocations").select("purchase_id,contributor_id,responsibility_pennies").in("purchase_id", purchaseIds).in("contributor_id", contributorIds)
        : { data: [], error: purchaseRows.error };
      if (!mounted) return;

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
    };
    void load();
    return () => { mounted = false; };
  }, [active]);

  if (loading) {
    return <main className="flex min-h-screen bg-[#f7f6f1] text-[#1d2926]"><AppNav /><div className="flex min-w-0 flex-1 items-center justify-center pb-24"><p className="rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#64716c] shadow-sm">Loading Christmas 2026...</p></div></main>;
  }

  const purchaseCount = active.reduce((sum, person) => sum + (person.giftCount ?? 0), 0);
  const startedCount = active.filter((person) => (person.spentPennies ?? 0) > 0).length;

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
  );
}

function ContributorCard({ contributor }: { contributor: ContributorTotal }) {
  const actual = contributor.actualResponsibilityPennies;
  const remaining = actual === null ? null : contributor.plannedPennies - actual;
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
    </article>
  );
}

function Summary({ label, value, primary = false, warning = false }: { label: string; value: string; primary?: boolean; warning?: boolean }) {
  return <div className={`rounded-2xl border p-6 shadow-sm ${primary ? "border-[#2c655a] bg-[#123f37] text-white" : warning ? "border-[#e3a79e] bg-[#fff3f0] text-[#8e3027]" : "border-[#e2e1d8] bg-white"}`}><p className={primary ? "text-[#d5e3df]" : warning ? "font-semibold text-[#a64235]" : "text-[#89938f]"}>{label}</p><p className="mt-3 text-3xl font-bold">{value}</p>{warning && <p className="mt-2 text-xs font-semibold">Christmas spending has exceeded the total plan.</p>}</div>;
}
