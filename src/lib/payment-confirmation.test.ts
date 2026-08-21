import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { adminPaymentError, isAdminConfirmed, isAwaitingReview, payerStatusSummary, paymentStatusLabel, paymentStatusOf, reviewPaymentError, unconfirmedPennies, validateConfirmationAmount, validateRejectionReason } from "./payment-confirmation.ts";

/**
 * The rules a receiver's review has to obey, and the states a payment can be
 * in.
 *
 * The database enforces all of this for real -- `review_payment` under a row
 * lock, plus a CHECK constraint. These tests cover the copy the browser uses to
 * refuse a bad figure before it is sent, and the LAST test asserts the copy has
 * not drifted from the migration it mirrors.
 */

const claim = (amountPennies: number, confirmedAmountPennies: number, extra: Record<string, unknown> = {}) => ({
  amountPennies,
  confirmedAmountPennies,
  ...extra,
});

test("a payment nobody has reviewed is pending, and reduces nothing", () => {
  const pending = claim(2_000, 0);
  assert.equal(paymentStatusOf(pending), "pending");
  assert.equal(unconfirmedPennies(pending), 2_000);
  assert.equal(isAwaitingReview(pending), true);
  assert.equal(payerStatusSummary(pending), "Awaiting confirmation");
});

test("part of a claim confirmed leaves the rest outstanding and still reviewable", () => {
  const partial = claim(2_000, 1_200);
  assert.equal(paymentStatusOf(partial), "partially_confirmed");
  assert.equal(unconfirmedPennies(partial), 800);
  assert.equal(isAwaitingReview(partial), true);
  assert.equal(payerStatusSummary(partial), "£12 of £20 received");
});

test("a claim confirmed in full is finished", () => {
  const confirmed = claim(2_000, 2_000);
  assert.equal(paymentStatusOf(confirmed), "confirmed");
  assert.equal(unconfirmedPennies(confirmed), 0);
  assert.equal(isAwaitingReview(confirmed), false);
  assert.equal(payerStatusSummary(confirmed), "£20 received");
});

test("a rejection closes a payment, and a partial rejection keeps what did arrive", () => {
  const rejected = claim(2_000, 0, { rejectedAt: "2026-08-20T10:00:00Z" });
  assert.equal(paymentStatusOf(rejected), "rejected");
  assert.equal(isAwaitingReview(rejected), false, "a rejected payment is not waiting on anybody");
  assert.equal(payerStatusSummary(rejected), "Not received");

  // £12 arrived, the other £8 never did. The £12 stays confirmed: the receiver
  // said it arrived, and a later rejection of the remainder cannot unsay that.
  const partlyRejected = claim(2_000, 1_200, { rejectedAt: "2026-08-20T10:00:00Z" });
  assert.equal(paymentStatusOf(partlyRejected), "partially_confirmed");
  assert.equal(isAwaitingReview(partlyRejected), false);
});

test("voided beats every other state", () => {
  assert.equal(paymentStatusOf(claim(2_000, 2_000, { voidedAt: "2026-08-20T10:00:00Z" })), "voided");
  assert.equal(paymentStatusOf(claim(2_000, 0, { voidedAt: "2026-08-20T10:00:00Z", rejectedAt: "2026-08-20T10:00:00Z" })), "voided");
  assert.equal(isAwaitingReview(claim(2_000, 0, { voidedAt: "2026-08-20T10:00:00Z" })), false);
});

test("confirmed receipt can never exceed what was claimed", () => {
  const twenty = claim(2_000, 0);
  assert.equal(validateConfirmationAmount("20", twenty).ok, true);
  const tooMuch = validateConfirmationAmount("20.01", twenty);
  assert.equal(tooMuch.ok, false);
  assert.match(tooMuch.ok ? "" : tooMuch.error, /up to £20/);

  // And after £12 has been confirmed, only £8 is left to confirm.
  const remaining = claim(2_000, 1_200);
  assert.equal(validateConfirmationAmount("8", remaining).ok, true);
  assert.equal(validateConfirmationAmount("8.01", remaining).ok, false);
  assert.match(
    (validateConfirmationAmount("8.01", remaining) as { error: string }).error,
    /up to £8/,
  );
});

test("a partial confirmation of nothing is refused", () => {
  for (const input of ["0", "0.00", "", "-5", "abc"]) {
    assert.equal(validateConfirmationAmount(input, claim(2_000, 0)).ok, false, `${input} must be refused`);
  }
});

