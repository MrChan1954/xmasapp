"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { formatPennies } from "../../lib/currency";
import { INPUT_LIMITS, validateEnum, validateUuid } from "../../lib/input-validation";
import { paymentStatusLabel, type PaymentStatus } from "../../lib/payment-confirmation";
import {
  activePaymentFilterCount,
  adminOverrideReason,
  emptyPaymentFilters,
  filterPaymentRecords,
  isAdminConfirmedPayment,
  paymentStatus,
  sortPaymentRecords,
  summarizePaymentRecords,
  unconfirmedAmountPennies,
  type PaymentLogFilters,
  type PaymentLogRecord,
  type PaymentLogResponse,
  type PaymentQuickFilter,
  type PaymentSortDirection,
  type PaymentSortKey,
} from "../../lib/payment-log";
import { AppShell, PageHeader } from "../components/app-shell";
import { IconFilter } from "../components/icons";
import { Popover } from "../components/popover";
import {
  Badge,
  Button,
  ChipRow,
  ConfirmDialog,
  DataCards,
  DataList,
  DataRow,
  DataTable,
  EmptyState,
  FilterChip,
  Input,
  Modal,
  ModalHeader,
  Notice,
  Select,
  Sheet,
  SheetFooter,
  SheetHeader,
  Skeleton,
  Toolbar,
  cx,
  type Column,
} from "../components/ui";
import { eventRealtimeSources, useRealtimeRefresh } from "../components/use-realtime-refresh";

type SortState = { key: PaymentSortKey; direction: PaymentSortDirection };

const quickFilters: { value: PaymentQuickFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "pending", label: "Awaiting confirmation" },
  { value: "confirmed", label: "Received" },
  { value: "rejected", label: "Not received" },
  { value: "voided", label: "Cancelled" },
];

const personalQuickFilters: { value: PaymentQuickFilter; label: string }[] = [
  { value: "paid_by_me", label: "Paid by me" },
  { value: "paid_to_me", label: "Paid to me" },
  { value: "recorded_by_me", label: "Recorded by me" },
  { value: "awaiting_my_confirmation", label: "Waiting on me" },
];

/** Every status a record can hold, in the order the filter should offer them. */
const statusOptions: PaymentStatus[] = ["pending", "partially_confirmed", "confirmed", "rejected", "voided"];

