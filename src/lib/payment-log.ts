// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { isAdminConfirmed, paymentStatusOf, unconfirmedPennies, type PaymentReceiptSource, type PaymentStatus } from "./payment-confirmation.ts";

export type { PaymentStatus };

/** One review action in a payment's history. Append-only, oldest first. */
export type PaymentLogReceipt = {
  id: string;
  action: "confirm" | "reject";
  amountPennies: number;
  reason: string | null;
  source: PaymentReceiptSource;
  /** The member who acted. For an override that is the admin, not the receiver. */
  actedByName: string;
  reviewerName: string;
  createdAt: string;
};

/**
 * One payment, as the log shows it.
 *
 * `amountPennies` is what the payer CLAIMED and never changes.
 * `confirmedAmountPennies` is what the receiver has acknowledged. Keeping both
 * is the whole point: a £20 claim of which £12 arrived is not a £12 payment,
 * and the log has to be able to say so a year later.
 */
export type PaymentLogRecord = {
  id: string;
  eventYear: number;
  payerContributorId: string;
  payerName: string;
  payeeContributorId: string;
  payeeName: string;
  amountPennies: number;
  confirmedAmountPennies: number;
  paymentDate: string;
  recordedByAppMemberId: string;
  recordedByName: string;
  recordedAt: string;
  notes: string | null;
  status: PaymentStatus;
  confirmedAt: string | null;
  lastReviewedAt: string | null;
  reviewedByAppMemberId: string | null;
  reviewedByName: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  voidedAt: string | null;
  voidedByAppMemberId: string | null;
  voidedByName: string | null;
  receipts: PaymentLogReceipt[];
};

export type PaymentQuickFilter =
  | "all"
  | "today"
  | "week"
  | "month"
  | "pending"
  | "confirmed"
  | "rejected"
  | "voided"
  | "paid_by_me"
  | "paid_to_me"
  | "recorded_by_me"
  | "awaiting_my_confirmation";

export type PaymentLogFilters = {
  search: string;
  payerContributorId: string;
  payeeContributorId: string;
  status: "all" | PaymentStatus;
  recordedByAppMemberId: string;
  dateFrom: string;
  dateTo: string;
  quick: PaymentQuickFilter;
};

export type PaymentSortKey =
  | "paymentDate"
  | "payerName"
  | "payeeName"
  | "amountPennies"
  | "confirmedAmountPennies"
  | "recordedByName"
  | "recordedAt"
  | "status";

export type PaymentSortDirection = "asc" | "desc";

export type PaymentLogOption = { id: string; name: string };

export type PaymentLogResponse = {
  eventId: string;
  eventYear: number;
  today: string;
  currentContributorId: string;
  currentAppMemberId: string;
  isAdmin: boolean;
  contributors: PaymentLogOption[];
  recorders: PaymentLogOption[];
  records: PaymentLogRecord[];
};

export const emptyPaymentFilters: PaymentLogFilters = {
  search: "",
  payerContributorId: "",
  payeeContributorId: "",
  status: "all",
  recordedByAppMemberId: "",
  dateFrom: "",
  dateTo: "",
  quick: "all",
};

/**
 * The record's status.
 *
 * `status` arrives from the database's generated column; this recomputes it
 * from the same figures as a guard, so a stale or absent value can never make
 * the log disagree with the money it is printing next to it.
 */
export function paymentStatus(record: PaymentLogRecord): PaymentStatus {
  return paymentStatusOf(record);
}

/** What the receiver has not acknowledged. Zero once a payment is finished. */
export function unconfirmedAmountPennies(record: PaymentLogRecord): number {
  return unconfirmedPennies(record);
}

/** Still waiting on its receiver, as opposed to finished one way or the other. */
export function isAwaitingConfirmation(record: PaymentLogRecord): boolean {
  return !record.voidedAt && !record.rejectedAt && unconfirmedAmountPennies(record) > 0;
}

/**
 * Confirmed by a Global Admin rather than by the person being paid.
 *
 * The log must never let one of these pass for an ordinary confirmation, so
 * this drives a distinct badge rather than a footnote.
 */
export function isAdminConfirmedPayment(record: PaymentLogRecord): boolean {
  return isAdminConfirmed(record.receipts);
}

/** The admin's written justification, if this was an override. */
export function adminOverrideReason(record: PaymentLogRecord): string | null {
  return record.receipts.find((receipt) => receipt.source === "admin_override")?.reason ?? null;
}

