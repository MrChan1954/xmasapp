/**
 * The state of one recorded payment, and the rules for reviewing it.
 *
 * Everything here is pure: a claim in, a status or a validation result out. No
 * database, no session, no React. The Owed screen, the Payment Log and the
 * notification dispatcher all read a payment's state through this file, so
 * "partly confirmed" means exactly one thing across the whole app.
 *
 * THIS FILE IS A MIRROR, NOT A SECOND OPINION.
 *
 *   * `paymentStatusOf` reproduces the `settlements.status` generated column
 *     from migration 021, case for case. The database is authoritative; this
 *     exists so a screen can label a row it is already holding without a round
 *     trip, and the test suite asserts the two agree.
 *   * `validateConfirmationAmount` reproduces the bounds `review_payment`
 *     enforces. It exists to give a person a sentence they can act on before
 *     they press the button, and NOT as the thing that keeps the figure honest
 *     -- the RPC re-checks under a row lock, and the table has a CHECK
 *     constraint underneath that.
 *
 * Nothing here calculates a balance. Owed lives in `owed.ts` and takes
 * `confirmedAmountPennies` as its input.
 */

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { formatPennies } from "./currency.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { parsePoundsToPennies } from "./purchases.ts";

export type PaymentStatus =
  | "pending"
  | "partially_confirmed"
  | "confirmed"
  | "rejected"
  | "voided";

/**
 * How an acknowledgement came about.
 *
 *   review          the receiver pressed a button
 *   auto_receipt    the receiver recorded the payment themselves
 *   migration       the payment predates confirmations entirely
 *   admin_override  a Global Admin recorded it as confirmed, with a written
 *                   reason, without the receiver confirming anything
 */
export type PaymentReceiptSource = "review" | "auto_receipt" | "migration" | "admin_override";

/** The minimum a caller must know about a payment to reason about its state. */
export type PaymentClaim = {
  /** What the payer says they sent. Never rewritten by a review. */
  amountPennies: number;
  /** What the receiver has acknowledged arriving, in total, so far. */
  confirmedAmountPennies: number;
  rejectedAt?: string | null;
  voidedAt?: string | null;
};

export const REJECTION_REASON_MAX_LENGTH = 500;

/**
 * Newlines and tabs are fine in a sentence somebody typed; other control
 * characters are not. Same rule as `settlements_rejection_reason_safe_check`
 * and as `validateOptionalText`'s multiline mode.
 */
const DISALLOWED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

/**
 * Exactly the `settlements.status` CASE from migration 021.
 *
 * The order matters and is not alphabetical: voided beats everything because a
 * voided row affects nothing, and "confirmed in full" beats a rejection because
 * a payment cannot be both fully received and not received.
 */
export function paymentStatusOf(claim: PaymentClaim): PaymentStatus {
  if (claim.voidedAt) return "voided";
  if (claim.confirmedAmountPennies >= claim.amountPennies) return "confirmed";
  if (claim.confirmedAmountPennies > 0) return "partially_confirmed";
  if (claim.rejectedAt) return "rejected";
  return "pending";
}

/** What the receiver has not yet acknowledged. Never negative. */
export function unconfirmedPennies(claim: PaymentClaim): number {
  return Math.max(0, claim.amountPennies - claim.confirmedAmountPennies);
}

/**
 * Whether this payment is still waiting on its receiver.
 *
 * A rejection closes the remainder, so a partly confirmed payment whose
 * remainder was rejected is finished even though some of it was never
 * confirmed.
 */
export function isAwaitingReview(claim: PaymentClaim): boolean {
  return !claim.voidedAt && !claim.rejectedAt && unconfirmedPennies(claim) > 0;
}

/**
 * Whether a payment was confirmed by a Global Admin rather than by the person
 * who was supposed to receive it.
 *
 * Read from the receipts, which are the record of what actually happened, so a
 * screen cannot show "Received" for money nobody acknowledged.
 */
export function isAdminConfirmed(receipts: readonly { source: PaymentReceiptSource }[]): boolean {
  return receipts.some((receipt) => receipt.source === "admin_override");
}

