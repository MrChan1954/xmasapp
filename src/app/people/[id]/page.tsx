"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "../../../../utils/supabase/client";
import { formatPennies } from "../../../lib/currency";
import { INPUT_LIMITS, parseMoneyToPennies, validateUuid } from "../../../lib/input-validation";
import { splitPenniesEqually, validateRecipientAllocationSnapshot } from "../../../lib/recipient-allocations";

type Contribution = {
  contributorId: string;
  name: string;
  personId: string;
  amountPennies: number;
};

type Detail = {
  name: string;
  budgetPennies: number;
  eventId: string;
  contributions: Contribution[];
};

export default function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    const db = createClient();
    setError(null);
    const validId = validateUuid(id, "This person link is invalid.");
    if (!validId.ok) {
      setError(validId.error);
      return;
    }

    try {
      const recipient = await db
        .from("christmas_recipients")
        .select("id,person_id,christmas_event_id,budget_pennies")
        .eq("id", validId.value)
        .maybeSingle();
      if (recipient.error || !recipient.data) throw new Error("This Christmas recipient could not be loaded.");

      const [recipientPerson, contributors, contributionRows] = await Promise.all([
        db.from("people").select("name").eq("id", recipient.data.person_id).maybeSingle(),
        db.from("contributors").select("id,person_id").eq("christmas_event_id", recipient.data.christmas_event_id).eq("active", true),
        db.from("recipient_contributions").select("contributor_id,planned_amount_pennies").eq("christmas_recipient_id", validId.value),
      ]);
      if (recipientPerson.error || !recipientPerson.data) throw new Error("This person's name could not be loaded.");
      if (contributors.error || contributionRows.error) throw new Error("Contributor details could not be loaded.");

      const personIds = contributors.data.map((row) => row.person_id);
      const contributorPeople = personIds.length
        ? await db.from("people").select("id,name").in("id", personIds)
        : { data: [], error: null };
      if (contributorPeople.error) throw new Error("Contributor names could not be loaded.");

      const nameByPersonId = new Map((contributorPeople.data ?? []).map((person) => [person.id, person.name]));
      const amountByContributorId = new Map(contributionRows.data.map((row) => [row.contributor_id, row.planned_amount_pennies]));
      const resolved = contributors.data.map((contributor) => {
        const name = nameByPersonId.get(contributor.person_id);
        if (!name) throw new Error("A contributor is not linked to a readable family person.");
        return { contributorId: contributor.id, personId: contributor.person_id, name, amountPennies: amountByContributorId.get(contributor.id) ?? 0 };
      }).sort((left, right) => left.name.localeCompare(right.name, "en-GB") || left.contributorId.localeCompare(right.contributorId));

      setDetail({ name: recipientPerson.data.name, budgetPennies: recipient.data.budget_pennies, eventId: recipient.data.christmas_event_id, contributions: resolved });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This person could not be loaded.");
    }
  }, [id]);

  useEffect(() => { const handle = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(handle); }, [load]);

  if (error) return <ErrorPage />;
  if (!detail) return <main className="min-h-screen bg-[#f8f8f6] p-6 text-sm text-[#7b8581]">Loading person...</main>;

  return <main className="min-h-screen bg-[#f8f8f6] text-[#1d2926]"><div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:px-12"><Link href="/people" className="text-sm font-semibold text-[#28685c]">Back to People</Link><header className="mt-7 rounded-3xl bg-[#1f5b50] p-6 text-white sm:p-8"><p className="text-sm text-[#c6ded8]">Christmas 2026</p><h1 className="mt-2 text-4xl font-bold">{detail.name}</h1><div className="mt-7 grid grid-cols-3 gap-3"><Metric label="Budget" value={detail.budgetPennies} /><Metric label="Spent" value={0} /><Metric label="Remaining" value={detail.budgetPennies} /></div></header><section className="mt-6 rounded-2xl bg-white p-6"><div className="flex items-center justify-between gap-4"><h2 className="text-lg font-bold">Contributors</h2><button onClick={() => setEditing(true)} className="rounded-xl border border-[#cbdad5] px-4 py-2 text-sm font-bold text-[#28685c]">Edit contributors</button></div><div className="mt-5 space-y-3">{detail.contributions.map((row) => <div key={row.contributorId} className="flex justify-between rounded-xl bg-[#f8f8f6] p-4"><span>{row.name}</span><strong>{formatPennies(row.amountPennies)}</strong></div>)}</div></section>{editing && <ContributionEditor recipientId={id} detail={detail} onCancel={() => setEditing(false)} onSaved={async () => { setEditing(false); await load(); }} />}</div></main>;
}

