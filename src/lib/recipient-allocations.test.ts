import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { splitPenniesEqually, validateRecipientAllocationSnapshot } from "./recipient-allocations.ts";

const contributors = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

test("A: a budget change is rejected when the allocation snapshot is unchanged", () => {
  const original = contributors.map((contributorId) => ({
    contributorId,
    plannedAmountPennies: 2_500,
  }));
  const before = structuredClone(original);

  assert.equal(validateRecipientAllocationSnapshot(12_000, original).ok, false);
  assert.deepEqual(original, before, "failed validation must not mutate the existing plan");
});

test("B: a matching budget and complete allocation snapshot succeeds", () => {
  const result = validateRecipientAllocationSnapshot(
    12_000,
    contributors.map((contributorId) => ({ contributorId, plannedAmountPennies: 3_000 })),
  );
  assert.equal(result.ok, true);
});

test("C: one hundred pounds split three ways is deterministic and penny exact", () => {
  const result = splitPenniesEqually(10_000, contributors.slice(0, 3));
  assert.deepEqual(result.map((row) => row.plannedAmountPennies), [3_334, 3_333, 3_333]);
  assert.equal(result.reduce((total, row) => total + row.plannedAmountPennies, 0), 10_000);
});

test("D: a new sixty pound recipient plan validates as one complete snapshot", () => {
  const result = validateRecipientAllocationSnapshot(
    6_000,
    contributors.map((contributorId) => ({ contributorId, plannedAmountPennies: 1_500 })),
  );
  assert.equal(result.ok, true);
});

test("E: creating a sixty pound recipient with only forty-five pounds allocated is rejected", () => {
  const result = validateRecipientAllocationSnapshot(
    6_000,
    contributors.slice(0, 3).map((contributorId) => ({ contributorId, plannedAmountPennies: 1_500 })),
  );
  assert.equal(result.ok, false);
});

test("F: invalid and duplicate allocation rows are rejected without changing the input", () => {
  const attempted = [
    { contributorId: contributors[0], plannedAmountPennies: 3_000 },
    { contributorId: contributors[0], plannedAmountPennies: 3_000 },
  ];
  const before = structuredClone(attempted);
  assert.equal(validateRecipientAllocationSnapshot(6_000, attempted).ok, false);
  assert.deepEqual(attempted, before);
});
