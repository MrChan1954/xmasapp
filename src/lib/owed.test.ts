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

/*
 * The admin override, as balances.
 *
 * The engine is deliberately blind to who recorded a payment and to what role
 * they hold: it reads `confirmedAmountPennies` and nothing else. That is the
 * property these two tests pin, because it is what makes both halves of the
 * feature true at once -- an admin's own claim moves nothing, and an admin's
 * override moves the balance the moment it is written.
 */

test("10: a Global Admin's own claim is a claim, and moves no balance", () => {
  // Taylor is the Global Admin and the person being paid; Jade is the payer.
  // Reversed, Taylor as admin says he paid Jade: still zero confirmed, so the
  // balance does not budge. Being an admin is not an input to this function.
  const adminAsPayer = calculateNetOwedBalances(
    [{ debtorContributorId: "taylor", creditorContributorId: "jade", amountPennies: 2_000 }],
    [{ payerContributorId: "taylor", payeeContributorId: "jade", amountPennies: 2_000, confirmedAmountPennies: 0 }],
  );
  assert.equal(adminAsPayer[0].amountPennies, 2_000, "an admin's claim is still only a claim");
  assert.equal(adminAsPayer[0].debtorContributorId, "taylor");
});

test("11: an admin override reduces the balance immediately, by its confirmed amount", () => {
  // `admin_record_confirmed_payment` writes confirmed = claimed at creation,
  // so the very first read after it lands is already reduced -- no review step
  // stands between the override and the balance.
  const override = calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 2_000 },
  ]);
  assert.equal(override[0].amountPennies, 3_000);

  // And it nets against ordinary money in the same pair without any special
  // handling, because the ledger has no notion of where a confirmation came
  // from: £20 by override plus £12 confirmed of a £20 claim clears £32.
  const alongsideOrdinary = calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 2_000 },
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 1_200 },
  ]);
  assert.equal(alongsideOrdinary[0].amountPennies, 5_000 - 3_200);

  // Voiding an override returns the money, exactly as for any other payment.
  const voided = calculateNetOwedBalances(JADE_OWES_TAYLOR_50, [
    { payerContributorId: "jade", payeeContributorId: "taylor", amountPennies: 2_000, confirmedAmountPennies: 2_000, voidedAt: "2026-08-21T09:00:00Z" },
  ]);
  assert.equal(voided[0].amountPennies, 5_000);
});
