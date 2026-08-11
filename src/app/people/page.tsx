"use client";

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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
import { AppShell, PageHeader } from "../components/app-shell";
import { CompleteRibbon } from "../components/festive/celebration";
import { FinancialProgressBar } from "../components/financial-progress";
import { IconChevronRight, IconGift, IconPlus, IconSearch, IconSparkle } from "../components/icons";
import {
  Badge,
  Button,
  ChipRow,
  EmptyState,
  Field,
  FilterChip,
  Input,
  Modal,
  ModalFooter,
  ModalHeader,
  MoneyInput,
  Notice,
  Toolbar,
  cx,
  type BadgeTone,
} from "../components/ui";
import { useFamily, useTotals, type Person } from "../family-context";
import { PersonModal } from "./person-modal";
import {
  parseRecipientAllocationDraft,
  RecipientAllocationEditor,
  type RecipientAllocationDraftRow,
} from "./recipient-allocation-editor";

const filters = ["All", "Not started", "In progress", "Budget reached", "Over budget", "Has ideas"];

export default function PeoplePage() {
  return (
    <Suspense fallback={null}>
      <PeopleView />
    </Suspense>
  );
}

function PeopleView() {
  const { people, saveRecipient, restore, loading, error, isAdmin } = useFamily();
  const { budgetPennies } = useTotals();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  // Deep link: /people?person=<id> (where /people/[id] now redirects) opens
  // that person straight away.
  const [selectedId, setSelectedId] = useState<string | null>(useSearchParams().get("person"));
  const [adding, setAdding] = useState(false);

  const closePerson = () => {
    setSelectedId(null);
    if (window.location.search.includes("person=")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  };

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
  // Chip counts reflect the current search, so the numbers always match what
  // choosing that filter would actually show.
  const counts = useMemo(() => {
    const searched = people.filter((person) => person.active && person.name.toLowerCase().includes(query.toLowerCase()));
    const result: Record<string, number> = Object.fromEntries(filters.map((item) => [item, 0]));
    result.All = searched.length;
    for (const person of searched) {
      if ((person.ideaCount ?? 0) > 0) result["Has ideas"] += 1;
      if (person.spentPennies === null) continue;
      result[statusFilterLabel(purchaseProgressStatus(person.spentPennies, person.budgetPennies))] += 1;
    }
    return result;
  }, [people, query]);

  const archived = people.filter((person) => !person.active);
  const selected = selectedId ? people.find((person) => person.id === selectedId) ?? null : null;

  return (
    <AppShell>
      {error && <Notice tone="danger" className="mb-5">{error}</Notice>}

      <PageHeader
        title="People"
        description={`${visible.length} ${visible.length === 1 ? "person" : "people"} · ${formatPennies(budgetPennies)} total budget`}
        actions={isAdmin ? (
          <Button size="lg" onClick={() => setAdding(true)} className="w-full sm:w-auto">
            <IconPlus size={18} />
            Add person
          </Button>
        ) : undefined}
      />

      <Toolbar
        className="mt-6"
        start={
          <label className="relative block w-full sm:w-72">
            <span className="sr-only">Search people</span>
            <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-400"><IconSearch size={18} /></span>
            <Input
              maxLength={INPUT_LIMITS.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search people"
              className="h-11 pl-10"
            />
          </label>
        }
      />

      <ChipRow label="Filter people" className="mt-4">
        {filters.map((item) => (
          <FilterChip
            key={item}
            active={filter === item}
            count={counts[item]}
            onClick={() => setFilter(item)}
          >
            {item}
          </FilterChip>
        ))}
      </ChipRow>

      {loading ? (
        <p className="mt-8 text-sm font-medium text-ink-600">Loading people...</p>
      ) : visible.length > 0 ? (
        <div className="mt-7 grid gap-5 md:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3">
          {visible.map((person) => <PersonCard key={person.id} person={person} onClick={() => setSelectedId(person.id)} />)}
        </div>
      ) : (
        <EmptyState
          className="mt-7"
          illustration="wreath"
          title="No people match this filter"
          body="Try All, or clear the search."
        />
      )}

      {isAdmin && archived.length > 0 && (
        <details className="group mt-12 rounded-2xl border border-line bg-surface px-5 shadow-card sm:px-6">
          <summary className="flex list-none items-center justify-between gap-4 py-4 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">
              <span className="block font-display text-lg font-semibold">Removed people</span>
              <span className="mt-0.5 block text-sm text-ink-600">
                {archived.length} archived · only Global Admin can restore them
              </span>
            </span>
            <IconChevronRight size={20} className="shrink-0 text-ink-400 transition group-open:rotate-90" />
          </summary>
          <div className="divide-y divide-line border-t border-line pb-2">
            {archived.map((person) => (
              <div key={person.id} className="flex items-center justify-between gap-4 py-3.5">
                <span className="min-w-0 break-words font-semibold">{person.name}</span>
                <Button variant="tonal" onClick={() => void restore(person.id).catch(() => undefined)}>Restore</Button>
              </div>
            ))}
          </div>
        </details>
      )}

      {selected && <PersonModal person={selected} onClose={closePerson} />}
      {isAdmin && adding && <AddForm onCancel={() => setAdding(false)} onSave={async (name, budget, allocations) => { await saveRecipient({ name, budgetPennies: budget, allocations }); setAdding(false); }} />}
    </AppShell>
  );
}

function PersonCard({ person, onClick }: { person: Person; onClick: () => void }) {
  const status = person.spentPennies === null
    ? null
    : purchaseProgressStatus(person.spentPennies, person.budgetPennies);
  const presentation = status ? progressPresentation(status) : null;

  const complete = status === "budget_reached";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "group relative overflow-hidden rounded-2xl border bg-surface p-5 text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-lift active:scale-[0.99] sm:p-6",
        status === "over_budget" ? "border-berry-soft-border" : complete ? "border-accent-soft-border" : "border-line",
      )}
    >
      {complete && <CompleteRibbon />}

      <div className="flex items-center justify-between gap-3">
        <h2 className={cx("min-w-0 truncate font-display text-2xl font-semibold", complete && "pr-24")}>{person.name}</h2>
        {!complete && (presentation
          ? <Badge tone={presentation.tone}>{presentation.label}</Badge>
          : <Badge tone="neutral">Unavailable</Badge>)}
      </div>

      <p className="mt-4 font-display text-3xl font-semibold tabular-nums text-ink-900">
        {person.spentPennies === null ? "—" : formatPennies(person.spentPennies)}
      </p>
      <p className="mt-1 text-sm text-ink-600">
        {person.spentPennies === null ? "Spending unavailable · " : "spent of "}
        <span className="font-semibold tabular-nums text-ink-700">{formatPennies(person.budgetPennies)}</span> budget
      </p>

      <div className="mt-4 border-t border-line pt-1">
        {person.spentPennies === null
          ? <p className="mt-3 text-xs font-medium text-ink-600">Budget progress unavailable</p>
          : <FinancialProgressBar actualPennies={person.spentPennies} plannedPennies={person.budgetPennies} mode="budget" />}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-600">
        <span className="flex items-center gap-2">
          <IconGift size={16} className="shrink-0 text-accent" />
          {person.giftCount === null ? "Purchases unavailable" : `${person.giftCount} ${person.giftCount === 1 ? "gift" : "gifts"}`}
        </span>
        <span className="flex items-center gap-2">
          <IconSparkle size={16} className="shrink-0 text-gold" />
          {person.ideaCount === null ? "Ideas unavailable" : `${person.ideaCount} ${person.ideaCount === 1 ? "idea" : "ideas"}`}
        </span>
      </div>
    </button>
  );
}

