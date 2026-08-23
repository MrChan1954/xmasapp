import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { adminOverrideReason, emptyPaymentFilters, filterPaymentRecords, isAdminConfirmedPayment, isAwaitingConfirmation, sortPaymentRecords, summarizePaymentRecords, unconfirmedAmountPennies, type PaymentLogRecord } from "./payment-log.ts";

/**
 * A record with sensible defaults, so each fixture below states only the thing
 * it is actually about. Everything defaults to a confirmed payment, which is
 * what every payment in the log was before confirmations existed.
 */
function record(overrides: Partial<PaymentLogRecord> & Pick<PaymentLogRecord, "id">): PaymentLogRecord {
  const amountPennies = overrides.amountPennies ?? 1_200;
  return {
    eventName: "Christmas 2026",
    eventYear: 2026,
    payerContributorId: "paige",
    payerName: "Paige",
    payeeContributorId: "taylor",
    payeeName: "Taylor",
    amountPennies,
    confirmedAmountPennies: amountPennies,
    paymentDate: "2026-08-10",
    recordedByAppMemberId: "taylor-member",
    recordedByName: "Taylor",
    recordedAt: "2026-08-10T17:05:00Z",
    notes: null,
    status: "confirmed",
    confirmedAt: "2026-08-10T17:05:00Z",
    lastReviewedAt: "2026-08-10T17:05:00Z",
    reviewedByAppMemberId: "taylor-member",
    reviewedByName: "Taylor",
    rejectedAt: null,
    rejectionReason: null,
    voidedAt: null,
    voidedByAppMemberId: null,
    voidedByName: null,
    receipts: [],
    ...overrides,
  };
}

const records: PaymentLogRecord[] = [
  record({ id: "new-paid", notes: "Bank transfer" }),
  record({
    id: "old-voided",
    payerContributorId: "jade",
    payerName: "Jade",
    payeeContributorId: "paige",
    payeeName: "Paige",
    amountPennies: 600,
    confirmedAmountPennies: 600,
    paymentDate: "2026-08-08",
    recordedAt: "2026-08-08T14:32:00Z",
    notes: "Duplicate",
    status: "voided",
    voidedAt: "2026-08-09T10:30:00Z",
    voidedByAppMemberId: "taylor-member",
    voidedByName: "Taylor",
  }),
  record({
    id: "month-paid",
    payerContributorId: "taylor",
    payerName: "Taylor",
    payeeContributorId: "jade",
    payeeName: "Jade",
    amountPennies: 250,
    confirmedAmountPennies: 250,
    paymentDate: "2026-08-01",
    recordedByAppMemberId: "jade-member",
    recordedByName: "Jade",
    recordedAt: "2026-08-01T09:00:00Z",
    reviewedByAppMemberId: "jade-member",
    reviewedByName: "Jade",
  }),
];

/** Jade says she paid Taylor £20; Taylor has confirmed £12 of it. */
const partlyConfirmed = record({
  id: "part-confirmed",
  payerContributorId: "jade",
  payerName: "Jade",
  amountPennies: 2_000,
  confirmedAmountPennies: 1_200,
  paymentDate: "2026-08-10",
  recordedByAppMemberId: "jade-member",
  recordedByName: "Jade",
  recordedAt: "2026-08-10T18:00:00Z",
  status: "partially_confirmed",
  confirmedAt: null,
  lastReviewedAt: "2026-08-10T19:00:00Z",
  receipts: [
    { id: "r-1", action: "confirm", amountPennies: 1_200, reason: null, source: "review", actedByName: "Taylor", reviewerName: "Taylor", createdAt: "2026-08-10T19:00:00Z" },
  ],
});

/** Jade says she paid Taylor £20; Taylor has not looked at it yet. */
const pending = record({
  id: "pending",
  payerContributorId: "jade",
  payerName: "Jade",
  amountPennies: 2_000,
  confirmedAmountPennies: 0,
  recordedByAppMemberId: "jade-member",
  recordedByName: "Jade",
  recordedAt: "2026-08-10T20:00:00Z",
  status: "pending",
  confirmedAt: null,
  lastReviewedAt: null,
  reviewedByAppMemberId: null,
  reviewedByName: null,
});