/** The Payment Log for one event. */
export function PaymentLogScreen({ eventId, eventName }: { eventId: string; eventName: string }) {
  const [data, setData] = useState<PaymentLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<PaymentLogFilters>(emptyPaymentFilters);
  const [mobileFilters, setMobileFilters] = useState<PaymentLogFilters | null>(null);
  const [sort, setSort] = useState<SortState>({ key: "paymentDate", direction: "desc" });
  const [selected, setSelected] = useState<PaymentLogRecord | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const loaded = await requestPaymentLog(eventId);
    setData(loaded);
    return loaded;
  }, [eventId]);

  useEffect(() => {
    let active = true;
    requestPaymentLog(eventId)
      .then((loaded) => { if (active) setData(loaded); })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Payment Log could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [eventId]);

  // The log lists settlements, and each record's context comes from the purchases
  // and people behind it. `refresh` leaves `loading` alone, so this updates the
  // list without replacing it with a spinner.
  useRealtimeRefresh(
    eventRealtimeSources(["settlements", "purchases", "purchase_allocations", "people"], eventId),
    refresh,
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    return sortPaymentRecords(filterPaymentRecords(data.records, filters, {
      today: data.today,
      currentContributorId: data.currentContributorId,
      currentAppMemberId: data.currentAppMemberId,
    }), sort.key, sort.direction);
  }, [data, filters, sort]);
  const summary = summarizePaymentRecords(filtered);
  const filterCount = activePaymentFilterCount(filters);

  const changeSort = (key: PaymentSortKey) => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
  }));

  const openDetail = (record: PaymentLogRecord, source: HTMLElement) => {
    returnFocus.current = source;
    setSelected(record);
  };

  // One definition drives the desktop table and the mobile cards' sort keys.
  const columns: Column<PaymentLogRecord>[] = [
    { key: "paymentDate", header: "Payment date", sortable: true, cell: (record) => <span className="font-medium whitespace-nowrap">{formatPaymentDate(record.paymentDate)}</span> },
    { key: "payerName", header: "From", sortable: true, cell: (record) => <span className="font-medium">{record.payerName}</span> },
    { key: "payeeName", header: "To", sortable: true, cell: (record) => <span className="font-medium">{record.payeeName}</span> },
    { key: "amountPennies", header: "Claimed", sortable: true, align: "right", cell: (record) => <span className="font-semibold whitespace-nowrap">{formatPennies(record.amountPennies)}</span> },
    {
      key: "confirmedAmountPennies",
      header: "Confirmed",
      sortable: true,
      align: "right",
      cell: (record) => (
        <span className="whitespace-nowrap">
          <span className="font-semibold">{formatPennies(record.confirmedAmountPennies)}</span>
          {unconfirmedAmountPennies(record) > 0 && !record.voidedAt && (
            <span className="block text-xs text-ink-600">{formatPennies(unconfirmedAmountPennies(record))} unconfirmed</span>
          )}
        </span>
      ),
    },
    { key: "recordedByName", header: "Recorded by", sortable: true, cell: (record) => <span className="text-ink-600">{record.recordedByName}</span> },
    { key: "recordedAt", header: "Recorded at", sortable: true, cell: (record) => <span className="text-xs whitespace-nowrap text-ink-600">{formatRecordedAt(record.recordedAt)}</span> },
    { key: "status", header: "Status", sortable: true, cell: (record) => <StatusBadge record={record} /> },
    { key: "notes", header: "Notes", cell: (record) => <span className="block max-w-56 truncate text-ink-600" title={record.notes ?? undefined}>{record.notes || "—"}</span> },
    {
      key: "actions",
      header: "",
      cell: (record) => (
        <Button variant="secondary" size="sm" onClick={(event) => { event.stopPropagation(); openDetail(record, event.currentTarget); }}>View</Button>
      ),
    },
  ];
  const closeDetail = () => {
    setSelected(null);
    window.requestAnimationFrame(() => returnFocus.current?.focus());
  };

  return (
    <AppShell width="wide">
      <PageHeader
        eyebrow={eventName}
        title="Payment Log"
        description="A permanent audit record of payments recorded in Owed."
        actions={!loading && data ? (
          <div className="flex items-center gap-2">
            <p className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink-600">
              {filterCount ? `${filtered.length} of ${data.records.length}` : data.records.length} {data.records.length === 1 ? "record" : "records"}
            </p>
            <Button
              variant="secondary"
              disabled={refreshing}
              onClick={() => { setRefreshing(true); void refresh().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Payment Log could not be refreshed.")).finally(() => setRefreshing(false)); }}
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        ) : undefined}
      />

      {error && (
        <div className="mt-6 rounded-2xl border border-berry-soft-border bg-berry-soft p-4">
          <p role="alert" className="text-sm font-medium text-berry">{error}</p>
          <Button
            variant="secondary"
            onClick={() => { setLoading(true); void refresh().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Payment Log could not be loaded.")).finally(() => setLoading(false)); }}
            className="mt-3"
          >
            Try again
          </Button>
        </div>
      )}
      {loading && <PaymentLogSkeleton />}

      {!loading && data && <>
        <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="Confirmed received" value={formatPennies(summary.confirmedAmountPennies)} detail="The only money that has changed a balance" primary />
          <SummaryCard label="Awaiting confirmation" value={formatPennies(summary.awaitingAmountPennies)} detail={summary.awaitingCount ? `${summary.awaitingCount} ${summary.awaitingCount === 1 ? "payment" : "payments"} waiting` : "Nothing waiting in this view"} />
          <SummaryCard label="Records" value={String(summary.recordCount)} detail={summary.rejectedCount ? `${summary.rejectedCount} marked not received` : "Every record is kept"} />
          <SummaryCard label="Cancelled" value={String(summary.voidedCount)} detail={summary.voidedCount ? `${formatPennies(summary.voidedAmountPennies)} retained in history` : "No cancelled records in this view"} />
        </section>

        <Toolbar
          className="mt-6"
          start={
            <>
              <Button variant="secondary" onClick={() => setMobileFilters({ ...filters })} className="lg:hidden">
                <IconFilter size={17} />
                Filters{filterCount ? ` (${filterCount})` : ""}
              </Button>

              {/* A permanently open filter panel ate ~200px above the table; the
                  same fields now live behind a disclosure in the toolbar. */}
              <Popover
                label="Payment Log filters"
                align="start"
                className="hidden lg:block"
                panelClassName="w-[46rem] p-4"
                trigger={({ open }) => (
                  <span className={cx(
                    "flex min-h-11 items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold",
                    open || filterCount ? "border-accent-soft-border bg-accent-soft text-accent" : "border-line bg-surface text-ink-600 hover:border-line-strong",
                  )}>
                    <IconFilter size={17} />
                    Filters{filterCount ? ` (${filterCount})` : ""}
                  </span>
                )}
              >
                <div className="flex items-center justify-between gap-4">
                  <p className="text-xs font-semibold tracking-eyebrow text-gold uppercase">Audit tools</p>
                  <Button variant="ghost" size="sm" onClick={() => setFilters(emptyPaymentFilters)} disabled={!filterCount}>Clear filters</Button>
                </div>
                <FilterFields filters={filters} setFilters={setFilters} data={data} />
              </Popover>

              <QuickFilters value={filters.quick} onChange={(quick) => setFilters((current) => ({ ...current, quick }))} />
            </>
          }
        />

        <ActiveFilterChips filters={filters} data={data} onChange={setFilters} />

        <div className="mt-5">
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(record) => record.id}
            sort={sort}
            onSort={(key) => changeSort(key as PaymentSortKey)}
            onRowActivate={openDetail}
            empty={<NoMatches onClear={() => setFilters(emptyPaymentFilters)} />}
          />
          <DataCards
            rows={filtered}
            rowKey={(record) => record.id}
            onRowActivate={openDetail}
            empty={<NoMatches onClear={() => setFilters(emptyPaymentFilters)} />}
            renderCard={(record) => (
              <>
                <div className="flex items-center justify-between gap-3">
                  <time className="text-xs font-medium text-ink-600">{formatPaymentDate(record.paymentDate)}</time>
                  <StatusBadge record={record} />
                </div>
                <div className="mt-2 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{record.payerName} <span aria-hidden className="px-1 text-ink-400">→</span> {record.payeeName}</p>
                    <p className="mt-1 truncate text-xs text-ink-600">
                      {record.confirmedAmountPennies === record.amountPennies
                        ? `Recorded by ${record.recordedByName}`
                        : `${formatPennies(record.confirmedAmountPennies)} confirmed of ${formatPennies(record.amountPennies)}`}
                    </p>
                  </div>
                  <strong className="shrink-0 font-display text-lg font-semibold tabular-nums text-ink-900">{formatPennies(record.amountPennies)}</strong>
                </div>
              </>
            )}
          />
        </div>

        {mobileFilters && <MobileFilterSheet draft={mobileFilters} setDraft={setMobileFilters} data={data} onClose={() => setMobileFilters(null)} onApply={() => { setFilters(mobileFilters); setMobileFilters(null); }} />}
        {selected && <PaymentDetail record={selected} isAdmin={data.isAdmin} onClose={closeDetail} onVoided={async () => { const loaded = await refresh(); const updated = loaded.records.find((record) => record.id === selected.id); if (updated) setSelected(updated); }} />}
      </>}
    </AppShell>
  );
}

function FilterFields({ filters, setFilters, data }: { filters: PaymentLogFilters; setFilters: (value: PaymentLogFilters | ((current: PaymentLogFilters) => PaymentLogFilters)) => void; data: PaymentLogResponse }) {
  const update = <Key extends keyof PaymentLogFilters>(key: Key, value: PaymentLogFilters[Key]) => setFilters((current) => ({ ...current, [key]: value }));
  const compact = "h-11 rounded-lg px-3 text-sm";
  return <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-7">
    <label className="block text-xs font-semibold xl:col-span-2">Search
      <Input type="search" maxLength={INPUT_LIMITS.search} value={filters.search} onChange={(event) => update("search", event.target.value)} placeholder="Names or notes" className={cx("mt-1.5 font-normal", compact)} />
    </label>
    <FilterSelect label="From" value={filters.payerContributorId} onChange={(value) => update("payerContributorId", value)} options={data.contributors} allLabel="All payers" />
    <FilterSelect label="To" value={filters.payeeContributorId} onChange={(value) => update("payeeContributorId", value)} options={data.contributors} allLabel="All receivers" />
    <label className="block text-xs font-semibold">Status
      <Select value={filters.status} onChange={(event) => { const status = validateEnum(event.target.value, ["all", ...statusOptions] as const, "Invalid status."); if (status.ok) update("status", status.value); }} className={cx("mt-1.5 font-normal", compact)}>
        <option value="all">All statuses</option>
        {statusOptions.map((status) => <option key={status} value={status}>{paymentStatusLabel(status)}</option>)}
      </Select>
    </label>
    <FilterSelect label="Recorded by" value={filters.recordedByAppMemberId} onChange={(value) => update("recordedByAppMemberId", value)} options={data.recorders} allLabel="All recorders" />
    <div className="grid grid-cols-2 gap-2 xl:col-span-2">
      <label className="block text-xs font-semibold">Date from
        <Input type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(event) => update("dateFrom", event.target.value)} className={cx("mt-1.5 min-h-11 font-normal", compact)} />
      </label>
      <label className="block text-xs font-semibold">Date to
        <Input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(event) => update("dateTo", event.target.value)} className={cx("mt-1.5 min-h-11 font-normal", compact)} />
      </label>
    </div>
  </div>;
}

