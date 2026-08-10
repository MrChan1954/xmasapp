import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { calculateFinancialProgress, calculatePurchaseBudgetPreview, normalizePurchaseStatus, splitPurchaseByWeights } from "./purchases.ts";

test("£18 splits equally three ways without losing a penny", () => {
  assert.deepEqual(
    splitPurchaseByWeights(1_800, [
      { contributorId: "jade", weightPennies: 1_500 },
      { contributorId: "paige", weightPennies: 1_500 },
      { contributorId: "taylor", weightPennies: 1_500 },
    ]).map((item) => item.responsibilityPennies),
    [600, 600, 600],
  );
});

test("£35 splits equally four ways", () => {
  assert.deepEqual(
    splitPurchaseByWeights(3_500, [
      { contributorId: "jade", weightPennies: 2_500 },
      { contributorId: "kirsten", weightPennies: 2_500 },
      { contributorId: "paige", weightPennies: 2_500 },
      { contributorId: "taylor", weightPennies: 2_500 },
    ]).map((item) => item.responsibilityPennies),
    [875, 875, 875, 875],
  );
});

test("£10 split three ways deterministically totals exactly £10", () => {
  const allocations = splitPurchaseByWeights(1_000, [
    { contributorId: "jade", weightPennies: 1 },
    { contributorId: "paige", weightPennies: 1 },
    { contributorId: "taylor", weightPennies: 1 },
  ]);
  assert.deepEqual(
    allocations.map((item) => item.responsibilityPennies),
    [334, 333, 333],
  );
  assert.equal(
    allocations.reduce((sum, item) => sum + item.responsibilityPennies, 0),
    1_000,
  );
});

test("under budget: £80 uses four £25 planning targets as equal weights", () => {
  const allocations = splitPurchaseByWeights(8_000, [
    { contributorId: "jade", weightPennies: 2_500 },
    { contributorId: "kirsten", weightPennies: 2_500 },
    { contributorId: "paige", weightPennies: 2_500 },
    { contributorId: "taylor", weightPennies: 2_500 },
  ]);
  assert.deepEqual(allocations.map((row) => row.responsibilityPennies), [2_000, 2_000, 2_000, 2_000]);
  assert.deepEqual(calculateFinancialProgress(8_000, 10_000), {
    state: "in_progress",
    percentage: 80,
    fillPercentage: 80,
    remainingPennies: 2_000,
    overPennies: 0,
  });
});

test("exact budget: £100 reaches the plan with £25 responsibility each", () => {
  const allocations = splitPurchaseByWeights(10_000, [
    { contributorId: "jade", weightPennies: 2_500 },
    { contributorId: "kirsten", weightPennies: 2_500 },
    { contributorId: "paige", weightPennies: 2_500 },
    { contributorId: "taylor", weightPennies: 2_500 },
  ]);
  assert.deepEqual(allocations.map((row) => row.responsibilityPennies), [2_500, 2_500, 2_500, 2_500]);
  assert.equal(calculateFinancialProgress(10_000, 10_000).state, "budget_reached");
  assert.equal(calculateFinancialProgress(10_000, 10_000).percentage, 100);
});

test("over budget: £120 remains allowed and scales four equal weights to £30 each", () => {
  const allocations = splitPurchaseByWeights(12_000, [
    { contributorId: "jade", weightPennies: 2_500 },
    { contributorId: "kirsten", weightPennies: 2_500 },
    { contributorId: "paige", weightPennies: 2_500 },
    { contributorId: "taylor", weightPennies: 2_500 },
  ]);
  assert.deepEqual(allocations.map((row) => row.responsibilityPennies), [3_000, 3_000, 3_000, 3_000]);
  const progress = calculateFinancialProgress(12_000, 10_000);
  assert.equal(progress.percentage, 120);
  assert.equal(progress.fillPercentage, 100, "the graphical fill must never overflow");
  assert.equal(progress.overPennies, 2_000);
});

test("unequal 50/30/20 planning weights scale below and above budget", () => {
  const weights = [
    { contributorId: "jade", weightPennies: 5_000 },
    { contributorId: "kirsten", weightPennies: 3_000 },
    { contributorId: "taylor", weightPennies: 2_000 },
  ];
  assert.deepEqual(
    splitPurchaseByWeights(8_000, weights).map((row) => row.responsibilityPennies),
    [4_000, 2_400, 1_600],
  );
  assert.deepEqual(
    splitPurchaseByWeights(12_000, weights).map((row) => row.responsibilityPennies),
    [6_000, 3_600, 2_400],
  );
});

test("legacy purchase statuses normalize safely to the two current states", () => {
  assert.equal(normalizePurchaseStatus("purchased"), "purchased");
  assert.equal(normalizePurchaseStatus("Purchased / Ordered"), "purchased");
  assert.equal(normalizePurchaseStatus("arrived"), "purchased");
  assert.equal(normalizePurchaseStatus("Arrived"), "purchased");
  assert.equal(normalizePurchaseStatus("wrapped"), "wrapped");
  assert.equal(normalizePurchaseStatus("unknown"), null);
});

test("add-purchase preview shows current, exact, and over-budget positions", () => {
  assert.deepEqual(calculatePurchaseBudgetPreview({
    budgetPennies: 10_000,
    currentSpentPennies: 4_500,
    newPricePennies: 2_000,
  }), {
    currentSpentPennies: 4_500,
    currentRemainingPennies: 5_500,
    projectedSpentPennies: 6_500,
    projectedRemainingPennies: 3_500,
  });
  assert.equal(calculatePurchaseBudgetPreview({ budgetPennies: 10_000, currentSpentPennies: 4_500, newPricePennies: 5_500 }).projectedRemainingPennies, 0);
  assert.equal(calculatePurchaseBudgetPreview({ budgetPennies: 10_000, currentSpentPennies: 4_500, newPricePennies: 7_000 }).projectedRemainingPennies, -1_500);
});

test("edit-purchase preview replaces the existing price instead of counting it twice", () => {
  assert.deepEqual(calculatePurchaseBudgetPreview({
    budgetPennies: 10_000,
    currentSpentPennies: 5_000,
    replacedPricePennies: 2_000,
    newPricePennies: 2_000,
  }), {
    currentSpentPennies: 5_000,
    currentRemainingPennies: 5_000,
    projectedSpentPennies: 5_000,
    projectedRemainingPennies: 5_000,
  });
});
