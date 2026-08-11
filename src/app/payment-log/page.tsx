"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "../../../utils/supabase/client";
import { formatPennies } from "../../lib/currency";
import { INPUT_LIMITS, validateEnum, validateUuid } from "../../lib/input-validation";
import {
  activePaymentFilterCount,
  emptyPaymentFilters,
  filterPaymentRecords,
  paymentStatus,
  sortPaymentRecords,
  summarizePaymentRecords,
  type PaymentLogFilters,
  type PaymentLogRecord,
  type PaymentLogResponse,
  type PaymentQuickFilter,
  type PaymentSortDirection,
  type PaymentSortKey,
} from "../../lib/payment-log";
<<<<<<< HEAD
import { AppNav } from "../components/app-nav";
=======
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
import { useRealtimeRefresh } from "../components/use-realtime-refresh";
>>>>>>> 7534a2d (redesign and realtime)

type SortState = { key: PaymentSortKey; direction: PaymentSortDirection };

const quickFilters: { value: PaymentQuickFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "paid", label: "Paid" },
  { value: "voided", label: "Voided" },
];

const personalQuickFilters: { value: PaymentQuickFilter; label: string }[] = [
  { value: "paid_by_me", label: "Paid by me" },
  { value: "paid_to_me", label: "Paid to me" },
  { value: "recorded_by_me", label: "Recorded by me" },
];

