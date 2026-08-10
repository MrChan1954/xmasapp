import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { emptyPaymentFilters, filterPaymentRecords, sortPaymentRecords, summarizePaymentRecords, type PaymentLogRecord } from "./payment-log.ts";

const records: PaymentLogRecord[] = [
  {
    id: "new-paid",
    eventYear: 2026,
    payerContributorId: "paige",
    payerName: "Paige",
    payeeContributorId: "taylor",
    payeeName: "Taylor",
    amountPennies: 1200,
    paymentDate: "2026-08-10",
    recordedByAppMemberId: "taylor-member",
    recordedByName: "Taylor",
    recordedAt: "2026-08-10T17:05:00Z",
    notes: "Bank transfer",
    voidedAt: null,
    voidedByAppMemberId: null,
    voidedByName: null,
  },
  {
    id: "old-voided",
    eventYear: 2026,
    payerContributorId: "jade",
    payerName: "Jade",
    payeeContributorId: "paige",
    payeeName: "Paige",
    amountPennies: 600,
    paymentDate: "2026-08-08",
    recordedByAppMemberId: "taylor-member",
    recordedByName: "Taylor",
    recordedAt: "2026-08-08T14:32:00Z",
    notes: "Duplicate",
    voidedAt: "2026-08-09T10:30:00Z",
    voidedByAppMemberId: "taylor-member",
    voidedByName: "Taylor",
  },
  {
    id: "month-paid",
    eventYear: 2026,
    payerContributorId: "taylor",
    payerName: "Taylor",
    payeeContributorId: "jade",
    payeeName: "Jade",
    amountPennies: 250,
    paymentDate: "2026-08-01",
    recordedByAppMemberId: "jade-member",
    recordedByName: "Jade",
    recordedAt: "2026-08-01T09:00:00Z",
    notes: null,
    voidedAt: null,
    voidedByAppMemberId: null,
    voidedByName: null,
  },
];

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
    status: "paid",
    dateFrom: "2026-08-10",
    dateTo: "2026-08-10",
  }, context);
  assert.deepEqual(filtered.map((row) => row.id), ["new-paid"]);
});

test("quick date and status filters work alongside detailed filters", () => {
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "today" }, context).map((row) => row.id), ["new-paid"]);
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "week" }, context).map((row) => row.id), ["new-paid"]);
  assert.equal(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "month" }, context).length, 3);
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "voided" }, context).map((row) => row.id), ["old-voided"]);
});

test("current-user quick filters use contributor and membership IDs, never names", () => {
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "paid_by_me" }, context).map((row) => row.id), ["month-paid"]);
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "paid_to_me" }, context).map((row) => row.id), ["new-paid"]);
  assert.deepEqual(filterPaymentRecords(records, { ...emptyPaymentFilters, quick: "recorded_by_me" }, context).map((row) => row.id), ["new-paid", "old-voided"]);
});

test("filtered summary excludes voided payments from the active total", () => {
  assert.deepEqual(summarizePaymentRecords(records), {
    activeAmountPennies: 1450,
    recordCount: 3,
    voidedCount: 1,
    voidedAmountPennies: 600,
  });
});

test("column sorting supports names, amount, recorder, recorded time and status", () => {
  assert.equal(sortPaymentRecords(records, "payerName", "asc")[0].payerName, "Jade");
  assert.equal(sortPaymentRecords(records, "payeeName", "asc")[0].payeeName, "Jade");
  assert.equal(sortPaymentRecords(records, "amountPennies", "desc")[0].amountPennies, 1200);
  assert.equal(sortPaymentRecords(records, "recordedByName", "asc")[0].recordedByName, "Jade");
  assert.equal(sortPaymentRecords(records, "recordedAt", "asc")[0].id, "month-paid");
  assert.equal(sortPaymentRecords(records, "status", "desc")[0].voidedAt !== null, true);
});
