import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { formatPennies } from "./currency.ts";

test("GBP display always uses two pence digits when pence are present", () => {
  assert.equal(formatPennies(150), "£1.50");
  assert.equal(formatPennies(105), "£1.05");
  assert.equal(formatPennies(1_125), "£11.25");
  assert.equal(formatPennies(270), "£2.70");
  assert.equal(formatPennies(1_320), "£13.20");
});

test("whole pounds remain clean and large or negative values stay penny-safe", () => {
  assert.equal(formatPennies(500), "£5");
  assert.equal(formatPennies(95_500), "£955");
  assert.equal(formatPennies(-150), "-£1.50");
  assert.equal(formatPennies(123_456_789), "£1,234,567.89");
});

test("non-integer money is rejected rather than rounded during display", () => {
  assert.throws(() => formatPennies(150.5), /integer number of pennies/);
});
