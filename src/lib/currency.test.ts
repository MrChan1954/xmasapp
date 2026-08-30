import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { formatPennies, priceInput } from "./currency.ts";

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

// ---------------------------------------------------------------------------
// priceInput -- pennies as the string an editable money field holds
//
// Four screens spelled this out for themselves before Q18 gave it one home, so
// every case below is what those four fields already did, held still.
// ---------------------------------------------------------------------------

test("an editable money field opens on whole pounds without a trailing .00", () => {
  assert.equal(priceInput(0), "0");
  assert.equal(priceInput(100), "1");
  assert.equal(priceInput(3_000), "30");
  assert.equal(priceInput(1_000_000), "10000");
});

test("pence survive into the field, including one that needs a leading zero", () => {
  assert.equal(priceInput(3_050), "30.50");
  assert.equal(priceInput(3_005), "30.05");
  assert.equal(priceInput(1), "0.01");
  assert.equal(priceInput(99), "0.99");
  assert.equal(priceInput(2_147_483_647), "21474836.47");
});

test("the field value carries no currency symbol and no thousands separator", () => {
  // formatPennies adds both on purpose. An input carrying either cannot be
  // submitted unedited, because parseMoneyToPennies would refuse to read it
  // back -- which is why this is a separate function and not a call to that one.
  assert.equal(priceInput(123_456_789), "1234567.89");
  assert.equal(formatPennies(123_456_789), `${String.fromCharCode(163)}1,234,567.89`);
  assert.ok(!priceInput(123_456_789).includes(","));
  assert.ok(!priceInput(123_456_789).includes(String.fromCharCode(163)));
});

test("a negative amount keeps its sign in front of the digits", () => {
  // formatPennies moves the sign outside the symbol; the field has no symbol to
  // move it outside of, so the plain number is what a person sees and edits.
  assert.equal(priceInput(-500), "-5");
  assert.equal(priceInput(-150), "-1.50");
});

test("the field renders two pence digits or none, never one", () => {
  // toFixed(2) then a strip of a trailing .00 -- so the only two shapes a field
  // can ever open on are `N` and `N.dd`. A field showing `30.5` would parse back
  // as 30 pounds 50, which is right, but it is not how money is written.
  for (const pennies of [0, 1, 9, 10, 50, 99, 100, 105, 150, 999, 1_000, 30_012]) {
    assert.match(priceInput(pennies), /^-?\d+(\.\d{2})?$/u);
  }
});

test("priceInput does not throw where formatPennies deliberately does", () => {
  // Every caller feeds it an integer penny column, so this is not a licence to
  // pass floats -- it is why a field cannot take a screen down. The parse on the
  // way back out is where invalid money is caught.
  assert.throws(() => formatPennies(10.5));
  assert.equal(priceInput(10.5), "0.10");
});