function statusFilterLabel(status: PurchaseProgressStatus) {
  return status === "not_started" ? "Not started" : status === "in_progress" ? "In progress" : status === "budget_reached" ? "Budget reached" : "Over budget";
}

function progressPresentation(status: PurchaseProgressStatus): { label: string; tone: BadgeTone } {
  if (status === "not_started") return { label: "Not started", tone: "neutral" };
  if (status === "in_progress") return { label: "In progress", tone: "warning" };
  if (status === "over_budget") return { label: "Over budget", tone: "danger" };
  return { label: "Budget reached", tone: "success" };
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
    <Modal labelledBy="add-person-title" onClose={onCancel} size="md" dismissible={!saving}>
      <form onSubmit={(event) => void submit(event)}>
        <ModalHeader
          id="add-person-title"
          eyebrow="Christmas 2026"
          title="Add person"
          onClose={onCancel}
          closeLabel="Close add person"
        />
        <div className="px-5 sm:px-7">
          <Field label="Name" required>
            <Input required maxLength={INPUT_LIMITS.name} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Christmas budget" className="mt-4">
            <MoneyInput maxLength={INPUT_LIMITS.money} value={budget} onValueChange={setBudget} />
          </Field>
          <div className="mt-6 border-t border-line pt-5">
            <h3 className="font-display text-lg font-semibold">Who contributes?</h3>
            <p className="mt-1 text-sm text-ink-600">Create a complete plan before adding this person.</p>
            {contributorsLoading ? (
              <p className="mt-4 text-sm text-ink-600">Loading contributors...</p>
            ) : (
              <RecipientAllocationEditor
                idPrefix="add-person-contributor"
                budgetPennies={budgetPennies}
                rows={rows}
                onChange={setRows}
              />
            )}
          </div>
          {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
        </div>
        <ModalFooter>
          <Button variant="secondary" size="lg" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button type="submit" size="lg" disabled={saving || !canSave}>{saving ? "Creating..." : "Create person"}</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
