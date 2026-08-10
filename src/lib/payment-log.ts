export type PaymentStatus = "paid" | "voided";

export type PaymentLogRecord = {
  id: string;
  eventYear: number;
  payerContributorId: string;
  payerName: string;
  payeeContributorId: string;
  payeeName: string;
  amountPennies: number;
  paymentDate: string;
  recordedByAppMemberId: string;
  recordedByName: string;
  recordedAt: string;
  notes: string | null;
  voidedAt: string | null;
  voidedByAppMemberId: string | null;
  voidedByName: string | null;
};

export type PaymentQuickFilter =
  | "all"
  | "today"
  | "week"
  | "month"
  | "paid"
  | "voided"
  | "paid_by_me"
  | "paid_to_me"
  | "recorded_by_me";

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

export function paymentStatus(record: PaymentLogRecord): PaymentStatus {
  return record.voidedAt ? "voided" : "paid";
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
    ].some((value) => value.toLocaleLowerCase("en-GB").includes(search))) return false;
    if (filters.payerContributorId && record.payerContributorId !== filters.payerContributorId) return false;
    if (filters.payeeContributorId && record.payeeContributorId !== filters.payeeContributorId) return false;
    if (filters.recordedByAppMemberId && record.recordedByAppMemberId !== filters.recordedByAppMemberId) return false;
    if (filters.status !== "all" && paymentStatus(record) !== filters.status) return false;
    if (filters.dateFrom && record.paymentDate < filters.dateFrom) return false;
    if (filters.dateTo && record.paymentDate > filters.dateTo) return false;
    if (quickRange && (record.paymentDate < quickRange.from || record.paymentDate > quickRange.to)) return false;
    if (filters.quick === "paid" && paymentStatus(record) !== "paid") return false;
    if (filters.quick === "voided" && paymentStatus(record) !== "voided") return false;
    if (filters.quick === "paid_by_me" && record.payerContributorId !== context.currentContributorId) return false;
    if (filters.quick === "paid_to_me" && record.payeeContributorId !== context.currentContributorId) return false;
    if (filters.quick === "recorded_by_me" && record.recordedByAppMemberId !== context.currentAppMemberId) return false;
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

export function summarizePaymentRecords(records: PaymentLogRecord[]) {
  return records.reduce(
    (summary, record) => {
      summary.recordCount += 1;
      if (record.voidedAt) {
        summary.voidedCount += 1;
        summary.voidedAmountPennies += record.amountPennies;
      } else {
        summary.activeAmountPennies += record.amountPennies;
      }
      return summary;
    },
    {
      activeAmountPennies: 0,
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

function comparePaymentValues(
  left: PaymentLogRecord,
  right: PaymentLogRecord,
  key: PaymentSortKey,
) {
  if (key === "amountPennies") return left.amountPennies - right.amountPennies;
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
