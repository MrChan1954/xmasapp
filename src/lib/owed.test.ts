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
    confirmedAmountPennies: 200,
  }]);
  assert.equal(balances[0].amountPennies, 400);
});

test("D: repayment of the remaining £4 clears the balance exactly", () => {
  const balances = calculateNetOwedBalances([
    { debtorContributorId: "paige", creditorContributorId: "taylor", amountPennies: 600 },
  ], [
    { payerContributorId: "paige", payeeContributorId: "taylor", amountPennies: 200, confirmedAmountPennies: 200 },
    { payerContributorId: "paige", payeeContributorId: "taylor", amountPennies: 400, confirmedAmountPennies: 400 },
  ]);
  assert.deepEqual(balances, []);
});

test("E: voiding the £4 settlement restores £4 outstanding", () => {
  const balances = calculateNetOwedBalances([
    { debtorContributorId: "paige", creditorContributorId: "taylor", amountPennies: 600 },
  ], [
    { payerContributorId: "paige", payeeContributorId: "taylor", amountPennies: 200, confirmedAmountPennies: 200 },
    { payerContributorId: "paige", payeeContributorId: "taylor", amountPennies: 400, confirmedAmountPennies: 400, voidedAt: "2026-08-10T12:00:00Z" },
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
    confirmedAmountPennies: 400,
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
    { payerContributorId: "taylor", payeeContributorId: "paige", amountPennies: 400, confirmedAmountPennies: 400 },
    { payerContributorId: "paige", payeeContributorId: "taylor", amountPennies: 200, confirmedAmountPennies: 200 },
  ]);
  assert.equal(paymentsBothWays.currentBalance?.amountPennies, 925);
  assert.equal(paymentsBothWays.currentBalance?.debtorContributorId, "paige");
});

/*
 * The two-sided confirmation flow, as balances.
 *
 * These are the scenarios the feature exists for, in the order they happen to
 * one payment. Every figure below is the one the Owed screen would print.
 */

const JADE_OWES_TAYLOR_50 = [
  { debtorContributorId: "jade", creditorContributorId: "taylor", amountPennies: 5_000 },
];

test("1: a payment nobody has confirmed leaves the balance exactly where it was", () => {
  const balances = calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 0 },
  ]);
  assert.equal(balances[0].amountPennies, 5_000, "a claim is not a repayment");
});

test("2: confirming a £20 payment in full reduces the balance by £20", () => {
  const balances = calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 2_000 },
  ]);
  assert.equal(balances[0].amountPennies, 3_000);
});

test("3: confirming £12 of a claimed £20 reduces the balance by £12 and no more", () => {
  const balances = calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 1_200 },
  ]);
  assert.equal(balances[0].amountPennies, 3_800, "the £8 nobody confirmed is still owed");
});

test("4: confirming the remaining £8 later settles the whole £20", () => {
  const balances = calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 2_000 },
  ]);
  assert.equal(balances[0].amountPennies, 3_000);
});

test("5: a rejected payment leaves the balance untouched", () => {
  const balances = calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 0 },
  ]);
  assert.equal(balances[0].amountPennies, 5_000);
});

test("6: the engine refuses a payment claiming less than has been confirmed", () => {
  assert.throws(
    () => calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
      { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 2_500 },
    ]),
    /more confirmed than was claimed/,
  );
});

test("7: repeated partial confirmations of one claim add up to exactly the claim", () => {
  // £30 claimed, confirmed £10 then £15 then £5. The engine only ever sees the
  // running total, which is what makes three confirmations indistinguishable
  // from one -- and what stops them being counted twice.
  const running = [1_000, 2_500, 3_000].map((confirmed) => calculateNetOwedBalances(
    [{ debtorContributorId: "jade", creditorContributorId: "taylor", amountPennies: 5_000 }],
    [{ payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 3_000, confirmedAmountPennies: confirmed }],
  )[0].amountPennies);

  assert.deepEqual(running, [4_000, 2_500, 2_000]);
});

test("8: a pending claim alongside a confirmed one only counts the confirmed part", () => {
  const balances = calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 2_000 },
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 1_500, confirmedAmountPennies: 0 },
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 1_000, confirmedAmountPennies: 400 },
  ]);
  assert.equal(balances[0].amountPennies, 5_000 - 2_000 - 400);
});

test("9: voiding a confirmed payment returns its confirmed amount to the balance", () => {
  const balances = calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 1_200, voidedAt: "2026-08-20T10:00:00Z" },
  ]);
  assert.equal(balances[0].amountPennies, 5_000);
});