test("pennies survive: £1.50 is 150, not 149", () => {
  const result = validateConfirmationAmount("1.50", claim(2_000, 0));
  assert.deepEqual(result, { ok: true, pennies: 150 });
  assert.deepEqual(validateConfirmationAmount("0.01", claim(2_000, 0)), { ok: true, pennies: 1 });
  assert.deepEqual(validateConfirmationAmount("£12.34", claim(2_000, 0)), { ok: true, pennies: 1_234 });
});

test("a fully confirmed payment cannot be confirmed again", () => {
  const result = validateConfirmationAmount("1", claim(2_000, 2_000));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /already been confirmed in full/);
});

test("a rejection must give a reason", () => {
  assert.equal(validateRejectionReason("").ok, false);
  assert.equal(validateRejectionReason("   ").ok, false);
  assert.deepEqual(
    validateRejectionReason("  Nothing has arrived in my bank yet.  "),
    { ok: true, reason: "Nothing has arrived in my bank yet." },
  );
  assert.equal(validateRejectionReason("x".repeat(501)).ok, false);
  assert.equal(validateRejectionReason("x".repeat(500)).ok, true);
  assert.equal(validateRejectionReason("line one\nline two").ok, true, "a typed sentence may wrap");
  assert.equal(validateRejectionReason(`bad${String.fromCharCode(0)}null`).ok, false);
});

test("labels stay in plain language", () => {
  assert.deepEqual(
    (["pending", "partially_confirmed", "confirmed", "rejected", "voided"] as const).map(paymentStatusLabel),
    ["Awaiting confirmation", "Part received", "Received", "Not received", "Cancelled"],
  );
});

test("review failures are translated, never echoed", () => {
  assert.match(reviewPaymentError("42501"), /Only the person this payment was sent to/);
  assert.match(reviewPaymentError("23514"), /changed since you opened it/);
  assert.match(reviewPaymentError("42P01"), /payment confirmations migration/);
  assert.match(reviewPaymentError(), /could not be saved/);
});

test("the status ladder matches the generated column in migration 021", () => {
  // If the SQL changes shape, this file is wrong until somebody looks at both.
  const migration = readFileSync(
    join(process.cwd(), "supabase", "migrations", "202608100021_add_payment_confirmations.sql"),
    "utf8",
  );
  const generated = migration.slice(
    migration.indexOf("generated always as ("),
    migration.indexOf(") stored;"),
  );

  assert.match(generated, /when voided_at is not null then 'voided'/);
  assert.match(generated, /when confirmed_amount_pennies >= amount_pennies then 'confirmed'/);
  assert.match(generated, /when confirmed_amount_pennies > 0 then 'partially_confirmed'/);
  assert.match(generated, /when rejected_at is not null then 'rejected'/);
  assert.match(generated, /else 'pending'/);

  // The order of the cases is the behaviour, not a detail: voided must win over
  // confirmed, and confirmed over rejected.
  const order = ["'voided'", "'confirmed'", "'partially_confirmed'", "'rejected'", "'pending'"]
    .map((value) => generated.indexOf(value));
  assert.deepEqual([...order].sort((left, right) => left - right), order);
});

test("an admin-confirmed payment is identifiable from its receipts alone", () => {
  assert.equal(isAdminConfirmed([]), false);
  assert.equal(isAdminConfirmed([{ source: "review" }, { source: "auto_receipt" }]), false);
  assert.equal(isAdminConfirmed([{ source: "migration" }]), false, "history is not an override");
  assert.equal(isAdminConfirmed([{ source: "review" }, { source: "admin_override" }]), true);

  // The status itself is unaffected: an override produces an ordinary
  // "confirmed" payment, and it is the receipt that says how it got there.
  assert.equal(paymentStatusOf({ amountPennies: 2_000, confirmedAmountPennies: 2_000 }), "confirmed");
});

test("admin override failures are translated, and name the two refusals apart", () => {
  assert.match(
    adminPaymentError("42501", "You cannot confirm your own payment. Record it normally..."),
    /cannot confirm your own payment/,
  );
  assert.match(adminPaymentError("42501", "Only Global Admin can record a confirmed payment"), /Only Global Admin/);
  assert.match(adminPaymentError("23514"), /does not fit the current balance/);
  assert.match(adminPaymentError("42P01"), /admin payment override migration/i);
  assert.match(adminPaymentError(), /could not be recorded/);
});
