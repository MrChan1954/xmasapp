"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { formatPennies } from "../../lib/currency";
import { INPUT_LIMITS, parseMoneyToPennies, validateRequiredText } from "../../lib/input-validation";
import {
  validateRecipientAllocationSnapshot,
  type RecipientAllocation,
} from "../../lib/recipient-allocations";
import { createClient } from "../../../utils/supabase/client";
import {
  purchaseProgressStatus,
  type PurchaseProgressStatus,
} from "../../lib/purchases";
import { AppNav } from "../components/app-nav";
import { FinancialProgressBar } from "../components/financial-progress";
import { useFamily, useTotals, type Person } from "../family-context";
import { PersonModal } from "./person-modal";
import {
  parseRecipientAllocationDraft,
  RecipientAllocationEditor,
  type RecipientAllocationDraftRow,
} from "./recipient-allocation-editor";

const filters = ["All", "Not started", "In progress", "Budget reached", "Over budget", "Has ideas"];

export default function PeoplePage() {
  const { people, saveRecipient, restore, loading, error, isAdmin } = useFamily();
  const { budgetPennies } = useTotals();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const visible = useMemo(
    () => people.filter((person) => {
      if (!person.active || !person.name.toLowerCase().includes(query.toLowerCase())) return false;
      if (filter === "All") return true;
      if (filter === "Has ideas") return (person.ideaCount ?? 0) > 0;
      if (person.spentPennies === null) return false;
      const status = purchaseProgressStatus(
        person.spentPennies,
        person.budgetPennies,
      );
      return filter === statusFilterLabel(status);
    }),
    [filter, people, query],
  );
  const archived = people.filter((person) => !person.active);
  const selected = selectedId ? people.find((person) => person.id === selectedId) ?? null : null;

  return (
    <main className="flex min-h-screen bg-[#f7f6f1] text-[#1d2926]">
      <AppNav />
      <div className="min-w-0 flex-1 pb-24 lg:pb-10">
        <div className="mx-auto max-w-[1360px] px-5 py-8 sm:px-8 lg:px-12">
          {error && <p className="mb-4 rounded-xl bg-[#f7e7df] p-4 text-sm text-[#a5543f]">{error}</p>}
          <header className="flex flex-wrap items-end justify-between gap-5">
            <div>
              <p className="text-sm font-semibold text-[#a64235]">Christmas 2026</p>
              <h1 className="mt-1 text-4xl font-bold">People</h1>
              <p className="mt-2 text-sm text-[#7b8581]">{visible.length} people <span className="px-1">·</span> {formatPennies(budgetPennies)} total budget</p>
            </div>
            <div className="grid w-full gap-3 sm:flex sm:w-auto">
              <input maxLength={INPUT_LIMITS.search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people" aria-label="Search people" className="h-12 min-w-0 flex-1 rounded-xl border border-[#d8dbd3] bg-white px-4 shadow-sm outline-none focus:border-[#6c9b8e] focus:ring-4 focus:ring-[#dcece7] sm:w-64" />
              {isAdmin && <button type="button" onClick={() => setAdding(true)} className="min-h-12 w-full rounded-xl bg-[#174f45] px-5 text-sm font-bold text-white shadow-sm sm:w-auto">+ Add person</button>}
            </div>
          </header>

          <div className="-mx-5 mt-5 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
            {filters.map((item) => (
              <button key={item} type="button" onClick={() => setFilter(item)} className={`min-h-11 shrink-0 rounded-full border px-4 py-2 text-xs font-bold transition ${filter === item ? "border-[#174f45] bg-[#174f45] text-white shadow-sm" : "border-[#e1e1d9] bg-white text-[#68736f] hover:border-[#c9d4cf]"}`}>{item}</button>
            ))}
          </div>

          {loading ? (
            <p className="mt-8 text-sm text-[#7b8581]">Loading people...</p>
          ) : visible.length > 0 ? (
            <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((person) => <PersonCard key={person.id} person={person} onClick={() => setSelectedId(person.id)} />)}
            </div>
          ) : (
            <div className="mt-7 rounded-2xl border border-dashed border-[#d4d6ce] bg-white px-5 py-10 text-center shadow-sm"><span className="text-3xl" aria-hidden>❄</span><p className="mt-3 font-bold">No people match this filter.</p><p className="mt-2 text-sm text-[#7b8581]">Try All or a different search.</p></div>
          )}

          {isAdmin && archived.length > 0 && (
            <section className="mt-10 rounded-2xl border border-[#e2e1d8] bg-white p-6 shadow-sm">
              <h2 className="text-lg font-bold">Removed people</h2>
              <p className="mt-1 text-sm text-[#7b8581]">Only Global Admin can restore people to Christmas.</p>
              <div className="mt-4 divide-y">
                {archived.map((person) => (
                  <div key={person.id} className="flex items-center justify-between gap-4 py-4"><span className="font-semibold">{person.name}</span><button type="button" onClick={() => void restore(person.id).catch(() => undefined)} className="rounded-xl border px-4 py-2 text-sm font-bold text-[#28685c]">Restore</button></div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {selected && <PersonModal person={selected} onClose={() => setSelectedId(null)} />}
      {isAdmin && adding && <AddForm onCancel={() => setAdding(false)} onSave={async (name, budget, allocations) => { await saveRecipient({ name, budgetPennies: budget, allocations }); setAdding(false); }} />}
    </main>
  );
}

function PersonCard({ person, onClick }: { person: Person; onClick: () => void }) {
  const status = person.spentPennies === null
    ? null
    : purchaseProgressStatus(person.spentPennies, person.budgetPennies);
  const presentation = status ? progressPresentation(status) : null;
  const borderStyle = status === "not_started"
    ? "border-l-4 border-l-[#c74f43]"
    : status === "in_progress"
      ? "border-l-4 border-l-[#d5a72c]"
      : status === "over_budget"
        ? "border-l-4 border-l-[#c74f43]"
        : status
          ? "border-l-4 border-l-[#2f8069]"
          : "border-[#e1e4df]";

  return (
    <button type="button" onClick={onClick} className={`group rounded-2xl border bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md active:scale-[0.99] ${borderStyle}`}>
      <div className="flex justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-bold">{person.name}</h2>
          <p className="mt-1 text-sm font-semibold">{person.spentPennies === null ? "Spending unavailable" : formatPennies(person.spentPennies)} <span className="font-normal text-[#89938f]">of {formatPennies(person.budgetPennies)}</span></p>
        </div>
        <span className={`h-fit shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${presentation?.badge ?? "bg-[#f5f7f6] text-[#6f7c77]"}`}>{presentation?.label ?? "Unavailable"}</span>
      </div>
      {person.spentPennies === null
        ? <p className="mt-4 text-xs font-semibold text-[#7b8581]">Budget progress unavailable</p>
        : <FinancialProgressBar actualPennies={person.spentPennies} plannedPennies={person.budgetPennies} mode="budget" />}
      <p className="mt-4 text-xs text-[#7b8581]">{person.giftCount === null ? "Purchases unavailable" : `${person.giftCount} ${person.giftCount === 1 ? "gift" : "gifts"}`} <span className="px-1">·</span> {person.ideaCount === null ? "Ideas unavailable" : `${person.ideaCount} ${person.ideaCount === 1 ? "idea" : "ideas"}`}</p>
    </button>
  );
}

function statusFilterLabel(status: PurchaseProgressStatus) {
  return status === "not_started" ? "Not started" : status === "in_progress" ? "In progress" : status === "budget_reached" ? "Budget reached" : "Over budget";
}

function progressPresentation(status: PurchaseProgressStatus) {
  if (status === "not_started") return { label: "Not started", badge: "border-[#edb5ad] bg-[#fff0ed] text-[#a63f33]" };
  if (status === "in_progress") return { label: "In progress", badge: "border-[#e8d08b] bg-[#fff6d8] text-[#745909]" };
  if (status === "over_budget") return { label: "Over budget", badge: "border-[#e3a79e] bg-[#fff0ed] text-[#a63f33]" };
  return { label: "Budget reached", badge: "border-[#abd0c2] bg-[#e8f5f0] text-[#17624f]" };
}

function AddForm({ onCancel, onSave }: { onCancel: () => void; onSave: (name: string, budgetPennies: number, allocations: RecipientAllocation[]) => Promise<void> }) {
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [rows, setRows] = useState<RecipientAllocationDraftRow[]>([]);
  const [contributorsLoading, setContributorsLoading] = useState(true);
  const [contributorsReady, setContributorsReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadContributors = async () => {
      const db = createClient();
      const event = await db.from("christmas_events").select("id").eq("year", 2026).maybeSingle();
      if (cancelled) return;
      if (event.error || !event.data) {
        setError("Christmas 2026 contributors could not be loaded.");
        setContributorsLoading(false);
        return;
      }

      const contributors = await db
        .from("contributors")
        .select("id,person_id")
        .eq("christmas_event_id", event.data.id)
        .eq("active", true);
      if (cancelled) return;
      if (contributors.error) {
        setError("Christmas 2026 contributors could not be loaded.");
        setContributorsLoading(false);
        return;
      }

      const people = contributors.data.length
        ? await db.from("people").select("id,name").in("id", contributors.data.map((row) => row.person_id))
        : { data: [], error: null };
      if (cancelled) return;
      if (people.error) {
        setError("Contributor names could not be loaded.");
        setContributorsLoading(false);
        return;
      }

      const names = new Map((people.data ?? []).map((person) => [person.id, person.name]));
      const resolved = contributors.data.flatMap((contributor) => {
        const contributorName = names.get(contributor.person_id);
        return contributorName ? [{
          contributorId: contributor.id,
          name: contributorName,
          selected: true,
          amountInput: "0",
        }] : [];
      }).sort((left, right) => left.name.localeCompare(right.name, "en-GB") || left.contributorId.localeCompare(right.contributorId));

      if (resolved.length !== contributors.data.length) {
        setError("A contributor is not linked to a readable family person.");
      } else {
        setContributorsReady(true);
      }
      setRows(resolved);
      setContributorsLoading(false);
    };
    void loadContributors();
    return () => { cancelled = true; };
  }, []);

  const parsedBudget = parseMoneyToPennies(budget, { field: "a Christmas budget" });
  const budgetPennies = parsedBudget.ok ? parsedBudget.value : null;
  const parsedDraft = parseRecipientAllocationDraft(rows);
  const plan = budgetPennies !== null && parsedDraft.ok
    ? validateRecipientAllocationSnapshot(budgetPennies, parsedDraft.value)
    : null;
  const canSave = contributorsReady && plan?.ok === true;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const validName = validateRequiredText(name, { field: "a name", maxLength: INPUT_LIMITS.name });
    if (!validName.ok) { setError(validName.error); return; }
    if (!parsedBudget.ok || parsedBudget.value === null) { setError(parsedBudget.ok ? "Enter a Christmas budget." : parsedBudget.error); return; }
    if (!parsedDraft.ok) { setError(parsedDraft.error); return; }
    const validPlan = validateRecipientAllocationSnapshot(parsedBudget.value, parsedDraft.value);
    if (!validPlan.ok) {
      const total = parsedDraft.value.reduce((sum, row) => sum + row.plannedAmountPennies, 0);
      setError(total < parsedBudget.value
        ? `${formatPennies(parsedBudget.value - total)} still needs allocating.`
        : `Allocation exceeds the budget by ${formatPennies(total - parsedBudget.value)}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try { await onSave(validName.value, parsedBudget.value, validPlan.value); } catch { setError("The person could not be added. Existing Christmas data was not changed."); setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#092d27]/60 p-0 backdrop-blur-[2px] sm:items-center sm:p-4">
      <form onSubmit={(event) => void submit(event)} role="dialog" aria-modal="true" aria-labelledby="add-person-title" className="max-h-[96vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border-t-4 border-[#c5a65a] bg-white p-6 shadow-2xl sm:rounded-3xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#a64235]">Christmas 2026</p>
        <h2 id="add-person-title" className="mt-1 text-xl font-bold">Add person</h2>
        <label className="mt-5 block text-sm font-semibold">Name<input required maxLength={INPUT_LIMITS.name} value={name} onChange={(event) => setName(event.target.value)} className="mt-2 h-12 w-full rounded-xl border px-3" /></label>
        <label className="mt-4 block text-sm font-semibold">Christmas budget<input maxLength={INPUT_LIMITS.money} value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" className="mt-2 h-12 w-full rounded-xl border px-3" /></label>
        <div className="mt-6 border-t border-[#e5e4dc] pt-5">
          <h3 className="font-bold">Who contributes?</h3>
          <p className="mt-1 text-sm text-[#7b8581]">Create a complete plan before adding this person.</p>
          {contributorsLoading ? (
            <p className="mt-4 text-sm text-[#7b8581]">Loading contributors...</p>
          ) : (
            <RecipientAllocationEditor
              idPrefix="add-person-contributor"
              budgetPennies={budgetPennies}
              rows={rows}
              onChange={setRows}
            />
          )}
        </div>
        {error && <p className="mt-3 text-sm text-[#a5543f]">{error}</p>}
        <div className="sticky bottom-0 -mx-6 mt-5 grid grid-cols-2 gap-3 border-t bg-white/95 px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-0"><button type="button" onClick={onCancel} disabled={saving} className="min-h-12 rounded-xl border py-3 font-semibold disabled:opacity-50">Cancel</button><button disabled={saving || !canSave} className="min-h-12 rounded-xl bg-[#174f45] py-3 font-bold text-white shadow-sm disabled:opacity-50">{saving ? "Creating..." : "Create person"}</button></div>
      </form>
    </div>
  );
}
