"use client";

import { useEffect, useState } from "react";
import { formatPennies } from "../../lib/currency";
import { contributorOwedSummary } from "../../lib/owed";
import { ButtonLink, Skeleton } from "../components/ui";
import { loadOwedData } from "./owed-data";

type Summary = { owedToYouPennies: number; youOwePennies: number };

export function OwedSummary({ snapshot }: { snapshot?: { summary: Summary | null; unavailable: boolean; loading: boolean } }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    if (snapshot) return () => { active = false; };
    const load = async () => {
      try {
        const data = await loadOwedData();
        if (active) setSummary(contributorOwedSummary(data.balances, data.currentContributorId));
      } catch {
        if (active) setUnavailable(true);
      }
    };
    void load();
    return () => { active = false; };
  }, [snapshot]);

  const shownSummary = snapshot ? snapshot.summary : summary;
  const shownUnavailable = snapshot ? snapshot.unavailable : unavailable;
  const shownLoading = snapshot ? snapshot.loading : summary === null && !unavailable;

  return (
    <section className="mt-8 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-gold">Payments</p>
          <h2 className="mt-1 font-display text-xl font-semibold">Owed</h2>
          <p className="mt-1 text-sm text-ink-600">Your current Christmas 2026 balance</p>
        </div>
        <ButtonLink href="/owed" variant="tonal">View details</ButtonLink>
      </div>
      {shownUnavailable ? (
        <p className="mt-4 text-sm text-ink-600">Owed totals are unavailable until payments are set up.</p>
      ) : shownSummary ? (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-accent-soft-border bg-accent-soft p-4">
            <p className="text-sm font-medium text-accent">You are owed</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-accent">{formatPennies(shownSummary.owedToYouPennies)}</p>
          </div>
          <div className="rounded-xl border border-line bg-surface-2 p-4">
            <p className="text-sm font-medium text-ink-600">You owe</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{formatPennies(shownSummary.youOwePennies)}</p>
          </div>
        </div>
      ) : shownLoading ? (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : null}
    </section>
  );
}
