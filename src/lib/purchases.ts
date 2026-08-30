// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { parseMoneyToPennies } from "./input-validation.ts";

export type ResponsibilityWeight = {
  contributorId: string;
  weightPennies: number;
};

export type ResponsibilityAllocation = {
  contributorId: string;
  responsibilityPennies: number;
};

export type PurchaseProgressStatus =
  | "not_started"
  | "in_progress"
  | "budget_reached"
  | "over_budget";

export type PurchaseStatus = "purchased" | "wrapped";

export type FinancialProgress = {
  state: PurchaseProgressStatus;
  percentage: number | null;
  fillPercentage: number;
  remainingPennies: number;
  overPennies: number;
};

export type PurchaseBudgetPreview = {
  currentSpentPennies: number;
  currentRemainingPennies: number;
  projectedSpentPennies: number;
  projectedRemainingPennies: number;
};

export function splitPurchaseByWeights(
  actualPricePennies: number,
  weights: ResponsibilityWeight[],
): ResponsibilityAllocation[] {
  if (!Number.isSafeInteger(actualPricePennies) || actualPricePennies < 0) {
    throw new Error("Purchase price must be a non-negative integer number of pennies.");
  }

  const positiveWeights = weights.filter((item) => {
    if (!Number.isSafeInteger(item.weightPennies) || item.weightPennies < 0) {
      throw new Error("Responsibility weights must be non-negative integer pennies.");
    }
    return item.weightPennies > 0;
  });
  if (positiveWeights.length === 0) {
    throw new Error("At least one positive responsibility weight is required.");
  }
  if (new Set(positiveWeights.map((item) => item.contributorId)).size !== positiveWeights.length) {
    throw new Error("Each contributor can appear only once.");
  }

  const totalWeight = positiveWeights.reduce(
    (sum, item) => sum + BigInt(item.weightPennies),
    BigInt(0),
  );
  const totalPrice = BigInt(actualPricePennies);
  const calculated = positiveWeights.map((item, index) => {
    const numerator = totalPrice * BigInt(item.weightPennies);
    return {
      contributorId: item.contributorId,
      responsibilityPennies: Number(numerator / totalWeight),
      remainder: numerator % totalWeight,
      index,
    };
  });

  const penniesLeft = actualPricePennies - calculated.reduce(
    (sum, item) => sum + item.responsibilityPennies,
    0,
  );
  const remainderOrder = [...calculated].sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (let index = 0; index < penniesLeft; index += 1) {
    remainderOrder[index].responsibilityPennies += 1;
  }
  return calculated.map(({ contributorId, responsibilityPennies }) => ({
    contributorId,
    responsibilityPennies,
  }));
}

export function parsePoundsToPennies(
  input: string,
): { ok: true; pennies: number } | { ok: false; error: string } {
  const result = parseMoneyToPennies(input);
  return result.ok && result.value !== null
    ? { ok: true, pennies: result.value }
    : { ok: false, error: result.ok ? "Enter an amount." : result.error };
}

export function purchaseProgressStatus(
  spentPennies: number,
  budgetPennies: number,
): PurchaseProgressStatus {
  if (spentPennies === 0) return "not_started";
  if (spentPennies < budgetPennies) return "in_progress";
  if (spentPennies === budgetPennies) return "budget_reached";
  return "over_budget";
}

export function calculateFinancialProgress(
  actualPennies: number,
  plannedPennies: number,
): FinancialProgress {
  if (
    !Number.isSafeInteger(actualPennies)
    || !Number.isSafeInteger(plannedPennies)
    || actualPennies < 0
    || plannedPennies < 0
  ) {
    throw new Error("Financial progress must use non-negative integer pennies.");
  }

  const state = purchaseProgressStatus(actualPennies, plannedPennies);
  const percentage = plannedPennies === 0
    ? actualPennies === 0 ? 0 : null
    : (actualPennies / plannedPennies) * 100;
  return {
    state,
    percentage,
    fillPercentage: percentage === null ? 100 : Math.min(100, Math.max(0, percentage)),
    remainingPennies: Math.max(0, plannedPennies - actualPennies),
    overPennies: Math.max(0, actualPennies - plannedPennies),
  };
}

export function calculatePurchaseBudgetPreview({
  budgetPennies,
  currentSpentPennies,
  newPricePennies,
  replacedPricePennies = 0,
}: {
  budgetPennies: number;
  currentSpentPennies: number;
  newPricePennies: number;
  replacedPricePennies?: number;
}): PurchaseBudgetPreview {
  for (const [label, value] of [
    ["Budget", budgetPennies],
    ["Current spending", currentSpentPennies],
    ["New purchase price", newPricePennies],
    ["Replaced purchase price", replacedPricePennies],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must use non-negative integer pennies.`);
    }
  }
  if (replacedPricePennies > currentSpentPennies) {
    throw new Error("The replaced purchase cannot exceed current recipient spending.");
  }
  const projectedSpentPennies = currentSpentPennies - replacedPricePennies + newPricePennies;
  if (!Number.isSafeInteger(projectedSpentPennies)) {
    throw new Error("Projected recipient spending exceeds safe integer limits.");
  }
  return {
    currentSpentPennies,
    currentRemainingPennies: budgetPennies - currentSpentPennies,
    projectedSpentPennies,
    projectedRemainingPennies: budgetPennies - projectedSpentPennies,
  };
}

export function normalizePurchaseStatus(status: unknown): PurchaseStatus | null {
  if (status === "wrapped" || status === "Wrapped") return "wrapped";
  if (
    status === "purchased"
    || status === "arrived"
    || status === "Purchased"
    || status === "Arrived"
    || status === "Purchased / Ordered"
  ) return "purchased";
  return null;
}

export function purchaseLifecycleLabel(status: PurchaseStatus) {
  return status === "wrapped" ? "Wrapped" : "Purchased";
}
