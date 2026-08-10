import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { calculateNetOwedBalances, calculatePairBalanceExplanation, contributorOwedSummary } from "./owed.ts";

test("A: checkout payer's own responsibility creates no self-debt", () => {
  const balances = calculateNetOwedBalances([
    { debtorContributorId: "jade", creditorContributorId: "jade", amountPennies: 600 },
    { debtorContributorId: "paige", creditorContributorId: "jade", amountPennies: 600 },
    { debtorContributorId: "taylor", creditorContributorId: "jade", amountPennies: 600 },
  ], []);
  assert.deepEqual(balances.map((balance) => [balance.debtorContributorId, balance.creditorContributorId, balance.amountPennies]), [
    ["paige", "jade", 600],
    ["taylor", "jade", 600],
  ]);
});

test("B: reciprocal purchase obligations net only within the same pair", () => {
  const balances = calculateNetOwedBalances([
    { debtorContributorId: "paige", creditorContributorId: "taylor", amountPennies: 1_000 },
    { debtorContributorId: "taylor", creditorContributorId: "paige", amountPennies: 400 },
  ], []);
  assert.deepEqual(balances, [{
    pairKey: "paige|taylor",
    debtorContributorId: "paige",
    creditorContributorId: "taylor",
    amountPennies: 600,
  }]);
});

test("C: a £2 partial repayment reduces £6 outstanding to £4", () => {
  const balances = calculateNetOwedBalances([
    { debtorContributorId: "paige", creditorContributorId: "taylor", amountPennies: 600 },
  ], [{
    payerContributorId: "paige",
    payeeContributorId: "taylor",
    amountPennies: 200,
  }]);
  assert.equal(balances[0].amountPennies, 400);
});

test("D: repayment of the remaining £4 clears the balance exactly", () => {
  const balances = calculateNetOwedBalances([
    { debtorContributorId: "paige", creditorContributorId: "taylor", amountPennies: 600 },
  ], [
    { payerContributorId: "paige", payeeContributorId: "taylor", amountPennies: 200 },
    { payerContributorId: "paige", payeeContributorId: "taylor", amountPennies: 400 },
  ]);
  assert.deepEqual(balances, []);
});

test("E: voiding the £4 settlement restores £4 outstanding", () => {
  const balances = calculateNetOwedBalances([
    { debtorContributorId: "paige", creditorContributorId: "taylor", amountPennies: 600 },
  ], [
    { payerContributorId: "paige", payeeContributorId: "taylor", amountPennies: 200 },
    { payerContributorId: "paige", payeeContributorId: "taylor", amountPennies: 400, voidedAt: "2026-08-10T12:00:00Z" },
  ]);
  assert.equal(balances[0].amountPennies, 400);
});

test("F: unrelated debts are never netted together", () => {
  const balances = calculateNetOwedBalances([
    { debtorContributorId: "paige", creditorContributorId: "taylor", amountPennies: 600 },
    { debtorContributorId: "jade", creditorContributorId: "kirsten", amountPennies: 250 },
  ], []);
  assert.equal(balances.length, 2);
  assert.equal(balances.reduce((sum, balance) => sum + balance.amountPennies, 0), 850);
});

test("contributor card Owed totals only outgoing balances", () => {
  const balances = calculateNetOwedBalances([
    { debtorContributorId: "taylor", creditorContributorId: "jade", amountPennies: 1_000 },
    { debtorContributorId: "taylor", creditorContributorId: "paige", amountPennies: 500 },
    { debtorContributorId: "kirsten", creditorContributorId: "taylor", amountPennies: 3_000 },
  ], []);

  const taylor = contributorOwedSummary(balances, "taylor");
  assert.equal(taylor.youOwePennies, 1_500);
  assert.equal(taylor.owedToYouPennies, 3_000);
});

test("opposite purchase directions and payments explain the current net balance", () => {
  const obligations = [
    { debtorContributorId: "paige", creditorContributorId: "taylor", amountPennies: 1_250 },
    { debtorContributorId: "taylor", creditorContributorId: "paige", amountPennies: 525 },
  ];
  const purchaseOnly = calculatePairBalanceExplanation("paige", "taylor", obligations, []);
  assert.deepEqual(purchaseOnly.purchaseBalance, {
    pairKey: "paige|taylor",
    debtorContributorId: "paige",
    creditorContributorId: "taylor",
    amountPennies: 725,
  });

  const oppositePayment = calculatePairBalanceExplanation("paige", "taylor", obligations, [{
    payerContributorId: "taylor",
    payeeContributorId: "paige",
    amountPennies: 400,
  }]);
  assert.equal(oppositePayment.currentBalance?.amountPennies, 1_125);
  assert.equal(oppositePayment.currentBalance?.debtorContributorId, "paige");
  assert.deepEqual(oppositePayment.paymentAdjustment, {
    pairKey: "paige|taylor",
    debtorContributorId: "paige",
    creditorContributorId: "taylor",
    amountPennies: 400,
  });

  const paymentsBothWays = calculatePairBalanceExplanation("paige", "taylor", obligations, [
    { payerContributorId: "taylor", payeeContributorId: "paige", amountPennies: 400 },
    { payerContributorId: "paige", payeeContributorId: "taylor", amountPennies: 200 },
  ]);
  assert.equal(paymentsBothWays.currentBalance?.amountPennies, 925);
  assert.equal(paymentsBothWays.currentBalance?.debtorContributorId, "paige");
});
