"use client";

import { useMemo, useState } from "react";
import { formatPennies } from "@/lib/currency";
import {
  INPUT_LIMITS,
  parseMoneyToPennies,
  type ValidationResult,
} from "@/lib/input-validation";
import {
  splitPenniesEqually,
  type RecipientAllocation,
} from "@/lib/recipient-allocations";
<<<<<<< HEAD
=======
import { Button, cx } from "../components/ui";
>>>>>>> 7534a2d (redesign and realtime)

export type RecipientAllocationDraftRow = {
  contributorId: string;
  name: string;
  selected: boolean;
  amountInput: string;
  spentPennies?: number;
};

export function createRecipientAllocationDraftRows(
  rows: readonly {
    contributorId: string;
    name: string;
    amountPennies: number;
    spentPennies?: number;
  }[],
): RecipientAllocationDraftRow[] {
  return rows.map((row) => ({
    contributorId: row.contributorId,
    name: row.name,
    selected: row.amountPennies > 0,
    amountInput: priceInput(row.amountPennies),
    spentPennies: row.spentPennies,
  }));
}

export function parseRecipientAllocationDraft(
  rows: readonly RecipientAllocationDraftRow[],
): ValidationResult<RecipientAllocation[]> {
  const allocations: RecipientAllocation[] = [];
  for (const row of rows) {
    let plannedAmountPennies = 0;
    if (row.selected) {
      const amount = parseMoneyToPennies(row.amountInput, {
        field: `a planned amount for ${row.name}`,
      });
      if (!amount.ok || amount.value === null) {
        return {
          ok: false,
          error: amount.ok ? `Enter a planned amount for ${row.name}.` : amount.error,
        };
      }
      plannedAmountPennies = amount.value;
    }
    allocations.push({ contributorId: row.contributorId, plannedAmountPennies });
  }
  return { ok: true, value: allocations };
}