export default function PaymentLogPage() {
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
    const loaded = await requestPaymentLog();
    setData(loaded);
    return loaded;
  }, []);

  useEffect(() => {
    let active = true;
    requestPaymentLog()
      .then((loaded) => { if (active) setData(loaded); })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Payment Log could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

<<<<<<< HEAD
=======
  // The log lists settlements, and each record's context comes from the purchases
  // and people behind it. `refresh` leaves `loading` alone, so this updates the
  // list without replacing it with a spinner.
  useRealtimeRefresh(["settlements", "purchases", "purchase_allocations", "people"], refresh);

>>>>>>> 7534a2d (redesign and realtime)
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
<<<<<<< HEAD
=======

  // One definition drives the desktop table and the mobile cards' sort keys.
  const columns: Column<PaymentLogRecord>[] = [
    { key: "paymentDate", header: "Payment date", sortable: true, cell: (record) => <span className="font-medium whitespace-nowrap">{formatPaymentDate(record.paymentDate)}</span> },
    { key: "payerName", header: "From", sortable: true, cell: (record) => <span className="font-medium">{record.payerName}</span> },
    { key: "payeeName", header: "To", sortable: true, cell: (record) => <span className="font-medium">{record.payeeName}</span> },
    { key: "amountPennies", header: "Amount", sortable: true, align: "right", cell: (record) => <span className="font-semibold whitespace-nowrap">{formatPennies(record.amountPennies)}</span> },
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
>>>>>>> 7534a2d (redesign and realtime)
  const closeDetail = () => {
    setSelected(null);
    window.requestAnimationFrame(() => returnFocus.current?.focus());
  };

<<<<<<< HEAD
  return <main className="flex min-h-screen bg-[#f7f6f1] text-[#1d2926]">
    <AppNav />
    <div className="min-w-0 flex-1 pb-28 lg:pb-10">
      <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <header className="flex flex-wrap items-end justify-between gap-5">
          <div><p className="text-sm font-semibold text-[#a64235]">Christmas 2026</p><h1 className="mt-1 text-4xl font-bold tracking-tight">Payment Log</h1><p className="mt-2 text-sm text-[#75807c]">A permanent audit record of payments recorded in Owed.</p></div>
          {!loading && data && <div className="flex items-center gap-2"><p className="rounded-full border border-[#dedfd7] bg-white px-4 py-2 text-sm font-semibold text-[#63706b]">{filterCount ? `${filtered.length} of ${data.records.length}` : data.records.length} {data.records.length === 1 ? "record" : "records"}</p><button type="button" disabled={refreshing} onClick={() => { setRefreshing(true); void refresh().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Payment Log could not be refreshed.")).finally(() => setRefreshing(false)); }} className="min-h-10 rounded-xl border border-[#cbd8d3] bg-white px-3 text-xs font-bold text-[#174f45] disabled:opacity-50">{refreshing ? "Refreshing..." : "Refresh"}</button></div>}
        </header>

        {error && <div className="mt-6 rounded-2xl border border-[#e4bdb5] bg-[#fff3f0] p-4"><p role="alert" className="text-sm font-semibold text-[#963a30]">{error}</p><button type="button" onClick={() => { setLoading(true); void refresh().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Payment Log could not be loaded.")).finally(() => setLoading(false)); }} className="mt-3 min-h-11 rounded-xl border border-[#dab1aa] bg-white px-4 text-sm font-bold text-[#963a30]">Try again</button></div>}
        {loading && <PaymentLogSkeleton />}

        {!loading && data && <>
          <section className="mt-7 grid gap-3 sm:grid-cols-3">
            <SummaryCard label="Active payments" value={formatPennies(summary.activeAmountPennies)} primary />
            <SummaryCard label="Records" value={String(summary.recordCount)} />
            <SummaryCard label="Voided" value={String(summary.voidedCount)} detail={summary.voidedCount ? `${formatPennies(summary.voidedAmountPennies)} retained in history` : "No voided records in this view"} />
          </section>

          <button type="button" onClick={() => setMobileFilters({ ...filters })} className="mt-5 flex min-h-12 w-full items-center justify-between rounded-xl border border-[#cbd8d3] bg-white px-4 text-sm font-bold text-[#174f45] shadow-sm lg:hidden"><span>Filters{filterCount ? ` (${filterCount})` : ""}</span><span aria-hidden>☰</span></button>

          <section className="mt-5 hidden rounded-2xl border border-[#dedfd7] bg-white p-5 shadow-sm lg:block" aria-label="Payment Log filters">
            <div className="flex items-center justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#a64235]">Audit tools</p><h2 className="mt-1 font-bold">Filters</h2></div><button type="button" onClick={() => setFilters(emptyPaymentFilters)} disabled={!filterCount} className="min-h-10 rounded-lg border px-3 text-xs font-bold text-[#174f45] disabled:opacity-40">Clear filters</button></div>
            <div className="mt-4"><QuickFilters value={filters.quick} onChange={(quick) => setFilters((current) => ({ ...current, quick }))} /></div>
            <FilterFields filters={filters} setFilters={setFilters} data={data} />
          </section>

          <ActiveFilterChips filters={filters} data={data} onChange={setFilters} />

          <section className="mt-5 overflow-hidden rounded-2xl border border-[#dedfd7] bg-white shadow-sm">
            <div className="hidden max-h-[65vh] overflow-auto lg:block">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="sticky top-0 z-10 bg-[#f1f3ef] text-[11px] uppercase tracking-wide text-[#65716d] shadow-[0_1px_0_#dedfd7]">
                  <tr>
                    <SortableHeading label="Payment date" sortKey="paymentDate" sort={sort} onSort={changeSort} />
                    <SortableHeading label="From" sortKey="payerName" sort={sort} onSort={changeSort} />
                    <SortableHeading label="To" sortKey="payeeName" sort={sort} onSort={changeSort} />
                    <SortableHeading label="Amount" sortKey="amountPennies" sort={sort} onSort={changeSort} align="right" />
                    <SortableHeading label="Recorded by" sortKey="recordedByName" sort={sort} onSort={changeSort} />
                    <SortableHeading label="Recorded at" sortKey="recordedAt" sort={sort} onSort={changeSort} />
                    <SortableHeading label="Status" sortKey="status" sort={sort} onSort={changeSort} />
                    <th className="px-3 py-3 font-bold">Notes</th><th className="px-3 py-3 font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e8e8e1]">
                  {filtered.map((record) => <tr key={record.id} tabIndex={0} onClick={(event) => openDetail(record, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetail(record, event.currentTarget); } }} className="cursor-pointer bg-white transition hover:bg-[#f7faf8] focus:bg-[#f7faf8] focus:outline-none">
                    <td className="whitespace-nowrap px-3 py-3 font-semibold">{formatPaymentDate(record.paymentDate)}</td>
                    <td className="px-3 py-3 font-semibold">{record.payerName}</td><td className="px-3 py-3 font-semibold">{record.payeeName}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-bold text-[#174f45]">{formatPennies(record.amountPennies)}</td>
                    <td className="px-3 py-3">{record.recordedByName}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-[#63706b]">{formatRecordedAt(record.recordedAt)}</td>
                    <td className="px-3 py-3"><StatusBadge record={record} /></td>
                    <td className="max-w-56 truncate px-3 py-3 text-[#63706b]" title={record.notes ?? undefined}>{record.notes || "—"}</td>
                    <td className="px-3 py-3"><button type="button" onClick={(event) => { event.stopPropagation(); openDetail(record, event.currentTarget); }} className="min-h-9 rounded-lg border border-[#cbd8d3] px-3 text-xs font-bold text-[#174f45]">View</button></td>
                  </tr>)}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-[#e7e7e0] lg:hidden">
              {filtered.map((record) => <button key={record.id} type="button" onClick={(event) => openDetail(record, event.currentTarget)} className="block w-full bg-white px-4 py-4 text-left active:bg-[#f4f7f5]"><div className="flex items-center justify-between gap-3"><time className="text-xs font-semibold text-[#75807c]">{formatPaymentDate(record.paymentDate)}</time><StatusBadge record={record} /></div><div className="mt-2 flex items-start justify-between gap-4"><div className="min-w-0"><p className="truncate font-bold">{record.payerName} <span className="px-1 text-[#89938f]">→</span> {record.payeeName}</p><p className="mt-1 truncate text-xs text-[#75807c]">Recorded by {record.recordedByName}</p></div><strong className="shrink-0 text-lg text-[#174f45]">{formatPennies(record.amountPennies)}</strong></div><p className="mt-2 text-[11px] font-semibold text-[#8a938f]">Tap to view details</p></button>)}
            </div>

            {filtered.length === 0 && <div className="px-5 py-12 text-center"><span className="text-3xl" aria-hidden>⌕</span><h2 className="mt-3 font-bold">No payments match these filters</h2><p className="mt-2 text-sm text-[#75807c]">Clear a filter or choose a different date range.</p><button type="button" onClick={() => setFilters(emptyPaymentFilters)} className="mt-4 min-h-11 rounded-xl bg-[#174f45] px-5 text-sm font-bold text-white">Clear filters</button></div>}
          </section>

          {mobileFilters && <MobileFilterSheet draft={mobileFilters} setDraft={setMobileFilters} data={data} onClose={() => setMobileFilters(null)} onApply={() => { setFilters(mobileFilters); setMobileFilters(null); }} />}
          {selected && <PaymentDetail record={selected} isAdmin={data.isAdmin} onClose={closeDetail} onVoided={async () => { const loaded = await refresh(); const updated = loaded.records.find((record) => record.id === selected.id); if (updated) setSelected(updated); }} />}
        </>}
      </div>
    </div>
  </main>;
=======
  return (
    <AppShell width="wide">
      <PageHeader
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
        <section className="mt-6 grid gap-3 sm:grid-cols-3">
          <SummaryCard label="Active payments" value={formatPennies(summary.activeAmountPennies)} primary />
          <SummaryCard label="Records" value={String(summary.recordCount)} />
          <SummaryCard label="Voided" value={String(summary.voidedCount)} detail={summary.voidedCount ? `${formatPennies(summary.voidedAmountPennies)} retained in history` : "No voided records in this view"} />
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
                    "flex min-h-10 items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold",
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
                    <p className="mt-1 truncate text-xs text-ink-600">Recorded by {record.recordedByName}</p>
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
>>>>>>> 7534a2d (redesign and realtime)
}

function FilterFields({ filters, setFilters, data }: { filters: PaymentLogFilters; setFilters: (value: PaymentLogFilters | ((current: PaymentLogFilters) => PaymentLogFilters)) => void; data: PaymentLogResponse }) {
  const update = <Key extends keyof PaymentLogFilters>(key: Key, value: PaymentLogFilters[Key]) => setFilters((current) => ({ ...current, [key]: value }));
<<<<<<< HEAD
  return <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-7">
    <label className="block text-xs font-bold xl:col-span-2">Search<input type="search" maxLength={INPUT_LIMITS.search} value={filters.search} onChange={(event) => update("search", event.target.value)} placeholder="Names or notes" className="mt-1.5 h-11 w-full rounded-lg border border-[#d5d9d3] bg-white px-3 text-sm font-normal" /></label>
    <FilterSelect label="From" value={filters.payerContributorId} onChange={(value) => update("payerContributorId", value)} options={data.contributors} allLabel="All payers" />
    <FilterSelect label="To" value={filters.payeeContributorId} onChange={(value) => update("payeeContributorId", value)} options={data.contributors} allLabel="All receivers" />
    <label className="block text-xs font-bold">Status<select value={filters.status} onChange={(event) => { const status = validateEnum(event.target.value, ["all", "paid", "voided"] as const, "Invalid status."); if (status.ok) update("status", status.value); }} className="mt-1.5 h-11 w-full rounded-lg border border-[#d5d9d3] bg-white px-2 text-sm font-normal"><option value="all">All statuses</option><option value="paid">Paid</option><option value="voided">Voided</option></select></label>
    <FilterSelect label="Recorded by" value={filters.recordedByAppMemberId} onChange={(value) => update("recordedByAppMemberId", value)} options={data.recorders} allLabel="All recorders" />
    <div className="grid grid-cols-2 gap-2 xl:col-span-2"><label className="block text-xs font-bold">Date from<input type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(event) => update("dateFrom", event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-[#d5d9d3] bg-white px-2 text-sm font-normal" /></label><label className="block text-xs font-bold">Date to<input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(event) => update("dateTo", event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-[#d5d9d3] bg-white px-2 text-sm font-normal" /></label></div>
=======
  const compact = "h-11 rounded-lg px-3 text-sm";
  return <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-7">
    <label className="block text-xs font-semibold xl:col-span-2">Search
      <Input type="search" maxLength={INPUT_LIMITS.search} value={filters.search} onChange={(event) => update("search", event.target.value)} placeholder="Names or notes" className={cx("mt-1.5 font-normal", compact)} />
    </label>
    <FilterSelect label="From" value={filters.payerContributorId} onChange={(value) => update("payerContributorId", value)} options={data.contributors} allLabel="All payers" />
    <FilterSelect label="To" value={filters.payeeContributorId} onChange={(value) => update("payeeContributorId", value)} options={data.contributors} allLabel="All receivers" />
    <label className="block text-xs font-semibold">Status
      <Select value={filters.status} onChange={(event) => { const status = validateEnum(event.target.value, ["all", "paid", "voided"] as const, "Invalid status."); if (status.ok) update("status", status.value); }} className={cx("mt-1.5 font-normal", compact)}>
        <option value="all">All statuses</option><option value="paid">Paid</option><option value="voided">Voided</option>
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
>>>>>>> 7534a2d (redesign and realtime)
  </div>;
}

function FilterSelect({ label, value, onChange, options, allLabel }: { label: string; value: string; onChange: (value: string) => void; options: { id: string; name: string }[]; allLabel: string }) {
<<<<<<< HEAD
  return <label className="block text-xs font-bold">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-[#d5d9d3] bg-white px-2 text-sm font-normal"><option value="">{allLabel}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>;
}

function QuickFilters({ value, onChange }: { value: PaymentQuickFilter; onChange: (value: PaymentQuickFilter) => void }) {
  return <div className="space-y-2"><div className="flex flex-wrap gap-2">{quickFilters.map((filter) => <QuickButton key={filter.value} active={value === filter.value} onClick={() => onChange(filter.value)}>{filter.label}</QuickButton>)}</div><div className="flex flex-wrap gap-2">{personalQuickFilters.map((filter) => <QuickButton key={filter.value} active={value === filter.value} onClick={() => onChange(filter.value)}>{filter.label}</QuickButton>)}</div></div>;
}

function QuickButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`min-h-10 rounded-full border px-3 text-xs font-bold ${active ? "border-[#174f45] bg-[#174f45] text-white" : "border-[#d8dcd6] bg-white text-[#64716c]"}`}>{children}</button>;
=======
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
>>>>>>> 7534a2d (redesign and realtime)
}

function ActiveFilterChips({ filters, data, onChange }: { filters: PaymentLogFilters; data: PaymentLogResponse; onChange: (filters: PaymentLogFilters) => void }) {
  const chips = [
    filters.search ? { key: "search", label: `Search: ${filters.search}` } : null,
    filters.payerContributorId ? { key: "payerContributorId", label: `From: ${optionName(data.contributors, filters.payerContributorId)}` } : null,
    filters.payeeContributorId ? { key: "payeeContributorId", label: `To: ${optionName(data.contributors, filters.payeeContributorId)}` } : null,
    filters.status !== "all" ? { key: "status", label: `Status: ${filters.status === "paid" ? "Paid" : "Voided"}` } : null,
    filters.recordedByAppMemberId ? { key: "recordedByAppMemberId", label: `Recorded by: ${optionName(data.recorders, filters.recordedByAppMemberId)}` } : null,
    filters.dateFrom ? { key: "dateFrom", label: `From date: ${formatPaymentDate(filters.dateFrom)}` } : null,
    filters.dateTo ? { key: "dateTo", label: `To date: ${formatPaymentDate(filters.dateTo)}` } : null,
    filters.quick !== "all" ? { key: "quick", label: `Quick: ${[...quickFilters, ...personalQuickFilters].find((item) => item.value === filters.quick)?.label ?? filters.quick}` } : null,
  ].filter((chip): chip is { key: keyof PaymentLogFilters; label: string } => Boolean(chip));
  if (!chips.length) return null;
<<<<<<< HEAD
  return <div className="mt-4 flex flex-wrap items-center gap-2"><span className="text-xs font-bold text-[#68736f]">Active filters:</span>{chips.map((chip) => <button key={chip.key} type="button" onClick={() => onChange({ ...filters, [chip.key]: chip.key === "status" || chip.key === "quick" ? "all" : "" })} className="min-h-9 rounded-full border border-[#c8d7d1] bg-[#edf5f2] px-3 text-xs font-bold text-[#174f45]">{chip.label} <span aria-hidden>×</span><span className="sr-only"> remove</span></button>)}<button type="button" onClick={() => onChange(emptyPaymentFilters)} className="min-h-9 px-2 text-xs font-bold text-[#a64235]">Clear all</button></div>;
}

function MobileFilterSheet({ draft, setDraft, data, onClose, onApply }: { draft: PaymentLogFilters; setDraft: (filters: PaymentLogFilters | null) => void; data: PaymentLogResponse; onClose: () => void; onApply: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; panel.current?.focus(); const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", key); return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", key); }; }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-end bg-[#092d27]/60 backdrop-blur-[2px] lg:hidden" role="dialog" aria-modal="true" aria-labelledby="mobile-filters-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={panel} tabIndex={-1} className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border-t-4 border-[#c5a65a] bg-[#f7f6f1] p-5 outline-none"><div className="flex items-center justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#a64235]">Payment Log</p><h2 id="mobile-filters-title" className="mt-1 text-2xl font-bold">Filters</h2></div><button type="button" onClick={onClose} className="h-12 min-w-12 rounded-full border bg-white px-3 font-bold">Close</button></div><div className="mt-5 rounded-2xl bg-white p-4"><QuickFilters value={draft.quick} onChange={(quick) => setDraft({ ...draft, quick })} /></div><div className="mt-4 rounded-2xl bg-white p-4"><FilterFields filters={draft} setFilters={(next) => setDraft(typeof next === "function" ? next(draft) : next)} data={data} /></div><div className="sticky bottom-0 -mx-5 mt-5 grid grid-cols-2 gap-3 border-t bg-[#f7f6f1]/95 px-5 pb-[max(16px,env(safe-area-inset-bottom))] pt-4 backdrop-blur"><button type="button" onClick={() => setDraft({ ...emptyPaymentFilters })} className="min-h-12 rounded-xl border bg-white font-bold">Clear</button><button type="button" onClick={onApply} className="min-h-12 rounded-xl bg-[#174f45] font-bold text-white">Apply filters</button></div></div></div>;
}

function PaymentDetail({ record, isAdmin, onClose, onVoided }: { record: PaymentLogRecord; isAdmin: boolean; onClose: () => void; onVoided: () => Promise<void> }) {
  const panel = useRef<HTMLDivElement>(null);
  const [voiding, setVoiding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; panel.current?.focus(); const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", key); return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", key); }; }, [onClose]);
  const voidPayment = async () => {
    if (!window.confirm(`Void payment?\n\n${record.payerName} → ${record.payeeName}\n${formatPennies(record.amountPennies)}\n\nThis will restore the amount to the outstanding balance.`)) return;
    setVoiding(true); setError(null);
    const validId = validateUuid(record.id, "This payment record is invalid.");
    if (!validId.ok) { setError(validId.error); setVoiding(false); return; }
    const result = await createClient().rpc("void_settlement", { p_settlement_id: validId.value });
    if (result.error) { setError(result.error.code === "42501" ? "Only Global Admin can void a payment." : "This payment could not be voided. Nothing was changed."); setVoiding(false); return; }
=======
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-ink-600">Active filters:</span>
      {chips.map((chip) => (
        <button key={chip.key} type="button" onClick={() => onChange({ ...filters, [chip.key]: chip.key === "status" || chip.key === "quick" ? "all" : "" })} className="min-h-9 rounded-full border border-accent-soft-border bg-accent-soft px-3 text-xs font-semibold text-accent hover:border-accent/40">
          {chip.label} <span aria-hidden>×</span><span className="sr-only"> remove</span>
        </button>
      ))}
      <button type="button" onClick={() => onChange(emptyPaymentFilters)} className="min-h-9 px-2 text-xs font-semibold text-berry">Clear all</button>
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
    if (result.error) { setError(result.error.code === "42501" ? "Only Global Admin can void a payment." : "This payment could not be voided. Nothing was changed."); setVoiding(false); setConfirming(false); return; }
>>>>>>> 7534a2d (redesign and realtime)
    try {
      await onVoided();
    } catch {
      setError("The payment was voided, but the log could not refresh. Close this detail and refresh the Payment Log.");
    } finally {
      setVoiding(false);
<<<<<<< HEAD
    }
  };
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#092d27]/60 backdrop-blur-[2px] sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="payment-detail-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={panel} tabIndex={-1} className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border-t-4 border-[#c5a65a] bg-[#f7f6f1] p-5 outline-none shadow-2xl sm:max-w-2xl sm:rounded-3xl sm:border sm:border-t-4 sm:p-7"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#a64235]">Payment details</p><h2 id="payment-detail-title" className="mt-2 text-2xl font-bold">{record.payerName} <span className="text-[#89938f]">→</span> {record.payeeName}</h2><p className="mt-1 text-sm text-[#75807c]">Christmas {record.eventYear}</p></div><button type="button" onClick={onClose} className="h-12 min-w-12 rounded-full border bg-white px-3 font-bold shadow-sm">Close</button></div>
    {error && <p role="alert" className="mt-4 rounded-xl border border-[#e4bdb5] bg-[#fff3f0] p-3 text-sm font-semibold text-[#963a30]">{error}</p>}
    <div className="mt-6 rounded-2xl border border-[#2c655a] bg-[#123f37] p-5 text-white"><p className="text-xs font-semibold text-[#d5e3df]">{record.voidedAt ? "Original amount" : "Amount"}</p><p className="mt-1 text-4xl font-bold">{formatPennies(record.amountPennies)}</p><div className="mt-4"><StatusBadge record={record} /></div></div>
    <dl className="mt-5 divide-y divide-[#e2e2da] rounded-2xl border border-[#e2e1d8] bg-white px-5">
      <DetailRow label="Payment date" value={formatPaymentDate(record.paymentDate)} />
      <DetailRow label={record.voidedAt ? "Originally recorded by" : "Recorded by"} value={record.recordedByName} />
      <DetailRow label={record.voidedAt ? "Originally recorded at" : "Recorded at"} value={formatRecordedAtLong(record.recordedAt)} />
      <DetailRow label="Notes" value={record.notes || "No notes were added."} />
      {record.voidedAt && <DetailRow label="Voided at" value={formatRecordedAtLong(record.voidedAt)} />}
      {record.voidedAt && <DetailRow label="Voided by" value={record.voidedByName || "Unknown member (record link missing)"} />}
    </dl>
    {isAdmin && !record.voidedAt && <div className="mt-5 rounded-2xl border border-[#e6c4bd] bg-[#fff5f2] p-4"><h3 className="font-bold text-[#94382e]">Correction</h3><p className="mt-1 text-xs leading-5 text-[#7d625d]">Voiding keeps this record in the log and restores the payment to the Owed balance.</p><button type="button" disabled={voiding} onClick={() => void voidPayment()} className="mt-3 min-h-12 w-full rounded-xl bg-[#a64235] px-4 text-sm font-bold text-white disabled:opacity-50">{voiding ? "Voiding payment..." : "Void payment"}</button></div>}
  </div></div>;
}

function DetailRow({ label, value }: { label: string; value: string }) { return <div className="grid gap-1 py-4 sm:grid-cols-[170px_1fr]"><dt className="text-xs font-bold uppercase tracking-wide text-[#7b8581]">{label}</dt><dd className="break-words text-sm font-semibold">{value}</dd></div>; }

function SortableHeading({ label, sortKey, sort, onSort, align = "left" }: { label: string; sortKey: PaymentSortKey; sort: SortState; onSort: (key: PaymentSortKey) => void; align?: "left" | "right" }) {
  const active = sort.key === sortKey;
  return <th aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"} className={`px-3 py-2 font-bold ${align === "right" ? "text-right" : ""}`}><button type="button" onClick={() => onSort(sortKey)} className={`inline-flex min-h-9 items-center gap-1 rounded-lg px-1 ${align === "right" ? "justify-end" : ""}`}>{label}<span aria-hidden className={active ? "text-[#174f45]" : "text-[#aab1ae]"}>{active ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</span><span className="sr-only">{active ? ` sorted ${sort.direction === "asc" ? "ascending" : "descending"}` : " sort column"}</span></button></th>;
}

function StatusBadge({ record }: { record: PaymentLogRecord }) { const status = paymentStatus(record); return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${status === "voided" ? "border-[#e5b9b1] bg-[#fff0ed] text-[#a23d32]" : "border-[#afd1c5] bg-[#e8f5f0] text-[#17624f]"}`}>{status === "voided" ? "Voided" : "Paid"}</span>; }
function SummaryCard({ label, value, detail, primary = false }: { label: string; value: string; detail?: string; primary?: boolean }) { return <div className={`rounded-2xl border p-5 shadow-sm ${primary ? "border-[#2c655a] bg-[#123f37] text-white" : "border-[#e2e1d8] bg-white"}`}><p className={`text-xs font-bold uppercase tracking-wide ${primary ? "text-[#d5e3df]" : "text-[#75807c]"}`}>{label}</p><p className="mt-2 text-3xl font-bold">{value}</p>{detail && <p className={`mt-1 text-xs ${primary ? "text-[#d5e3df]" : "text-[#89938f]"}`}>{detail}</p>}</div>; }
function PaymentLogSkeleton() { return <div className="mt-7 animate-pulse"><div className="grid gap-3 sm:grid-cols-3"><div className="h-28 rounded-2xl bg-[#e5e7e2]" /><div className="h-28 rounded-2xl bg-[#e5e7e2]" /><div className="h-28 rounded-2xl bg-[#e5e7e2]" /></div><div className="mt-5 h-80 rounded-2xl bg-[#e8e9e5]" /></div>; }
=======
      setConfirming(false);
    }
  };
  return (
    <Modal labelledBy="payment-detail-title" onClose={onClose} size="lg" dismissible={!confirming}>
      <ModalHeader
        id="payment-detail-title"
        eyebrow="Payment details"
        title={`${record.payerName} → ${record.payeeName}`}
        description={`Christmas ${record.eventYear}`}
        onClose={onClose}
        closeLabel="Close payment details"
      />
      <div className="px-5 pb-6 sm:px-7 sm:pb-7">
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        <div className="dark rounded-2xl border border-pine-700 bg-linear-to-br from-pine-900 to-pine-800 p-5 text-white">
          <p className="text-xs font-medium text-pine-100">{record.voidedAt ? "Original amount" : "Amount"}</p>
          <p className="mt-1 font-display text-4xl font-semibold tabular-nums">{formatPennies(record.amountPennies)}</p>
          <div className="mt-4"><StatusBadge record={record} /></div>
        </div>
        <DataList className="mt-5 rounded-2xl border border-line bg-surface px-5">
          <DataRow label="Payment date" value={formatPaymentDate(record.paymentDate)} />
          <DataRow label={record.voidedAt ? "Originally recorded by" : "Recorded by"} value={record.recordedByName} />
          <DataRow label={record.voidedAt ? "Originally recorded at" : "Recorded at"} value={formatRecordedAtLong(record.recordedAt)} />
          <DataRow label="Notes" value={record.notes || "No notes were added."} />
          {record.voidedAt && <DataRow label="Voided at" value={formatRecordedAtLong(record.voidedAt)} />}
          {record.voidedAt && <DataRow label="Voided by" value={record.voidedByName || "Unknown member (record link missing)"} />}
        </DataList>
        {isAdmin && !record.voidedAt && (
          <div className="mt-5 rounded-2xl border border-berry-soft-border bg-berry-soft p-4">
            <h3 className="font-semibold text-berry">Correction</h3>
            <p className="mt-1 text-xs leading-5 text-ink-600">Voiding keeps this record in the log and restores the payment to the Owed balance.</p>
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
            <p className="mt-2">This will restore the amount to the outstanding balance. The record stays in the log.</p>
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



function StatusBadge({ record }: { record: PaymentLogRecord }) {
  const status = paymentStatus(record);
  return <Badge tone={status === "voided" ? "danger" : "success"}>{status === "voided" ? "Voided" : "Paid"}</Badge>;
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
>>>>>>> 7534a2d (redesign and realtime)

async function requestPaymentLog() {
  const response = await fetch("/api/payment-log", { cache: "no-store" });
  const body = await response.json().catch(() => null) as PaymentLogResponse | { error?: string } | null;
  if (!response.ok) throw new Error(body && "error" in body && body.error ? body.error : "Payment Log could not be loaded.");
  return body as PaymentLogResponse;
}

function optionName(options: { id: string; name: string }[], id: string) { return options.find((option) => option.id === id)?.name ?? "Unknown selection"; }
function formatPaymentDate(value: string) { const date = new Date(`${value}T12:00:00`); return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date); }
function formatRecordedAt(value: string) { return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatRecordedAtLong(value: string) { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
