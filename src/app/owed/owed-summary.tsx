"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatPennies } from "../../lib/currency";
import { contributorOwedSummary } from "../../lib/owed";
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

  return <section className="mt-6 rounded-2xl border border-[#e2e1d8] bg-white p-5 shadow-sm sm:p-6"><div className="flex items-center justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#a64235]">Payments</p><h2 className="mt-1 text-lg font-bold">Owed</h2><p className="mt-1 text-xs text-[#7b8581]">Your current Christmas 2026 balance</p></div><Link href="/owed" className="min-h-11 rounded-xl border border-[#bfd1cb] bg-[#edf5f2] px-4 py-3 text-sm font-bold text-[#174f45]">View details</Link></div>{shownUnavailable ? <p className="mt-4 text-sm text-[#75807c]">Owed totals are unavailable until payments are set up.</p> : shownSummary ? <div className="mt-5 grid grid-cols-2 gap-3"><div className="rounded-xl border border-[#d4e5df] bg-[#eaf4f1] p-4"><p className="text-xs font-semibold text-[#55706a]">You are owed</p><p className="mt-1 text-2xl font-bold text-[#174f45]">{formatPennies(shownSummary.owedToYouPennies)}</p></div><div className="rounded-xl border border-[#e7e5dc] bg-[#faf9f5] p-4"><p className="text-xs font-semibold text-[#69746f]">You owe</p><p className="mt-1 text-2xl font-bold">{formatPennies(shownSummary.youOwePennies)}</p></div></div> : shownLoading ? <div className="mt-5 grid animate-pulse grid-cols-2 gap-3"><div className="h-20 rounded-xl bg-[#edf1ef]" /><div className="h-20 rounded-xl bg-[#edf1ef]" /></div> : null}</section>;
}
