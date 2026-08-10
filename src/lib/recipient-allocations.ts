// @ts-expect-error Node's built-in type-stripping test runner needs the extension; Next's bundler resolves it too.
import { MAX_PENNIES, validateUuid, type ValidationResult } from "./input-validation.ts";

export type RecipientAllocation = {
  contributorId: string;
  plannedAmountPennies: number;
};

export function splitPenniesEqually(
  totalPennies: number,
  contributorIds: readonly string[],
): RecipientAllocation[] {
  if (!Number.isSafeInteger(totalPennies) || totalPennies < 0 || totalPennies > MAX_PENNIES) {
    throw new RangeError("The budget must be a non-negative integer number of pennies.");
  }
  if (contributorIds.length === 0) {
    throw new RangeError("Choose at least one contributor.");
  }
  if (new Set(contributorIds).size !== contributorIds.length) {
    throw new RangeError("Each contributor can appear only once.");
  }

  const base = Math.floor(totalPennies / contributorIds.length);
  const remainder = totalPennies % contributorIds.length;
  return contributorIds.map((contributorId, index) => ({
    contributorId,
    plannedAmountPennies: base + (index < remainder ? 1 : 0),
  }));
}

export function validateRecipientAllocationSnapshot(
  budgetPennies: number,
  allocations: readonly RecipientAllocation[],
): ValidationResult<RecipientAllocation[]> {
  if (!Number.isSafeInteger(budgetPennies) || budgetPennies < 0 || budgetPennies > MAX_PENNIES) {
    return { ok: false, error: "Enter a valid Christmas budget." };
  }

  const contributorIds = new Set<string>();
  let total = 0;
  const normalized: RecipientAllocation[] = [];
  for (const allocation of allocations) {
    const validContributorId = validateUuid(
      allocation.contributorId,
      "One contributor allocation is invalid. Refresh and try again.",
    );
    if (!validContributorId.ok) return validContributorId;
    if (contributorIds.has(validContributorId.value)) {
      return { ok: false, error: "Each contributor can appear only once." };
    }
    if (
      !Number.isSafeInteger(allocation.plannedAmountPennies)
      || allocation.plannedAmountPennies < 0
      || allocation.plannedAmountPennies > MAX_PENNIES
    ) {
      return { ok: false, error: "One contributor allocation has an invalid amount." };
    }

    contributorIds.add(validContributorId.value);
    total += allocation.plannedAmountPennies;
    if (!Number.isSafeInteger(total) || total > MAX_PENNIES) {
      return { ok: false, error: "The contributor allocation total is too large." };
    }
    normalized.push({
      contributorId: validContributorId.value,
      plannedAmountPennies: allocation.plannedAmountPennies,
    });
  }

  if (total !== budgetPennies) {
    const difference = Math.abs(budgetPennies - total);
    return {
      ok: false,
      error: total < budgetPennies
        ? `${difference} pennies still need allocating.`
        : `The allocation exceeds the budget by ${difference} pennies.`,
    };
  }

  return { ok: true, value: normalized };
}