function ContributionEditor({ recipientId, detail, onCancel, onSaved }: { recipientId: string; detail: Detail; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState(detail.contributions.map((row) => ({ ...row, selected: row.amountPennies > 0 })));
  const [adjusting, setAdjusting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allocated = rows.reduce((sum, row) => sum + row.amountPennies, 0);

  const toggle = (id: string) => setRows((current) => current.map((row) => row.contributorId === id ? { ...row, selected: !row.selected, amountPennies: row.selected ? 0 : row.amountPennies } : row));
  const splitEqually = () => { const selected = rows.filter((row) => row.selected); if (!selected.length) { setError("Choose at least one contributor first."); return; } const split = new Map(splitPenniesEqually(detail.budgetPennies, selected.map((row) => row.contributorId)).map((row) => [row.contributorId, row.plannedAmountPennies])); setRows((current) => current.map((row) => ({ ...row, amountPennies: row.selected ? (split.get(row.contributorId) ?? 0) : 0 }))); setError(null); };
  const save = async () => { if (allocated !== detail.budgetPennies) { setError(allocated < detail.budgetPennies ? `${formatPennies(detail.budgetPennies - allocated)} still needs allocating.` : `Allocation exceeds the budget by ${formatPennies(allocated - detail.budgetPennies)}.`); return; } const recipient = validateUuid(recipientId); const plan = validateRecipientAllocationSnapshot(detail.budgetPennies, rows.map((row) => ({ contributorId: row.contributorId, plannedAmountPennies: row.amountPennies }))); if (!recipient.ok || !plan.ok) { setError(plan.ok ? "This Christmas recipient is invalid. Refresh and try again." : plan.error); return; } setSaving(true); const result = await createClient().rpc("save_christmas_recipient_with_contributions", { p_christmas_recipient_id: recipient.value, p_christmas_event_id: detail.eventId, p_name: detail.name, p_budget_pennies: detail.budgetPennies, p_allocations: plan.value.map((row) => ({ contributor_id: row.contributorId, planned_amount_pennies: row.plannedAmountPennies })) }); if (result.error) { setError("Contributor changes could not be saved. Existing allocations were kept."); setSaving(false); return; } await onSaved(); };

  return <div className="fixed inset-0 z-30 flex items-end justify-center bg-[#1d2926]/35 p-4 sm:items-center"><div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6"><h2 className="text-xl font-bold">Who contributes towards {detail.name}?</h2><p className="mt-2 text-sm text-[#7b8581]">Budget {formatPennies(detail.budgetPennies)}</p><div className="mt-5 space-y-3">{rows.map((row) => <div key={row.contributorId} className="rounded-xl border border-[#e3e8e5] p-4"><label className="flex cursor-pointer items-center justify-between"><span className="flex items-center gap-3"><input type="checkbox" checked={row.selected} onChange={() => toggle(row.contributorId)} className="h-5 w-5 accent-[#1f5b50]" /><strong>{row.name}</strong></span><span>{formatPennies(row.amountPennies)}</span></label>{adjusting && row.selected && <label className="mt-3 block text-xs text-[#7b8581]">Amount in pounds<input maxLength={INPUT_LIMITS.money} value={(row.amountPennies / 100).toString()} onChange={(event) => { const parsed = parseMoneyToPennies(event.target.value); if (parsed.ok && parsed.value !== null) setRows((current) => current.map((item) => item.contributorId === row.contributorId ? { ...item, amountPennies: parsed.value as number } : item)); }} inputMode="decimal" className="mt-1 h-10 w-full rounded-lg border px-3 text-sm text-[#1d2926]" /></label>}</div>)}</div><div className="mt-5 flex gap-3"><button onClick={splitEqually} className="flex-1 rounded-xl bg-[#e4f1ed] py-3 text-sm font-bold text-[#28685c]">Split equally</button><button onClick={() => setAdjusting(!adjusting)} className="flex-1 rounded-xl border py-3 text-sm font-bold">{adjusting ? "Hide amounts" : "Adjust amounts"}</button></div><p className={`mt-4 text-sm font-semibold ${allocated === detail.budgetPennies ? "text-[#28685c]" : "text-[#a5543f]"}`}>Allocated {formatPennies(allocated)} of {formatPennies(detail.budgetPennies)}</p>{error && <p className="mt-2 text-sm text-[#a5543f]">{error}</p>}<div className="mt-6 flex gap-3"><button onClick={onCancel} className="flex-1 rounded-xl border py-3 font-semibold">Cancel</button><button disabled={saving || allocated !== detail.budgetPennies} onClick={() => void save()} className="flex-1 rounded-xl bg-[#1f5b50] py-3 font-semibold text-white disabled:opacity-50">{saving ? "Saving..." : "Save"}</button></div></div></div>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div><p className="text-xs text-[#c6ded8]">{label}</p><p className="mt-1 text-xl font-bold">{formatPennies(value)}</p></div>; }
function ErrorPage() { return <main className="min-h-screen bg-[#f8f8f6] p-6"><Link href="/people" className="font-semibold text-[#28685c]">Back to People</Link><p className="mt-8 rounded-2xl bg-white p-5 text-sm text-[#a5543f]">Unable to load this person. Check the link and try again.</p></main>; }
