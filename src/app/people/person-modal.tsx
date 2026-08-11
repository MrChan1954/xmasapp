"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "../../../utils/supabase/client";
import { formatPennies } from "../../lib/currency";
import { INPUT_LIMITS, parseMoneyToPennies, validateRequiredText } from "../../lib/input-validation";
import { validateRecipientAllocationSnapshot, type RecipientAllocation } from "../../lib/recipient-allocations";
import { purchaseProgressStatus, type PurchaseProgressStatus } from "../../lib/purchases";
import { useFamily, type Person } from "../family-context";
import { FinancialProgressBar } from "../components/financial-progress";
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
  const [rows, setRows] = useState<Contribution[]>([]);
  const [mode, setMode] = useState<"view" | "contributors" | "person">("view");
  const [loading, setLoading] = useState(true);
  const [contributionsLoaded, setContributionsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(person.name);
  const [budget, setBudget] = useState(priceInput(person.budgetPennies));
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

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
    return () => window.clearTimeout(loadHandle);
  }, [loadContributions]);

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
    setRemoving(true);
    try {
      await archive(person.id);
      onClose();
    } catch {
      setError("Only Global Admin can remove someone from Christmas.");
      setConfirmingRemove(false);
    }
    setRemoving(false);
  };
  const parsedBudgetForView = parseMoneyToPennies(budget);
  const budgetPenniesForView = parsedBudgetForView.ok && parsedBudgetForView.value !== null
    ? parsedBudgetForView.value
    : person.budgetPennies;

  return (
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
            remove={() => setConfirmingRemove(true)}
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
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {contributingRows.map((row) => {
                const remaining = row.amountPennies - row.spentPennies;
                return (
                  <article key={row.contributorId} className={cx("min-w-0 rounded-xl border p-4", remaining < 0 ? "border-berry-soft-border bg-berry-soft" : "border-line bg-surface-2")}>
                    <h4 className="break-words font-semibold">{row.name}</h4>
                    <dl className="mt-3 grid min-w-0 grid-cols-3 gap-3">
                      <div className="min-w-0"><dt className="text-xs font-medium text-ink-600">Planned</dt><dd className="mt-1 font-semibold tabular-nums break-words text-accent">{formatPennies(row.amountPennies)}</dd></div>
                      <div className="min-w-0"><dt className="text-xs font-medium text-ink-600">Spent</dt><dd className="mt-1 break-words font-semibold tabular-nums">{formatPennies(row.spentPennies)}</dd></div>
                      <div className="min-w-0"><dt className="text-xs font-medium text-ink-600">{remaining < 0 ? "Over plan" : "Remaining"}</dt><dd className={cx("mt-1 break-words font-semibold tabular-nums", remaining < 0 && "text-berry")}>{formatPennies(Math.abs(remaining))}</dd></div>
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
        <section className="mt-6 border-t border-line pt-5">
          <h3 className="text-sm font-semibold text-ink-600">Management</h3>
          <div className="mt-3 grid gap-3 sm:flex sm:flex-wrap">
            <Button variant="secondary" onClick={editPerson} disabled={!contributionsLoaded}>Edit person</Button>
            <Button variant="dangerGhost" onClick={remove} className="border border-berry-soft-border bg-surface">Remove from Christmas</Button>
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
    <section className="mt-5">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-gold">Contributor plan</p>
      <h3 className="mt-1 font-display text-xl font-semibold">Who contributes towards {personName}?</h3>
      <p className="mt-1 text-sm text-ink-600">Budget {formatPennies(budgetPennies)} · Existing purchase responsibilities stay unchanged</p>
      <RecipientAllocationEditor idPrefix="edit-contributors" budgetPennies={budgetPennies} rows={allocationRows} onChange={setAllocationRows} showSpending />
      <Actions cancel={cancel} save={() => { if (validPlan?.ok) save(validPlan.value); }} saving={saving} saveDisabled={validPlan?.ok !== true} />
    </section>
  );
}

function Metric({ label, valuePennies, warning = false }: { label: string; valuePennies: number | null; warning?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs font-medium text-pine-100 sm:text-sm">{label}</p>
      <p className={cx("mt-1 truncate font-display text-lg font-semibold tabular-nums sm:text-2xl", warning && "text-berry")}>{valuePennies === null ? "—" : formatPennies(valuePennies)}</p>
    </div>
  );
}

function priceInput(pennies: number) {
  return (pennies / 100).toFixed(2).replace(/\.00$/u, "");
}

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
}