/** Jade says she paid Taylor £20; Taylor says nothing arrived. */
const rejected = record({
  id: "rejected",
  payerContributorId: "jade",
  payerName: "Jade",
  amountPennies: 2_000,
  confirmedAmountPennies: 0,
  recordedByAppMemberId: "jade-member",
  recordedByName: "Jade",
  recordedAt: "2026-08-10T21:00:00Z",
  status: "rejected",
  confirmedAt: null,
  lastReviewedAt: "2026-08-10T22:00:00Z",
  rejectedAt: "2026-08-10T22:00:00Z",
  rejectionReason: "Nothing has arrived in my bank yet.",
  receipts: [
    { id: "r-2", action: "reject", amountPennies: 2_000, reason: "Nothing has arrived in my bank yet.", source: "review", actedByName: "Taylor", reviewerName: "Taylor", createdAt: "2026-08-10T22:00:00Z" },
  ],
});

const context = {
  today: "2026-08-10",
  currentContributorId: "taylor",
  currentAppMemberId: "taylor-member",
};

test("newest-first payment sorting uses recorded time as a deterministic tie-break", () => {
  assert.deepEqual(
    sortPaymentRecords(records, "paymentDate", "desc").map((row) => row.id),
    ["new-paid", "old-voided", "month-paid"],
  );
});

test("search and detailed filters combine across names, notes, status and dates", () => {
  const filtered = filterPaymentRecords(records, {
    ...emptyPaymentFilters,
    search: "bank",
    payerContributorId: "paige",
    payeeContributorId: "taylor",
    recordedByAppMemberId: "taylor-member",
    status: "confirmed",
    dateFrom: "2026-08-10",
    dateTo: "2026-08-10",
  }, context);
  assert.deepEqual(filtered.map((row) => row.id), ["new-paid"]);
});

test("search reaches the reason a payment was refused", () => {
  const filtered = filterPaymentRecords([...records, rejected], { ...emptyPaymentFilters, search: "arrived" }, context);
  assert.deepEqual(filtered.map((row) => row.id), ["rejected"]);
});

test("quick date and status filters work alongside detailed filters", () => {
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "today" }, context).map((row) => row.id), ["new-paid"]);
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "week" }, context).map((row) => row.id), ["new-paid"]);
  assert.equal(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "month" }, context).length, 3);
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "voided" }, context).map((row) => row.id), ["old-voided"]);
});

test("every confirmation state can be filtered for on its own", () => {
  const all = [...records, pending, partlyConfirmed, rejected];
  const idsFor = (quick: string) => filterPaymentRecords(all, { ...emptyPaymentFilters, quick: quick as never }, context).map((row) => row.id);

  assert.deepEqual(idsFor("pending"), ["pending"]);
  assert.deepEqual(idsFor("rejected"), ["rejected"]);
  assert.deepEqual(idsFor("voided"), ["old-voided"]);
  assert.deepEqual(idsFor("confirmed").sort(), ["month-paid", "new-paid"]);
  // Partly confirmed is deliberately absent from the quick chips but reachable
  // from the status dropdown, which is the detailed filter.
  assert.deepEqual(
    filterPaymentRecords(all, { ...emptyPaymentFilters, status: "partially_confirmed" }, context).map((row) => row.id),
    ["part-confirmed"],
  );
});

test("current-user quick filters use contributor and membership IDs, never names", () => {
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "paid_by_me" }, context).map((row) => row.id), ["month-paid"]);
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "paid_to_me" }, context).map((row) => row.id), ["new-paid"]);
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "recorded_by_me" }, context).map((row) => row.id), ["new-paid", "old-voided"]);
});

test("\"waiting on me\" finds only payments this reader still has to review", () => {
  const all = [...records, pending, partlyConfirmed, rejected];
  assert.deepEqual(
    filterPaymentRecords(all, { ...emptyPaymentFilters, quick: "awaiting_my_confirmation" }, context)
      .map((row) => row.id)
      .sort(),
    ["part-confirmed", "pending"],
    "a rejected payment is finished, and a confirmed one needs nothing",
  );
});

test("the summary separates confirmed money from money merely claimed", () => {
  assert.deepEqual(summarizePaymentRecords([...records, pending, partlyConfirmed, rejected]), {
    // 1200 + 250 confirmed, plus the 1200 confirmed out of the partial claim.
    claimedAmountPennies: 1_200 + 250 + 2_000 + 2_000 + 2_000,
    confirmedAmountPennies: 1_200 + 250 + 1_200,
    awaitingAmountPennies: 2_000 + 800,
    awaitingCount: 2,
    rejectedCount: 1,
    recordCount: 6,
    voidedCount: 1,
    voidedAmountPennies: 600,
  });
});