function FilterSelect({ label, value, onChange, options, allLabel }: { label: string; value: string; onChange: (value: string) => void; options: { id: string; name: string }[]; allLabel: string }) {
  return <label className="block text-xs font-semibold">{label}
    <Select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1.5 h-11 rounded-lg px-3 text-sm font-normal">
      <option value="">{allLabel}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
    </Select>
  </label>;
}

function QuickFilters({ value, onChange }: { value: PaymentQuickFilter; onChange: (value: PaymentQuickFilter) => void }) {
  return (
    <ChipRow label="Quick filters">
      {[...quickFilters, ...personalQuickFilters].map((filter) => (
        <FilterChip key={filter.value} active={value === filter.value} onClick={() => onChange(filter.value)}>
          {filter.label}
        </FilterChip>
      ))}
    </ChipRow>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      illustration="sleigh"
      title="No payments match these filters"
      body="Clear a filter or choose a different date range."
      action={<Button onClick={onClear}>Clear filters</Button>}
    />
  );
}

function ActiveFilterChips({ filters, data, onChange }: { filters: PaymentLogFilters; data: PaymentLogResponse; onChange: (filters: PaymentLogFilters) => void }) {
  const chips = [
    filters.search ? { key: "search", label: `Search: ${filters.search}` } : null,
    filters.payerContributorId ? { key: "payerContributorId", label: `From: ${optionName(data.contributors, filters.payerContributorId)}` } : null,
    filters.payeeContributorId ? { key: "payeeContributorId", label: `To: ${optionName(data.contributors, filters.payeeContributorId)}` } : null,
    filters.status !== "all" ? { key: "status", label: `Status: ${paymentStatusLabel(filters.status)}` } : null,
    filters.recordedByAppMemberId ? { key: "recordedByAppMemberId", label: `Recorded by: ${optionName(data.recorders, filters.recordedByAppMemberId)}` } : null,
    filters.dateFrom ? { key: "dateFrom", label: `From date: ${formatPaymentDate(filters.dateFrom)}` } : null,
    filters.dateTo ? { key: "dateTo", label: `To date: ${formatPaymentDate(filters.dateTo)}` } : null,
    filters.quick !== "all" ? { key: "quick", label: `Quick: ${[...quickFilters, ...personalQuickFilters].find((item) => item.value === filters.quick)?.label ?? filters.quick}` } : null,
  ].filter((chip): chip is { key: keyof PaymentLogFilters; label: string } => Boolean(chip));
  if (!chips.length) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-ink-600">Active filters:</span>
      {chips.map((chip) => (
        <button key={chip.key} type="button" onClick={() => onChange({ ...filters, [chip.key]: chip.key === "status" || chip.key === "quick" ? "all" : "" })} className="min-h-11 rounded-full border border-accent-soft-border bg-accent-soft px-3 text-xs font-semibold text-accent hover:border-accent/40">
          {chip.label} <span aria-hidden>×</span><span className="sr-only"> remove</span>
        </button>
      ))}
      <button type="button" onClick={() => onChange(emptyPaymentFilters)} className="min-h-11 px-2 text-xs font-semibold text-berry">Clear all</button>
    </div>
  );
}

