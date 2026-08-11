"use client";

<<<<<<< HEAD
import { useCallback, useEffect, useRef, useState } from "react";
=======
import { useCallback, useEffect, useState } from "react";
>>>>>>> 7534a2d (redesign and realtime)
import { createClient } from "../../../utils/supabase/client";
import { formatPennies } from "../../lib/currency";
import { INPUT_LIMITS, parseMoneyToPennies, validateRequiredText } from "../../lib/input-validation";
import { validateRecipientAllocationSnapshot, type RecipientAllocation } from "../../lib/recipient-allocations";
import { purchaseProgressStatus, type PurchaseProgressStatus } from "../../lib/purchases";
import { useFamily, type Person } from "../family-context";
import { FinancialProgressBar } from "../components/financial-progress";
<<<<<<< HEAD
=======
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  ModalFooter,
  ModalHeader,
  MoneyInput,
  Notice,
  cx,
  type BadgeTone,
} from "../components/ui";
>>>>>>> 7534a2d (redesign and realtime)
import { GiftIdeas } from "./gift-ideas";
import { Purchases } from "./purchases";
import {
  createRecipientAllocationDraftRows,
  parseRecipientAllocationDraft,
  RecipientAllocationEditor,
} from "./recipient-allocation-editor";

type Contribution = {
  contributorId: string;
  name: string;
  amountPennies: number;
  spentPennies: number;
};