test("unconfirmed amounts and waiting state read straight off the record", () => {
  assert.equal(unconfirmedAmountPennies(partlyConfirmed), 800);
  assert.equal(isAwaitingConfirmation(partlyConfirmed), true);
  assert.equal(unconfirmedAmountPennies(rejected), 2_000);
  assert.equal(isAwaitingConfirmation(rejected), false, "a refused payment is not waiting on anybody");
  assert.equal(isAwaitingConfirmation(records[1]), false, "and neither is a voided one");
});

test("column sorting supports names, amounts, recorder, recorded time and status", () => {
  assert.equal(sortPaymentRecords(records, "payerName", "asc")[0].payerName, "Jade");
  assert.equal(sortPaymentRecords(records, "payeeName", "asc")[0].payeeName, "Jade");
  assert.equal(sortPaymentRecords(records, "amountPennies", "desc")[0].amountPennies, 1200);
  assert.equal(sortPaymentRecords([...records, partlyConfirmed], "confirmedAmountPennies", "desc")[0].id, "part-confirmed");
  assert.equal(sortPaymentRecords(records, "recordedByName", "asc")[0].recordedByName, "Jade");
  assert.equal(sortPaymentRecords(records, "recordedAt", "asc")[0].id, "month-paid");
  assert.equal(sortPaymentRecords(records, "status", "desc")[0].voidedAt !== null, true);
});

test("the full audit trail survives on the record itself", () => {
  // The claim is never overwritten by what was confirmed, and the history that
  // got it there is kept alongside both.
  assert.equal(partlyConfirmed.amountPennies, 2_000);
  assert.equal(partlyConfirmed.confirmedAmountPennies, 1_200);
  assert.equal(partlyConfirmed.receipts.length, 1);
  assert.equal(partlyConfirmed.receipts[0].reviewerName, "Taylor");
  assert.equal(rejected.rejectionReason, "Nothing has arrived in my bank yet.");
  assert.equal(rejected.receipts[0].action, "reject");
});

/** Kirsten (Global Admin) reconciled £20 Jade paid Paige outside the app. */
const adminConfirmed = record({
  id: "admin-confirmed",
  payerContributorId: "jade",
  payerName: "Jade",
  payeeContributorId: "paige",
  payeeName: "Paige",
  amountPennies: 2_000,
  confirmedAmountPennies: 2_000,
  recordedByAppMemberId: "kirsten-member",
  recordedByName: "Kirsten",
  recordedAt: "2026-08-10T23:00:00Z",
  reviewedByAppMemberId: "kirsten-member",
  reviewedByName: "Kirsten",
  receipts: [
    {
      id: "r-3",
      action: "confirm",
      amountPennies: 2_000,
      reason: "Payment confirmed outside the app",
      source: "admin_override",
      actedByName: "Kirsten",
      reviewerName: "Paige",
      createdAt: "2026-08-10T23:00:00Z",
    },
  ],
});

test("an admin override is never indistinguishable from an ordinary confirmation", () => {
  assert.equal(isAdminConfirmedPayment(adminConfirmed), true);
  assert.equal(adminOverrideReason(adminConfirmed), "Payment confirmed outside the app");

  // Everything the audit trail has to keep.
  assert.equal(adminConfirmed.payerName, "Jade");
  assert.equal(adminConfirmed.payeeName, "Paige");
  assert.equal(adminConfirmed.amountPennies, 2_000);
  assert.equal(adminConfirmed.paymentDate, "2026-08-10");
  assert.equal(adminConfirmed.receipts[0].actedByName, "Kirsten", "the admin who did it");
  assert.equal(adminConfirmed.receipts[0].reviewerName, "Paige", "whose acknowledgement was stood in for");
  assert.ok(adminConfirmed.receipts[0].createdAt);

  // Ordinary payments are not mislabelled by it.
  for (const ordinary of [...records, pending, partlyConfirmed, rejected]) {
    assert.equal(isAdminConfirmedPayment(ordinary), false, ordinary.id);
    assert.equal(adminOverrideReason(ordinary), null, ordinary.id);
  }
});

test("an admin override still counts as confirmed money in the totals", () => {
  // It settled a real debt, so it belongs in the confirmed figure -- the badge
  // is what tells the reader how it got there, not a separate column of money.
  const summary = summarizePaymentRecords([adminConfirmed]);
  assert.equal(summary.confirmedAmountPennies, 2_000);
  assert.equal(summary.awaitingAmountPennies, 0);
  assert.equal(summary.recordCount, 1);
  assert.equal(isAwaitingConfirmation(adminConfirmed), false);
});