export function RecipientAllocationEditor({
  idPrefix,
  budgetPennies,
  rows,
  onChange,
  showSpending = false,
}: {
  idPrefix: string;
  budgetPennies: number | null;
  rows: RecipientAllocationDraftRow[];
  onChange: (rows: RecipientAllocationDraftRow[]) => void;
  showSpending?: boolean;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const parsedSnapshot = useMemo(() => parseRecipientAllocationDraft(rows), [rows]);
  const allocatedPennies = parsedSnapshot.ok
    ? parsedSnapshot.value.reduce((total, row) => total + row.plannedAmountPennies, 0)
    : null;

  const splitEqually = () => {
    if (budgetPennies === null) {
      setActionError("Enter a valid Christmas budget before splitting it.");
      return;
    }
    const selectedIds = rows.filter((row) => row.selected).map((row) => row.contributorId);
    if (selectedIds.length === 0) {
      setActionError("Choose at least one contributor first.");
      return;
    }

    const split = splitPenniesEqually(budgetPennies, selectedIds);
    const amounts = new Map(split.map((row) => [row.contributorId, row.plannedAmountPennies]));
    onChange(rows.map((row) => ({
      ...row,
      amountInput: row.selected ? priceInput(amounts.get(row.contributorId) ?? 0) : "0",
    })));
    setActionError(null);
  };

  const allocationMessage = budgetPennies === null
    ? "Enter the budget to check this allocation."
    : !parsedSnapshot.ok
      ? parsedSnapshot.error
      : allocatedPennies === null
        ? "Check the contributor amounts."
      : allocatedPennies < budgetPennies
        ? `${formatPennies(budgetPennies - allocatedPennies)} still needs allocating.`
        : allocatedPennies > budgetPennies
          ? `Allocation exceeds the budget by ${formatPennies(allocatedPennies - budgetPennies)}.`
          : `Allocation total matches the ${formatPennies(budgetPennies)} budget.`;
  const matchesBudget = budgetPennies !== null && allocatedPennies === budgetPennies;

  return (
    <div className="mt-5">
      <div className="space-y-3">
        {rows.length === 0 ? (
<<<<<<< HEAD
          <p className="rounded-xl border border-dashed border-[#d8dbd3] bg-[#faf9f5] p-4 text-sm text-[#7b8581]">
=======
          <p className="rounded-xl border border-dashed border-line-strong bg-surface-2 p-4 text-sm text-ink-600">
>>>>>>> 7534a2d (redesign and realtime)
            No active contributors are available.
          </p>
        ) : rows.map((row) => {
          const amount = row.selected
            ? parseMoneyToPennies(row.amountInput, { field: `a planned amount for ${row.name}` })
            : { ok: true as const, value: 0 };
          const amountPennies = amount.ok ? amount.value : null;
          const checkboxId = `${idPrefix}-${row.contributorId}`;
          return (
<<<<<<< HEAD
            <div key={row.contributorId} className="rounded-xl border border-[#e2e3dc] bg-white p-4">
=======
            <div key={row.contributorId} className={cx("rounded-xl border bg-surface p-4", row.selected ? "border-accent-soft-border" : "border-line")}>
>>>>>>> 7534a2d (redesign and realtime)
              <label htmlFor={checkboxId} className="flex cursor-pointer items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-3">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={row.selected}
                    onChange={() => {
                      onChange(rows.map((item) => item.contributorId === row.contributorId
                        ? {
                            ...item,
                            selected: !item.selected,
                            amountInput: item.selected ? "0" : item.amountInput,
                          }
                        : item));
                      setActionError(null);
                    }}
<<<<<<< HEAD
                    className="h-5 w-5 shrink-0 accent-[#1f5b50]"
                  />
                  <strong className="truncate">{row.name}</strong>
                </span>
                <span className={`shrink-0 ${amountPennies === null ? "text-[#a5543f]" : ""}`}>
=======
                    className="h-5 w-5 shrink-0 rounded accent-mint"
                  />
                  <strong className="truncate font-semibold">{row.name}</strong>
                </span>
                <span className={cx("shrink-0 font-semibold tabular-nums", amountPennies === null && "text-berry")}>
>>>>>>> 7534a2d (redesign and realtime)
                  {amountPennies === null ? "Invalid amount" : formatPennies(amountPennies)}
                </span>
              </label>
              {showSpending && (
<<<<<<< HEAD
                <p className="mt-3 border-t border-[#e7e6df] pt-3 text-xs text-[#747e7a]">
                  Existing purchase responsibility <strong className="text-[#27322e]">{formatPennies(row.spentPennies ?? 0)}</strong>
                </p>
              )}
              {adjusting && row.selected && (
                <label className="mt-3 block text-xs font-bold text-[#5e6965]">
=======
                <p className="mt-3 border-t border-line pt-3 text-xs text-ink-600">
                  Existing purchase responsibility <strong className="font-semibold tabular-nums text-ink-900">{formatPennies(row.spentPennies ?? 0)}</strong>
                </p>
              )}
              {adjusting && row.selected && (
                <label className="mt-3 block text-xs font-semibold text-ink-600">
>>>>>>> 7534a2d (redesign and realtime)
                  Planned amount
                  <input
                    aria-label={`${row.name} planned amount in pounds`}
                    maxLength={INPUT_LIMITS.money}
                    value={row.amountInput}
                    onChange={(event) => {
                      onChange(rows.map((item) => item.contributorId === row.contributorId
                        ? { ...item, amountInput: event.target.value }
                        : item));
                      setActionError(null);
                    }}
                    inputMode="decimal"
<<<<<<< HEAD
                    className={`mt-2 h-11 w-full rounded-lg border px-3 text-base ${amount.ok ? "" : "border-[#c96f60] ring-2 ring-[#f7d9d2]"}`}
=======
                    className={cx(
                      "mt-2 h-11 w-full rounded-lg border bg-surface px-3 text-base font-normal tabular-nums text-ink-900 outline-none focus:border-accent/60 focus:ring-4 focus:ring-accent/20",
                      amount.ok ? "border-line-strong" : "border-berry/45 ring-2 ring-berry/25",
                    )}
>>>>>>> 7534a2d (redesign and realtime)
                  />
                </label>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
<<<<<<< HEAD
        <button type="button" onClick={splitEqually} className="min-h-12 rounded-xl bg-[#e6f1ed] px-3 py-3 text-sm font-bold text-[#174f45]">
          Split equally
        </button>
        <button type="button" onClick={() => setAdjusting((current) => !current)} className="min-h-12 rounded-xl border bg-white px-3 py-3 text-sm font-bold">
          {adjusting ? "Hide amounts" : "Adjust amounts"}
        </button>
      </div>
      <div className={`mt-4 rounded-xl px-4 py-3 text-sm font-semibold ${matchesBudget ? "bg-[#e5f2ed] text-[#17624f]" : "bg-[#fff3e2] text-[#8a5c16]"}`} aria-live="polite">
        {allocationMessage}
      </div>
      {actionError && <p className="mt-2 text-sm text-[#a5543f]">{actionError}</p>}
=======
        <Button variant="tonal" size="lg" onClick={splitEqually}>Split equally</Button>
        <Button variant="secondary" size="lg" onClick={() => setAdjusting((current) => !current)}>
          {adjusting ? "Hide amounts" : "Adjust amounts"}
        </Button>
      </div>
      <div
        className={cx(
          "mt-4 rounded-xl border px-4 py-3 text-sm font-medium",
          matchesBudget ? "border-accent-soft-border bg-accent-soft text-accent" : "border-warning-border bg-warning-soft text-warning",
        )}
        aria-live="polite"
      >
        {allocationMessage}
      </div>
      {actionError && <p className="mt-2 text-sm font-medium text-berry">{actionError}</p>}
>>>>>>> 7534a2d (redesign and realtime)
    </div>
  );
}

function priceInput(pennies: number) {
  return (pennies / 100).toFixed(2).replace(/\.00$/u, "");
}