function MobileFilterSheet({ draft, setDraft, data, onClose, onApply }: { draft: PaymentLogFilters; setDraft: (filters: PaymentLogFilters | null) => void; data: PaymentLogResponse; onClose: () => void; onApply: () => void }) {
  return (
    <Sheet labelledBy="mobile-filters-title" onClose={onClose} size="lg" className="lg:hidden">
      <SheetHeader id="mobile-filters-title" title="Filters" description="Narrow the payment log." onClose={onClose} />
      <div className="px-5 pb-4 sm:px-6">
        <QuickFilters value={draft.quick} onChange={(quick) => setDraft({ ...draft, quick })} />
        <FilterFields filters={draft} setFilters={(next) => setDraft(typeof next === "function" ? next(draft) : next)} data={data} />
      </div>
      <SheetFooter>
        <Button variant="secondary" size="lg" onClick={() => setDraft({ ...emptyPaymentFilters })}>Clear</Button>
        <Button size="lg" onClick={onApply}>Apply filters</Button>
      </SheetFooter>
    </Sheet>
  );
}

function PaymentDetail({ record, isAdmin, onClose, onVoided }: { record: PaymentLogRecord; isAdmin: boolean; onClose: () => void; onVoided: () => Promise<void> }) {
  const [voiding, setVoiding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const voidPayment = async () => {
    setVoiding(true); setError(null);
    const validId = validateUuid(record.id, "This payment record is invalid.");
    if (!validId.ok) { setError(validId.error); setVoiding(false); setConfirming(false); return; }
    const result = await createClient().rpc("void_settlement", { p_settlement_id: validId.value });
    if (result.error) { setError(result.error.code === "42501" ? "Only this family’s admin can void a payment." : "This payment could not be voided. Nothing was changed."); setVoiding(false); setConfirming(false); return; }
    try {
      await onVoided();
    } catch {
      setError("The payment was voided, but the log could not refresh. Close this detail and refresh the Payment Log.");
    } finally {
      setVoiding(false);
      setConfirming(false);
    }
  };
  return (
    <Modal labelledBy="payment-detail-title" onClose={onClose} size="lg" dismissible={!confirming}>
      <ModalHeader
        id="payment-detail-title"
        eyebrow="Payment details"
        title={`${record.payerName} → ${record.payeeName}`}
        description={record.eventName}
        onClose={onClose}
        closeLabel="Close payment details"
      />
      <div className="px-5 pb-6 sm:px-7 sm:pb-7">
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        <div className="dark rounded-2xl border border-pine-700 bg-linear-to-br from-pine-900 to-pine-800 p-5 text-white">
          <p className="text-xs font-medium text-pine-100">Claimed by {record.payerName}</p>
          <p className="mt-1 font-display text-4xl font-semibold tabular-nums">{formatPennies(record.amountPennies)}</p>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-pine-700 pt-3">
            <div>
              <p className="text-xs font-medium text-pine-100">Confirmed received</p>
              <p className="mt-1 font-display text-xl font-semibold tabular-nums">{formatPennies(record.confirmedAmountPennies)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-pine-100">Still unconfirmed</p>
              <p className="mt-1 font-display text-xl font-semibold tabular-nums">{formatPennies(unconfirmedAmountPennies(record))}</p>
            </div>
          </div>
          <div className="mt-4"><StatusBadge record={record} /></div>
        </div>
        <DataList className="mt-5 rounded-2xl border border-line bg-surface px-5">
          <DataRow label="Paid by" value={record.payerName} />
          <DataRow label="Paid to" value={record.payeeName} />
          <DataRow label="Payment date" value={formatPaymentDate(record.paymentDate)} />
          <DataRow label={record.voidedAt ? "Originally recorded by" : "Recorded by"} value={record.recordedByName} />
          <DataRow label={record.voidedAt ? "Originally recorded at" : "Recorded at"} value={formatRecordedAtLong(record.recordedAt)} />
          <DataRow label="Notes" value={record.notes || "No notes were added."} />
          {record.lastReviewedAt && <DataRow label="Last reviewed at" value={formatRecordedAtLong(record.lastReviewedAt)} />}
          {record.reviewedByName && <DataRow label="Reviewed by" value={record.reviewedByName} />}
          {record.confirmedAt && <DataRow label="Confirmed in full at" value={formatRecordedAtLong(record.confirmedAt)} />}
          {record.rejectedAt && <DataRow label="Marked not received at" value={formatRecordedAtLong(record.rejectedAt)} />}
          {record.rejectionReason && <DataRow label="Reason given" value={record.rejectionReason} />}
          {record.voidedAt && <DataRow label="Cancelled at" value={formatRecordedAtLong(record.voidedAt)} />}
          {record.voidedAt && <DataRow label="Cancelled by" value={record.voidedByName || "Unknown member (record link missing)"} />}
        </DataList>

        {isAdminConfirmedPayment(record) && (
          <div className="mt-5 rounded-2xl border border-warning-border bg-gold-soft p-4">
            <h3 className="font-semibold">Admin confirmed payment</h3>
            <p className="mt-1 text-sm leading-6">
              This family&apos;s admin recorded this as already received, so {record.payeeName} was never asked to confirm it.
              It reduced the balance immediately.
            </p>
            {adminOverrideReason(record) && (
              <p className="mt-2 break-words text-sm"><span className="font-semibold">Reason: </span>{adminOverrideReason(record)}</p>
            )}
          </div>
        )}

        <section className="mt-5 rounded-2xl border border-line bg-surface p-5">
          <h3 className="font-display text-lg font-semibold">What happened</h3>
          <ol className="mt-3 space-y-3">
            <li className="flex items-start justify-between gap-4 border-b border-line pb-3">
              <div>
                <p className="text-sm font-semibold">{record.payerName} recorded a payment to {record.payeeName}</p>
                <p className="mt-0.5 text-xs text-ink-600">Recorded by {record.recordedByName} · {formatRecordedAt(record.recordedAt)}</p>
              </div>
              <strong className="shrink-0 text-sm font-semibold tabular-nums">{formatPennies(record.amountPennies)}</strong>
            </li>
            {record.receipts.map((receipt) => (
              <li key={receipt.id} className="flex items-start justify-between gap-4 border-b border-line pb-3 last:border-0 last:pb-0">
                <div>
                  <p className="text-sm font-semibold">
                    {receipt.source === "migration"
                      ? "Recorded by the receiver before confirmations existed"
                      : receipt.source === "admin_override"
                        ? `${receipt.actedByName} recorded this as confirmed (admin override)`
                        : receipt.action === "confirm"
                          ? `${receipt.reviewerName} confirmed money arrived`
                          : `${receipt.reviewerName} said this had not arrived`}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-600">{formatRecordedAt(receipt.createdAt)}</p>
                  {receipt.reason && <p className="mt-1 break-words text-sm">{receipt.reason}</p>}
                </div>
                <strong className="shrink-0 text-sm font-semibold tabular-nums">{formatPennies(receipt.amountPennies)}</strong>
              </li>
            ))}
            {record.receipts.length === 0 && (
              <li className="text-sm text-ink-600">Nobody has reviewed this payment yet.</li>
            )}
          </ol>
        </section>
        {isAdmin && !record.voidedAt && (
          <div className="mt-5 rounded-2xl border border-berry-soft-border bg-berry-soft p-4">
            <h3 className="font-semibold text-berry">Correction</h3>
            <p className="mt-1 text-xs leading-5 text-ink-600">Voiding keeps this record in the log and restores any confirmed amount to the Owed balance.</p>
            <Button variant="danger" size="lg" disabled={voiding} onClick={() => setConfirming(true)} className="mt-3 w-full">
              {voiding ? "Voiding payment..." : "Void payment"}
            </Button>
          </div>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title="Void payment?"
          body={<>
            <p className="font-semibold text-ink-900">{record.payerName} → {record.payeeName} · {formatPennies(record.amountPennies)}</p>
            <p className="mt-2">
              {record.confirmedAmountPennies > 0
                ? `This returns the ${formatPennies(record.confirmedAmountPennies)} already confirmed to the outstanding balance.`
                : "Nothing was confirmed, so no balance changes."} The record stays in the log.
            </p>
          </>}
          confirmLabel="Void payment"
          busyLabel="Voiding..."
          busy={voiding}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void voidPayment()}
        />
      )}
    </Modal>
  );
}



/**
 * The status, plus a second badge when an admin was the one who confirmed it.
 *
 * A payment settled by an override must never be indistinguishable from one the
 * receiver agreed to. Two badges is the whole mechanism: the money reads the
 * same, and how it got there does not.
 */
function StatusBadge({ record }: { record: PaymentLogRecord }) {
  const status = paymentStatus(record);
  const tone = status === "confirmed"
    ? "success"
    : status === "rejected" ? "danger" : status === "voided" ? "neutral" : status === "partially_confirmed" ? "gold" : "warning";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={tone}>{paymentStatusLabel(status)}</Badge>
      {isAdminConfirmedPayment(record) && <Badge tone="gold">Admin confirmed</Badge>}
    </span>
  );
}