export function filterPaymentRecords(
  records: PaymentLogRecord[],
  filters: PaymentLogFilters,
  context: {
    today: string;
    currentContributorId: string;
    currentAppMemberId: string;
  },
) {
  const search = filters.search.trim().toLocaleLowerCase("en-GB");
  const quickRange = quickDateRange(filters.quick, context.today);

  return records.filter((record) => {
    if (search && ![
      record.payerName,
      record.payeeName,
      record.recordedByName,
      record.notes ?? "",
      record.rejectionReason ?? "",
    ].some((value) => value.toLocaleLowerCase("en-GB").includes(search))) return false;
    if (filters.payerContributorId && record.payerContributorId !== filters.payerContributorId) return false;
    if (filters.payeeContributorId && record.payeeContributorId !== filters.payeeContributorId) return false;
    if (filters.recordedByAppMemberId && record.recordedByAppMemberId !== filters.recordedByAppMemberId) return false;
    if (filters.status !== "all" && paymentStatus(record) !== filters.status) return false;
    if (filters.dateFrom && record.paymentDate < filters.dateFrom) return false;
    if (filters.dateTo && record.paymentDate > filters.dateTo) return false;
    if (quickRange && (record.paymentDate < quickRange.from || record.paymentDate > quickRange.to)) return false;
    if (statusQuickFilter(filters.quick) && paymentStatus(record) !== statusQuickFilter(filters.quick)) return false;
    if (filters.quick === "paid_by_me" && record.payerContributorId !== context.currentContributorId) return false;
    if (filters.quick === "paid_to_me" && record.payeeContributorId !== context.currentContributorId) return false;
    if (filters.quick === "recorded_by_me" && record.recordedByAppMemberId !== context.currentAppMemberId) return false;
    if (filters.quick === "awaiting_my_confirmation"
      && (record.payeeContributorId !== context.currentContributorId || !isAwaitingConfirmation(record))) return false;
    return true;
  });
}

export function sortPaymentRecords(
  records: PaymentLogRecord[],
  key: PaymentSortKey,
  direction: PaymentSortDirection,
) {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...records].sort((left, right) => {
    const primary = comparePaymentValues(left, right, key);
    if (primary !== 0) return primary * multiplier;
    const recordedAt = right.recordedAt.localeCompare(left.recordedAt);
    if (recordedAt !== 0) return recordedAt;
    return left.id.localeCompare(right.id);
  });
}

/**
 * The figures above the table.
 *
 * `confirmedAmountPennies` is the only one that describes money that has
 * actually settled a debt; `awaitingAmountPennies` is what somebody has claimed
 * and nobody has agreed to yet. Showing a single "total paid" would merge the
 * two and undo the entire point of this screen.
 */
export function summarizePaymentRecords(records: PaymentLogRecord[]) {
  return records.reduce(
    (summary, record) => {
      summary.recordCount += 1;
      const status = paymentStatus(record);
      if (status === "voided") {
        summary.voidedCount += 1;
        summary.voidedAmountPennies += record.amountPennies;
        return summary;
      }
      summary.claimedAmountPennies += record.amountPennies;
      summary.confirmedAmountPennies += record.confirmedAmountPennies;
      if (status === "rejected") summary.rejectedCount += 1;
      if (isAwaitingConfirmation(record)) {
        summary.awaitingCount += 1;
        summary.awaitingAmountPennies += unconfirmedAmountPennies(record);
      }
      return summary;
    },
    {
      claimedAmountPennies: 0,
      confirmedAmountPennies: 0,
      awaitingAmountPennies: 0,
      awaitingCount: 0,
      rejectedCount: 0,
      recordCount: 0,
      voidedCount: 0,
      voidedAmountPennies: 0,
    },
  );
}

export function activePaymentFilterCount(filters: PaymentLogFilters) {
  return [
    filters.search,
    filters.payerContributorId,
    filters.payeeContributorId,
    filters.status === "all" ? "" : filters.status,
    filters.recordedByAppMemberId,
    filters.dateFrom,
    filters.dateTo,
    filters.quick === "all" ? "" : filters.quick,
  ].filter(Boolean).length;
}

/**
 * The status a quick filter stands for, or null when it is about something
 * else. "Part received" is deliberately not a chip: it is reachable from the
 * status dropdown, and a chip for it would crowd out the ones people use.
 */
function statusQuickFilter(quick: PaymentQuickFilter): PaymentStatus | null {
  return quick === "pending" || quick === "confirmed" || quick === "rejected" || quick === "voided"
    ? quick
    : null;
}

function comparePaymentValues(
  left: PaymentLogRecord,
  right: PaymentLogRecord,
  key: PaymentSortKey,
) {
  if (key === "amountPennies") return left.amountPennies - right.amountPennies;
  if (key === "confirmedAmountPennies") return left.confirmedAmountPennies - right.confirmedAmountPennies;
  if (key === "status") return paymentStatus(left).localeCompare(paymentStatus(right), "en-GB");
  return left[key].localeCompare(right[key], "en-GB", { sensitivity: "base" });
}

function quickDateRange(quick: PaymentQuickFilter, today: string) {
  if (quick !== "today" && quick !== "week" && quick !== "month") return null;
  if (quick === "today") return { from: today, to: today };

  const [year, month, day] = today.split("-").map(Number);
  const current = new Date(Date.UTC(year, month - 1, day));
  if (quick === "week") {
    const mondayOffset = (current.getUTCDay() + 6) % 7;
    const monday = new Date(current);
    monday.setUTCDate(current.getUTCDate() - mondayOffset);
    return { from: dateInput(monday), to: today };
  }
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

function dateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}