/** Plain-language labels. No accounting jargon anywhere in the UI. */
export function paymentStatusLabel(status: PaymentStatus): string {
  if (status === "confirmed") return "Received";
  if (status === "partially_confirmed") return "Part received";
  if (status === "rejected") return "Not received";
  if (status === "voided") return "Cancelled";
  return "Awaiting confirmation";
}

/** How a payer should read their own record at a glance. */
export function payerStatusSummary(claim: PaymentClaim): string {
  const status = paymentStatusOf(claim);
  if (status === "confirmed") return `${formatPennies(claim.amountPennies)} received`;
  if (status === "partially_confirmed") {
    return `${formatPennies(claim.confirmedAmountPennies)} of ${formatPennies(claim.amountPennies)} received`;
  }
  if (status === "rejected") return "Not received";
  if (status === "voided") return "Cancelled";
  return "Awaiting confirmation";
}

export type AmountValidation =
  | { ok: true; pennies: number }
  | { ok: false; error: string };

/**
 * "How much did you receive?"
 *
 * Penny-safe by construction: the text is parsed to whole pennies by the same
 * parser the purchase form uses, so 1.50 is 150 pennies and never 149.99999.
 */
export function validateConfirmationAmount(
  input: string,
  claim: PaymentClaim,
): AmountValidation {
  const remaining = unconfirmedPennies(claim);
  if (remaining <= 0) {
    return { ok: false, error: "This payment has already been confirmed in full." };
  }

  const parsed = parsePoundsToPennies(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.pennies <= 0) {
    return { ok: false, error: `Enter an amount greater than ${formatPennies(0)}.` };
  }
  if (parsed.pennies > remaining) {
    return {
      ok: false,
      error: `You can confirm up to ${formatPennies(remaining)}, which is the amount still unconfirmed.`,
    };
  }
  return { ok: true, pennies: parsed.pennies };
}

export type ReasonValidation =
  | { ok: true; reason: string }
  | { ok: false; error: string };

/**
 * A rejection must say something. "Not received" with no explanation is the
 * kind of record that starts an argument nobody can settle later.
 */
export function validateRejectionReason(input: string): ReasonValidation {
  const reason = input.trim();
  if (!reason) {
    return { ok: false, error: "Say why the payment has not arrived." };
  }
  if (reason.length > REJECTION_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the reason under ${REJECTION_REASON_MAX_LENGTH} characters.`,
    };
  }
  if (DISALLOWED_CONTROL_CHARACTERS.test(reason)) {
    return { ok: false, error: "The reason contains unsupported characters." };
  }
  return { ok: true, reason };
}

/**
 * The error a failed `review_payment` call should be shown as.
 *
 * The RPC raises with real SQLSTATE codes, and the browser must not repeat the
 * database's own wording back to a family member.
 */
export function reviewPaymentError(code?: string): string {
  if (code === "42501") return "Only the person this payment was sent to can review it.";
  if (code === "P0002") return "This payment could not be found. Refresh and try again.";
  if (code === "23514") return "This payment has changed since you opened it. Refresh to see where it stands.";
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") {
    return "Payment confirmations are not ready yet. Apply the payment confirmations migration, then refresh.";
  }
  return "This review could not be saved. Nothing was changed.";
}

/**
 * The error a failed admin override should be shown as.
 *
 * `42501` covers two refusals the admin needs told apart from a general
 * permission problem: not being an admin at all, and being the payer — an admin
 * cannot confirm their own payment, which is the point of the whole feature.
 */
export function adminPaymentError(code?: string, message?: string): string {
  if (code === "42501") {
    return message?.includes("your own payment")
      ? "You cannot confirm your own payment. Record it normally and let the other person confirm it."
      : "Only this family’s admin can record a confirmed payment on behalf of others.";
  }
  if (code === "23514") return "That payment does not fit the current balance between these two people. Refresh and check what is outstanding.";
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") {
    return "Admin payment tools are not ready yet. Apply the admin payment override migration, then refresh.";
  }
  return "This payment could not be recorded. Nothing was changed.";
}