function SummaryCard({ label, value, detail, primary = false }: { label: string; value: string; detail?: string; primary?: boolean }) {
  return (
    <div className={cx("rounded-2xl border p-5 shadow-card", primary ? "dark border-pine-700 bg-linear-to-br from-pine-900 to-pine-800 text-white" : "border-line bg-surface")}>
      <p className={cx("text-sm font-medium", primary ? "text-pine-100" : "text-ink-600")}>{label}</p>
      <p className="mt-2 font-display text-3xl font-semibold tabular-nums">{value}</p>
      {detail && <p className={cx("mt-1 text-xs", primary ? "text-pine-100/90" : "text-ink-600")}>{detail}</p>}
    </div>
  );
}

function PaymentLogSkeleton() {
  return (
    <div className="mt-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
      <Skeleton className="mt-5 h-80 rounded-2xl" />
    </div>
  );
}

async function requestPaymentLog(eventId: string) {
  const response = await fetch(`/api/payment-log?event=${encodeURIComponent(eventId)}`, { cache: "no-store" });
  const body = await response.json().catch(() => null) as PaymentLogResponse | { error?: string } | null;
  if (!response.ok) throw new Error(body && "error" in body && body.error ? body.error : "Payment Log could not be loaded.");
  return body as PaymentLogResponse;
}

function optionName(options: { id: string; name: string }[], id: string) { return options.find((option) => option.id === id)?.name ?? "Unknown selection"; }
function formatPaymentDate(value: string) { const date = new Date(`${value}T12:00:00`); return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date); }
function formatRecordedAt(value: string) { return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatRecordedAtLong(value: string) { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