export function PersonModal({ person, onClose }: { person: Person; onClose: () => void }) {
  const { saveRecipient, archive, isAdmin, setIdeaCount, setPurchaseMetrics } = useFamily();
<<<<<<< HEAD
  const panel = useRef<HTMLDivElement>(null);
=======
>>>>>>> 7534a2d (redesign and realtime)
  const [rows, setRows] = useState<Contribution[]>([]);
  const [mode, setMode] = useState<"view" | "contributors" | "person">("view");
  const [loading, setLoading] = useState(true);
  const [contributionsLoaded, setContributionsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(person.name);
  const [budget, setBudget] = useState(priceInput(person.budgetPennies));
  const [saving, setSaving] = useState(false);
<<<<<<< HEAD
=======
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
>>>>>>> 7534a2d (redesign and realtime)

  const loadContributions = useCallback(async () => {
    const db = createClient();
    setLoading(true);
    setContributionsLoaded(false);
    setError(null);
    const recipient = await db
      .from("christmas_recipients")
      .select("christmas_event_id")
      .eq("id", person.id)
      .maybeSingle();
    if (recipient.error || !recipient.data) {
      setError("This Christmas recipient could not be loaded.");
      setLoading(false);
      return;
    }

    const [contributors, amounts, purchases] = await Promise.all([
      db
        .from("contributors")
        .select("id,person_id")
        .eq("christmas_event_id", recipient.data.christmas_event_id)
        .eq("active", true),
      db
        .from("recipient_contributions")
        .select("contributor_id,planned_amount_pennies")
        .eq("christmas_recipient_id", person.id),
      db
        .from("purchases")
        .select("id")
        .eq("christmas_recipient_id", person.id)
        .is("deleted_at", null),
    ]);
    if (contributors.error || amounts.error || purchases.error) {
      setError("Contributor spending could not be loaded. Check your connection and try again.");
      setLoading(false);
      return;
    }

    const purchaseIds = purchases.data.map((purchase) => purchase.id);
    const responsibilityResult = purchaseIds.length
      ? await db
        .from("purchase_allocations")
        .select("contributor_id,responsibility_pennies")
        .in("purchase_id", purchaseIds)
      : { data: [], error: null };
    if (responsibilityResult.error) {
      setError("Contributor purchase responsibilities could not be loaded.");
      setLoading(false);
      return;
    }

    const linkedPeople = contributors.data.length
      ? await db.from("people").select("id,name").in("id", contributors.data.map((item) => item.person_id))
      : { data: [], error: null };
    if (linkedPeople.error) {
      setError("Contributor names could not be loaded.");
      setLoading(false);
      return;
    }

    const names = new Map(linkedPeople.data.map((item) => [item.id, item.name]));
    const values = new Map(amounts.data.map((item) => [item.contributor_id, item.planned_amount_pennies]));
    const spent = new Map<string, number>();
    for (const allocation of responsibilityResult.data) {
      spent.set(
        allocation.contributor_id,
        (spent.get(allocation.contributor_id) ?? 0) + allocation.responsibility_pennies,
      );
    }
    const mapped: Contribution[] = [];
    for (const contributor of contributors.data) {
      const contributorName = names.get(contributor.person_id);
      if (!contributorName) {
        setError("A contributor is not linked to a readable family person.");
        setLoading(false);
        return;
      }
      const amountPennies = values.get(contributor.id) ?? 0;
      mapped.push({
        contributorId: contributor.id,
        name: contributorName,
        amountPennies,
        spentPennies: spent.get(contributor.id) ?? 0,
      });
    }
    mapped.sort((left, right) => left.name.localeCompare(right.name, "en-GB") || left.contributorId.localeCompare(right.contributorId));
    setRows(mapped);
    setContributionsLoaded(true);
    setLoading(false);
  }, [person.id]);

  const handleIdeaCountChange = useCallback(
    (count: number) => setIdeaCount(person.id, count),
    [person.id, setIdeaCount],
  );

  const handlePurchaseMetricsChange = useCallback(
    (spentPennies: number, count: number) => {
      setPurchaseMetrics(person.id, spentPennies, count);
      void loadContributions();
    },
    [loadContributions, person.id, setPurchaseMetrics],
  );

  useEffect(() => {
    const loadHandle = window.setTimeout(() => void loadContributions(), 0);
<<<<<<< HEAD
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(loadHandle);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [loadContributions, onClose]);
=======
    return () => window.clearTimeout(loadHandle);
  }, [loadContributions]);
>>>>>>> 7534a2d (redesign and realtime)

  const saveContributors = async (allocations: RecipientAllocation[]) => {
    setSaving(true);
    try {
      await saveRecipient({
        id: person.id,
        name: person.name,
        budgetPennies: person.budgetPennies,
        allocations,
      });
    } catch {
      setError("Contributor changes could not be saved. Existing allocations were kept.");
      setSaving(false);
      return;
    }
    setSaving(false);
    setMode("view");
    await loadContributions();
  };

  const savePerson = async (allocations: RecipientAllocation[]) => {
    const validName = validateRequiredText(name, { field: "a name", maxLength: INPUT_LIMITS.name });
    if (!validName.ok) { setError(validName.error); return; }
    const parsedBudget = parseMoneyToPennies(budget, { field: "a Christmas budget" });
    if (!parsedBudget.ok || parsedBudget.value === null) { setError(parsedBudget.ok ? "Enter a Christmas budget." : parsedBudget.error); return; }
    setSaving(true);
    try {
      await saveRecipient({
        id: person.id,
        name: validName.value,
        budgetPennies: parsedBudget.value,
        allocations,
      });
      setMode("view");
      setError(null);
      await loadContributions();
    } catch {
      setError("The person could not be updated.");
    }
    setSaving(false);
  };

  const remove = async () => {
<<<<<<< HEAD
    if (!window.confirm(`Remove ${person.name} from Christmas 2026?\n\nThey will no longer appear in the active Christmas list or budget. You can restore them later.`)) return;
=======
    setRemoving(true);
>>>>>>> 7534a2d (redesign and realtime)
    try {
      await archive(person.id);
      onClose();
    } catch {
      setError("Only Global Admin can remove someone from Christmas.");
<<<<<<< HEAD
    }
=======
      setConfirmingRemove(false);
    }
    setRemoving(false);
>>>>>>> 7534a2d (redesign and realtime)
  };
  const parsedBudgetForView = parseMoneyToPennies(budget);
  const budgetPenniesForView = parsedBudgetForView.ok && parsedBudgetForView.value !== null
    ? parsedBudgetForView.value
    : person.budgetPennies;

  return (
<<<<<<< HEAD
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-[#092d27]/60 p-0 backdrop-blur-[2px] sm:items-center sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="person-dialog-title" tabIndex={-1} className="max-h-[96vh] min-h-[85vh] w-full overflow-y-auto rounded-t-3xl border-t-4 border-[#c5a65a] bg-[#f7f6f1] p-5 outline-none shadow-2xl sm:min-h-0 sm:max-w-3xl sm:rounded-3xl sm:border sm:border-t-4 sm:p-8 lg:max-w-5xl">
        <header className="sticky top-0 z-20 -mx-5 -mt-5 flex items-start justify-between gap-4 border-b border-[#e3e1d8] bg-[#f7f6f1]/95 px-5 py-5 backdrop-blur sm:-mx-8 sm:-mt-8 sm:px-8 sm:py-6">
          <div>
            <p className="text-sm font-semibold text-[#a64235]">Christmas 2026</p>
            <h2 id="person-dialog-title" className="mt-1 text-3xl font-bold">{name}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close person details" className="flex h-12 min-w-12 items-center justify-center rounded-full border border-[#d8d8cf] bg-white px-4 text-sm font-bold text-[#174f45] shadow-sm">Close</button>
        </header>

        {error && <p className="mt-4 rounded-xl bg-[#f7e7df] p-3 text-sm text-[#a5543f]">{error}</p>}
=======
    <Modal labelledBy="person-dialog-title" onClose={onClose} size="xl" dismissible={!confirmingRemove} className="min-h-[88dvh] sm:min-h-0">
      <ModalHeader
        id="person-dialog-title"
        eyebrow="Christmas 2026"
        title={name}
        onClose={onClose}
        closeLabel="Close person details"
        sticky
      />
      <div className="px-5 pb-6 sm:px-7 sm:pb-8">
        {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
>>>>>>> 7534a2d (redesign and realtime)

        {mode === "view" && (
          <DetailView
            person={person}
            name={name}
            budgetPennies={budgetPenniesForView}
            rows={rows}
            loading={loading}
            contributionsLoaded={contributionsLoaded}
            isAdmin={isAdmin}
            onIdeaCountChange={handleIdeaCountChange}
            onPurchaseMetricsChange={handlePurchaseMetricsChange}
            editContributors={() => { setMode("contributors"); setError(null); }}
            editPerson={() => { setMode("person"); setError(null); }}
<<<<<<< HEAD
            remove={() => void remove()}
=======
            remove={() => setConfirmingRemove(true)}
>>>>>>> 7534a2d (redesign and realtime)
          />
        )}
        {mode === "person" && (
          <PersonEditor
            name={name}
            budget={budget}
            rows={rows}
            saving={saving}
            setName={setName}
            setBudget={setBudget}
            cancel={() => { setName(person.name); setBudget(priceInput(person.budgetPennies)); setMode("view"); setError(null); }}
            save={(allocations) => void savePerson(allocations)}
          />
        )}
        {mode === "contributors" && (
          <ContributionEditor
            personName={name}
            budgetPennies={budgetPenniesForView}
            rows={rows}
            saving={saving}
            cancel={() => { setMode("view"); setError(null); }}
            save={(allocations) => void saveContributors(allocations)}
          />
        )}
      </div>
<<<<<<< HEAD
    </div>
=======

      {confirmingRemove && (
        <ConfirmDialog
          title={`Remove ${person.name} from Christmas 2026?`}
          body="They will no longer appear in the active Christmas list or budget. You can restore them later."
          confirmLabel="Remove person"
          busyLabel="Removing..."
          busy={removing}
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={() => void remove()}
        />
      )}
    </Modal>
>>>>>>> 7534a2d (redesign and realtime)
  );
}

function DetailView({
  person,
  name,
  budgetPennies,
  rows,
  loading,
  contributionsLoaded,
  isAdmin,
  onIdeaCountChange,
  onPurchaseMetricsChange,
  editContributors,
  editPerson,
  remove,
}: {
  person: Person;
  name: string;
  budgetPennies: number;
  rows: Contribution[];
  loading: boolean;
  contributionsLoaded: boolean;
  isAdmin: boolean;
  onIdeaCountChange: (count: number) => void;
  onPurchaseMetricsChange: (spentPennies: number, count: number) => void;
  editContributors: () => void;
  editPerson: () => void;
  remove: () => void;
}) {
  const spentPennies = person.spentPennies;
  const status = spentPennies === null
    ? null
    : purchaseProgressStatus(spentPennies, budgetPennies);
  const remainingPennies = spentPennies === null ? null : budgetPennies - spentPennies;
  const presentation = status ? progressPresentation(status) : null;
  const contributingRows = rows.filter((row) => row.amountPennies > 0);
  return (
    <>
<<<<<<< HEAD
      <div className="mt-6 grid grid-cols-3 gap-3 rounded-2xl border border-[#2c655a] bg-[#123f37] p-4 text-white shadow-sm sm:p-5">
        <Metric label="Budget" valuePennies={budgetPennies} />
        <Metric label="Spent" valuePennies={person.spentPennies} />
        <Metric label={remainingPennies !== null && remainingPennies < 0 ? "Over budget" : "Remaining"} valuePennies={remainingPennies === null ? null : Math.abs(remainingPennies)} warning={remainingPennies !== null && remainingPennies < 0} />
      </div>
      <div className="mt-3 rounded-2xl border border-[#e0e1d8] bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={`rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wide ${presentation?.badge ?? "border-[#dfe4e1] bg-[#f5f7f6] text-[#6f7c77]"}`}>{presentation?.label ?? "Unavailable"}</span>
          {remainingPennies !== null && remainingPennies < 0 && <strong className="rounded-lg bg-[#fff0ec] px-3 py-1.5 text-sm text-[#aa3f32]">{formatPennies(Math.abs(remainingPennies))} over budget</strong>}
        </div>
        {spentPennies === null
          ? <p className="mt-3 text-xs font-semibold text-[#7b8581]">Budget progress unavailable</p>
          : <FinancialProgressBar actualPennies={spentPennies} plannedPennies={budgetPennies} mode="budget" />}
      </div>

      <div className="mt-6 space-y-5">
        <section className="rounded-2xl border border-[#e3e1d8] bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#a64235]">Shared budget</p><h3 className="mt-1 text-lg font-bold">Contributors</h3><p className="mt-1 text-xs leading-5 text-[#7b8581]">Spent is each contributor&apos;s responsibility for purchases made for {name}.</p></div>
            <button type="button" onClick={editContributors} disabled={!contributionsLoaded} className="min-h-12 w-full rounded-xl border border-[#bfd1cb] bg-[#edf5f2] px-4 text-sm font-bold text-[#174f45] disabled:opacity-50 sm:w-auto">Edit contributors</button>
          </div>
          {loading ? (
            <p className="mt-4 text-sm text-[#89938f]">Loading contributors...</p>
          ) : contributingRows.length === 0 ? (
            <p className="mt-4 text-sm text-[#89938f]">No contributors are currently sharing this budget.</p>
=======
      <div className="dark mt-5 overflow-hidden rounded-2xl border border-pine-700 bg-linear-to-br from-pine-900 to-pine-800 text-white shadow-card">
        <div className="grid grid-cols-3 gap-3 p-5 sm:gap-5 sm:p-6">
          <Metric label="Budget" valuePennies={budgetPennies} />
          <Metric label="Spent" valuePennies={person.spentPennies} />
          <Metric label={remainingPennies !== null && remainingPennies < 0 ? "Over budget" : "Remaining"} valuePennies={remainingPennies === null ? null : Math.abs(remainingPennies)} warning={remainingPennies !== null && remainingPennies < 0} />
        </div>
        <div className="border-t border-line bg-pine-950/30 px-5 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {presentation
              ? <Badge tone={presentation.tone}>{presentation.label}</Badge>
              : <Badge tone="neutral">Unavailable</Badge>}
            {remainingPennies !== null && remainingPennies < 0 && (
              <strong className="text-sm font-semibold tabular-nums text-berry">{formatPennies(Math.abs(remainingPennies))} over budget</strong>
            )}
          </div>
          {spentPennies === null
            ? <p className="mt-2 text-xs font-medium text-pine-100">Budget progress unavailable</p>
            : <FinancialProgressBar actualPennies={spentPennies} plannedPennies={budgetPennies} mode="budget" />}
        </div>
      </div>

      <div className="mt-5 space-y-5">
        <section className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-gold">Shared budget</p>
              <h3 className="mt-1 font-display text-lg font-semibold">Contributors</h3>
              <p className="mt-1 text-xs leading-5 text-ink-600">Spent is each contributor&apos;s responsibility for purchases made for {name}.</p>
            </div>
            <Button variant="tonal" onClick={editContributors} disabled={!contributionsLoaded} className="w-full sm:w-auto">Edit contributors</Button>
          </div>
          {loading ? (
            <p className="mt-4 text-sm text-ink-600">Loading contributors...</p>
          ) : contributingRows.length === 0 ? (
            <p className="mt-4 text-sm text-ink-600">No contributors are currently sharing this budget.</p>
>>>>>>> 7534a2d (redesign and realtime)
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {contributingRows.map((row) => {
                const remaining = row.amountPennies - row.spentPennies;
                return (
<<<<<<< HEAD
                  <article key={row.contributorId} className={`min-w-0 rounded-xl border p-4 ${remaining < 0 ? "border-[#e3a79e] bg-[#fff3f0]" : "border-[#e5e4dc] bg-[#faf9f5]"}`}>
                    <h4 className="break-words font-bold">{row.name}</h4>
                    <dl className="mt-4 grid min-w-0 grid-cols-3 gap-3">
                      <div className="min-w-0"><dt className="text-[10px] font-bold uppercase tracking-wide text-[#7d8581]">Planned</dt><dd className="mt-1 break-words font-bold tabular-nums text-[#28685c]">{formatPennies(row.amountPennies)}</dd></div>
                      <div className="min-w-0"><dt className="text-[10px] font-bold uppercase tracking-wide text-[#7d8581]">Spent</dt><dd className="mt-1 break-words font-bold tabular-nums">{formatPennies(row.spentPennies)}</dd></div>
                      <div className="min-w-0"><dt className="text-[10px] font-bold uppercase tracking-wide text-[#7d8581]">{remaining < 0 ? "Over plan" : "Remaining"}</dt><dd className={`mt-1 break-words font-bold tabular-nums ${remaining < 0 ? "text-[#a63f33]" : ""}`}>{formatPennies(Math.abs(remaining))}</dd></div>
=======
                  <article key={row.contributorId} className={cx("min-w-0 rounded-xl border p-4", remaining < 0 ? "border-berry-soft-border bg-berry-soft" : "border-line bg-surface-2")}>
                    <h4 className="break-words font-semibold">{row.name}</h4>
                    <dl className="mt-3 grid min-w-0 grid-cols-3 gap-3">
                      <div className="min-w-0"><dt className="text-xs font-medium text-ink-600">Planned</dt><dd className="mt-1 font-semibold tabular-nums break-words text-accent">{formatPennies(row.amountPennies)}</dd></div>
                      <div className="min-w-0"><dt className="text-xs font-medium text-ink-600">Spent</dt><dd className="mt-1 break-words font-semibold tabular-nums">{formatPennies(row.spentPennies)}</dd></div>
                      <div className="min-w-0"><dt className="text-xs font-medium text-ink-600">{remaining < 0 ? "Over plan" : "Remaining"}</dt><dd className={cx("mt-1 break-words font-semibold tabular-nums", remaining < 0 && "text-berry")}>{formatPennies(Math.abs(remaining))}</dd></div>
>>>>>>> 7534a2d (redesign and realtime)
                    </dl>
                    <FinancialProgressBar actualPennies={row.spentPennies} plannedPennies={row.amountPennies} mode="plan" showDifference={false} />
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <GiftIdeas recipientId={person.id} recipientName={name} onCountChange={onIdeaCountChange} />

        <Purchases recipientId={person.id} onMetricsChange={onPurchaseMetricsChange} />
      </div>

      {isAdmin && (
<<<<<<< HEAD
        <section className="mt-6 border-t pt-5">
          <h3 className="text-sm font-bold uppercase tracking-wider text-[#7b8581]">Management</h3>
          <div className="mt-3 grid gap-3 sm:flex sm:flex-wrap">
            <button type="button" onClick={editPerson} disabled={!contributionsLoaded} className="min-h-12 rounded-xl border bg-white px-4 text-sm font-bold disabled:opacity-50">Edit person</button>
            <button type="button" onClick={remove} className="min-h-12 rounded-xl border border-[#efd2cb] bg-[#fff7f4] px-4 text-sm font-bold text-[#a64235]">Remove from Christmas</button>
=======
        <section className="mt-6 border-t border-line pt-5">
          <h3 className="text-sm font-semibold text-ink-600">Management</h3>
          <div className="mt-3 grid gap-3 sm:flex sm:flex-wrap">
            <Button variant="secondary" onClick={editPerson} disabled={!contributionsLoaded}>Edit person</Button>
            <Button variant="dangerGhost" onClick={remove} className="border border-berry-soft-border bg-surface">Remove from Christmas</Button>
>>>>>>> 7534a2d (redesign and realtime)
          </div>
        </section>
      )}
    </>
  );
}

function PersonEditor({ name, budget, rows, saving, setName, setBudget, cancel, save }: { name: string; budget: string; rows: Contribution[]; saving: boolean; setName: (value: string) => void; setBudget: (value: string) => void; cancel: () => void; save: (allocations: RecipientAllocation[]) => void }) {
  const [allocationRows, setAllocationRows] = useState(() => createRecipientAllocationDraftRows(rows));
  const parsedBudget = parseMoneyToPennies(budget, { field: "a Christmas budget" });
  const budgetPennies = parsedBudget.ok ? parsedBudget.value : null;
  const parsedDraft = parseRecipientAllocationDraft(allocationRows);
  const validPlan = budgetPennies !== null && parsedDraft.ok
    ? validateRecipientAllocationSnapshot(budgetPennies, parsedDraft.value)
    : null;

  return (
<<<<<<< HEAD
    <section className="mt-7 rounded-2xl border border-[#e3e1d8] bg-white p-5 shadow-sm">
      <h3 className="text-lg font-bold">Edit person</h3>
      <label className="mt-5 block text-sm font-semibold">Name<input required maxLength={INPUT_LIMITS.name} value={name} onChange={(event) => setName(event.target.value)} className="mt-2 h-12 w-full rounded-xl border px-3" /></label>
      <label className="mt-4 block text-sm font-semibold">Christmas budget<input maxLength={INPUT_LIMITS.money} value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" className="mt-2 h-12 w-full rounded-xl border px-3" /></label>
      <div className="mt-6 border-t border-[#e5e4dc] pt-5">
        <h4 className="font-bold">Contributors</h4>
        <p className="mt-1 text-sm text-[#7b8581]">Changing the budget does not alter a custom split. Adjust it manually or choose Split equally.</p>
=======
    <section className="mt-5 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <h3 className="font-display text-lg font-semibold">Edit person</h3>
      <Field label="Name" className="mt-5" required>
        <Input required maxLength={INPUT_LIMITS.name} value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Christmas budget" className="mt-4">
        <MoneyInput maxLength={INPUT_LIMITS.money} value={budget} onValueChange={setBudget} />
      </Field>
      <div className="mt-6 border-t border-line pt-5">
        <h4 className="font-display text-lg font-semibold">Contributors</h4>
        <p className="mt-1 text-sm text-ink-600">Changing the budget does not alter a custom split. Adjust it manually or choose Split equally.</p>
>>>>>>> 7534a2d (redesign and realtime)
        <RecipientAllocationEditor idPrefix="edit-person-contributor" budgetPennies={budgetPennies} rows={allocationRows} onChange={setAllocationRows} showSpending />
      </div>
      <Actions cancel={cancel} save={() => { if (validPlan?.ok) save(validPlan.value); }} saving={saving} saveDisabled={validPlan?.ok !== true} />
    </section>
  );
}

function ContributionEditor({ personName, budgetPennies, rows, saving, cancel, save }: { personName: string; budgetPennies: number; rows: Contribution[]; saving: boolean; cancel: () => void; save: (allocations: RecipientAllocation[]) => void }) {
  const [allocationRows, setAllocationRows] = useState(() => createRecipientAllocationDraftRows(rows));
  const parsedDraft = parseRecipientAllocationDraft(allocationRows);
  const validPlan = parsedDraft.ok
    ? validateRecipientAllocationSnapshot(budgetPennies, parsedDraft.value)
    : null;

  return (
<<<<<<< HEAD
    <section className="mt-7">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#a64235]">Contributor plan</p>
      <h3 className="mt-1 text-xl font-bold">Who contributes towards {personName}?</h3>
      <p className="mt-1 text-sm text-[#7b8581]">Budget {formatPennies(budgetPennies)} · Existing purchase responsibilities stay unchanged</p>
=======
    <section className="mt-5">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-gold">Contributor plan</p>
      <h3 className="mt-1 font-display text-xl font-semibold">Who contributes towards {personName}?</h3>
      <p className="mt-1 text-sm text-ink-600">Budget {formatPennies(budgetPennies)} · Existing purchase responsibilities stay unchanged</p>
>>>>>>> 7534a2d (redesign and realtime)
      <RecipientAllocationEditor idPrefix="edit-contributors" budgetPennies={budgetPennies} rows={allocationRows} onChange={setAllocationRows} showSpending />
      <Actions cancel={cancel} save={() => { if (validPlan?.ok) save(validPlan.value); }} saving={saving} saveDisabled={validPlan?.ok !== true} />
    </section>
  );
}

function Metric({ label, valuePennies, warning = false }: { label: string; valuePennies: number | null; warning?: boolean }) {
<<<<<<< HEAD
  return <div className="min-w-0"><p className="truncate text-[11px] text-[#d5e3df] sm:text-xs">{label}</p><p className={`mt-1 truncate text-base font-bold sm:text-lg ${warning ? "text-[#ffb4a8]" : ""}`}>{valuePennies === null ? "—" : formatPennies(valuePennies)}</p></div>;
=======
  return (
    <div className="min-w-0">
      <p className="truncate text-xs font-medium text-pine-100 sm:text-sm">{label}</p>
      <p className={cx("mt-1 truncate font-display text-lg font-semibold tabular-nums sm:text-2xl", warning && "text-berry")}>{valuePennies === null ? "—" : formatPennies(valuePennies)}</p>
    </div>
  );
>>>>>>> 7534a2d (redesign and realtime)
}

function priceInput(pennies: number) {
  return (pennies / 100).toFixed(2).replace(/\.00$/u, "");
}

<<<<<<< HEAD
function progressPresentation(status: PurchaseProgressStatus) {
  if (status === "not_started") return { label: "Not started", badge: "border-[#edb5ad] bg-[#fff0ed] text-[#a63f33]" };
  if (status === "in_progress") return { label: "In progress", badge: "border-[#e8d08b] bg-[#fff6d8] text-[#745909]" };
  if (status === "over_budget") return { label: "Over budget", badge: "border-[#e3a79e] bg-[#fff0ed] text-[#a63f33]" };
  return { label: "Budget reached", badge: "border-[#abd0c2] bg-[#e8f5f0] text-[#17624f]" };
}

function Actions({ cancel, save, saving, saveDisabled = false }: { cancel: () => void; save: () => void; saving: boolean; saveDisabled?: boolean }) {
  return <div className="sticky bottom-0 z-10 -mx-5 mt-6 grid grid-cols-2 gap-3 border-t border-[#e1e1d9] bg-[#f7f6f1]/95 px-5 py-4 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0"><button type="button" onClick={cancel} disabled={saving} className="min-h-12 rounded-xl border bg-white py-3 font-semibold disabled:opacity-50">Cancel</button><button type="button" disabled={saving || saveDisabled} onClick={save} className="min-h-12 rounded-xl bg-[#174f45] py-3 font-semibold text-white shadow-sm disabled:opacity-50">{saving ? "Saving..." : "Save"}</button></div>;
=======
function progressPresentation(status: PurchaseProgressStatus): { label: string; tone: BadgeTone } {
  if (status === "not_started") return { label: "Not started", tone: "neutral" };
  if (status === "in_progress") return { label: "In progress", tone: "warning" };
  if (status === "over_budget") return { label: "Over budget", tone: "danger" };
  return { label: "Budget reached", tone: "success" };
}

function Actions({ cancel, save, saving, saveDisabled = false }: { cancel: () => void; save: () => void; saving: boolean; saveDisabled?: boolean }) {
  return (
    <ModalFooter className="-mx-5 sm:-mx-7">
      <Button variant="secondary" size="lg" onClick={cancel} disabled={saving}>Cancel</Button>
      <Button size="lg" disabled={saving || saveDisabled} onClick={save}>{saving ? "Saving..." : "Save"}</Button>
    </ModalFooter>
  );
>>>>>>> 7534a2d (redesign and realtime)
}
