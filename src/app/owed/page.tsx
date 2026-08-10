"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createClient } from "../../../utils/supabase/client";
import { formatPennies } from "../../lib/currency";
import {
  calculatePairBalanceExplanation,
  contributorOwedSummary,
  pairKey,
  type NetOwedBalance,
} from "../../lib/owed";
import { parsePoundsToPennies } from "../../lib/purchases";
import { INPUT_LIMITS, validateDateInput, validateOptionalText, validateUuid } from "../../lib/input-validation";
import { AppNav } from "../components/app-nav";
import { loadOwedData, type OwedData } from "./owed-data";

type ViewMode = "mine" | "all";

export default function OwedPage() {
  const [data, setData] = useState<OwedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("mine");
  const [openPairKey, setOpenPairKey] = useState<string | null>(null);
  const [paymentBalance, setPaymentBalance] = useState<NetOwedBalance | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setData(await loadOwedData());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Owed balances could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    loadOwedData()
      .then((loaded) => { if (active) setData(loaded); })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Owed balances could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const personalBalances = useMemo(() => data?.balances.filter((balance) =>
    balance.debtorContributorId === data.currentContributorId
    || balance.creditorContributorId === data.currentContributorId,
  ) ?? [], [data]);
  const personalSummary = data
    ? contributorOwedSummary(data.balances, data.currentContributorId)
    : { owedToYouPennies: 0, youOwePennies: 0 };

  const names = data?.contributorNames ?? new Map<string, string>();
  const owedToYou = data ? personalBalances.filter((row) => row.creditorContributorId === data.currentContributorId) : [];
  const youOwe = data ? personalBalances.filter((row) => row.debtorContributorId === data.currentContributorId) : [];

  return (
    <main className="flex min-h-screen bg-[#f7f6f1] text-[#1d2926]">
      <AppNav />
      <div className="min-w-0 flex-1 pb-28 lg:pb-10">
        <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
          <header>
            <p className="text-sm font-semibold text-[#a64235]">Christmas 2026</p>
            <h1 className="mt-1 text-4xl font-bold tracking-tight">Owed</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#75807c]">See who owes whom, why, and which payments have been recorded.</p>
          </header>

          {error && <p role="alert" className="mt-6 rounded-xl border border-[#ead7cf] bg-[#fff8f4] p-4 text-sm font-semibold text-[#914d3c]">{error}</p>}
          {loading && <LoadingState />}

          {!loading && data && <>
            <section className="mt-7 grid gap-4 sm:grid-cols-2">
              <BalanceSummary label="You are owed" value={personalSummary.owedToYouPennies} detail="Money other contributors need to repay you" positive />
              <BalanceSummary label="You owe" value={personalSummary.youOwePennies} detail="Money you need to repay other contributors" />
            </section>

            {data.isAdmin && <div className="mt-7 inline-flex rounded-xl border border-[#dfe6e2] bg-white p-1" aria-label="Balance view">
              <ViewButton active={view === "mine"} onClick={() => setView("mine")}>My balances</ViewButton>
              <ViewButton active={view === "all"} onClick={() => setView("all")}>All balances</ViewButton>
            </div>}

            {view === "mine" ? (
              personalBalances.length === 0
                ? <AllSettled />
                : <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
                    <BalanceSection
                      title="You are owed"
                      empty="Nobody currently owes you."
                      balances={owedToYou}
                      currentContributorId={data.currentContributorId}
                      names={names}
                      isAdmin={data.isAdmin}
                      onView={(balance) => setOpenPairKey(balance.pairKey)}
                      onPay={setPaymentBalance}
                    />
                    <BalanceSection
                      title="You owe"
                      empty="You do not currently owe anyone."
                      balances={youOwe}
                      currentContributorId={data.currentContributorId}
                      names={names}
                      isAdmin={data.isAdmin}
                      onView={(balance) => setOpenPairKey(balance.pairKey)}
                      onPay={setPaymentBalance}
                    />
                  </div>
            ) : (
              <section className="mt-6 rounded-2xl border border-[#e2e1d8] bg-white p-5 shadow-sm sm:p-7">
                <div><h2 className="text-xl font-bold">All balances</h2><p className="mt-1 text-sm text-[#75807c]">Current balances after purchases and recorded payments.</p></div>
                {data.balances.length === 0 ? <AllSettled compact /> : <div className="mt-5 grid gap-3 md:grid-cols-2">
                  {data.balances.map((balance) => <BalanceCard key={balance.pairKey} balance={balance} currentContributorId={data.currentContributorId} names={names} isAdmin onView={() => setOpenPairKey(balance.pairKey)} onPay={() => setPaymentBalance(balance)} allView />)}
                </div>}
              </section>
            )}

            {openPairKey && <Breakdown
              pairKeyValue={openPairKey}
              data={data}
              onClose={() => setOpenPairKey(null)}
              onPay={(balance) => setPaymentBalance(balance)}
              onRefresh={refresh}
            />}
            {paymentBalance && <PaymentSheet
              balance={paymentBalance}
              data={data}
              onClose={() => setPaymentBalance(null)}
              onSaved={async () => { setPaymentBalance(null); await refresh(); }}
            />}
          </>}
        </div>
      </div>
    </main>
  );
}

function BalanceSummary({ label, value, detail, positive = false }: { label: string; value: number; detail: string; positive?: boolean }) {
  return <div className={`rounded-2xl border p-6 shadow-sm ${positive ? "border-[#2c655a] bg-[#123f37] text-white" : "border-[#e2e1d8] bg-white"}`}><p className={`text-sm font-semibold ${positive ? "text-[#d5e3df]" : "text-[#75807c]"}`}>{label}</p><p className="mt-2 text-4xl font-bold">{formatPennies(value)}</p><p className={`mt-2 text-xs leading-5 ${positive ? "text-[#d7e8e3]" : "text-[#89938f]"}`}>{detail}</p></div>;
}

function ViewButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`min-h-10 rounded-lg px-4 text-sm font-bold ${active ? "bg-[#e4f1ed] text-[#28685c]" : "text-[#75807c]"}`}>{children}</button>;
}

function BalanceSection({ title, empty, balances, currentContributorId, names, isAdmin, onView, onPay }: { title: string; empty: string; balances: NetOwedBalance[]; currentContributorId: string; names: Map<string, string>; isAdmin: boolean; onView: (balance: NetOwedBalance) => void; onPay: (balance: NetOwedBalance) => void }) {
  return <section className="rounded-2xl border border-[#e2e1d8] bg-white p-5 shadow-sm sm:p-7"><h2 className="text-xl font-bold">{title}</h2>{balances.length === 0 ? <p className="mt-4 rounded-xl bg-[#faf9f5] p-4 text-sm text-[#75807c]">{empty}</p> : <div className="mt-5 space-y-3">{balances.map((balance) => <BalanceCard key={balance.pairKey} balance={balance} currentContributorId={currentContributorId} names={names} isAdmin={isAdmin} onView={() => onView(balance)} onPay={() => onPay(balance)} />)}</div>}</section>;
}

function BalanceCard({ balance, currentContributorId, names, isAdmin, onView, onPay, allView = false }: { balance: NetOwedBalance; currentContributorId: string; names: Map<string, string>; isAdmin: boolean; onView: () => void; onPay: () => void; allView?: boolean }) {
  const debtor = contributorName(names, balance.debtorContributorId);
  const creditor = contributorName(names, balance.creditorContributorId);
  const receiverCanConfirm = balance.creditorContributorId === currentContributorId || isAdmin;
  const title = allView
    ? `${debtor} owes ${creditor}`
    : balance.creditorContributorId === currentContributorId
      ? `${debtor} owes you`
      : `You owe ${creditor}`;
  return <article className="rounded-xl border border-[#e2e8e4] p-4 sm:p-5"><p className="font-bold">{title}</p><p className="mt-1 text-3xl font-bold text-[#1f5b50]">{formatPennies(balance.amountPennies)}</p><div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={onView} className="min-h-12 rounded-xl border border-[#cad8d3] px-3 text-sm font-bold text-[#28685c]">Why this balance?</button>{receiverCanConfirm ? <button type="button" onClick={onPay} className="min-h-12 rounded-xl bg-[#1f5b50] px-3 text-sm font-bold text-white">Record payment</button> : <span className="flex min-h-12 items-center justify-center rounded-xl bg-[#f4f5f4] px-3 text-center text-xs text-[#75807c]">Receiver records payment</span>}</div></article>;
}

function Breakdown({ pairKeyValue, data, onClose, onPay, onRefresh }: { pairKeyValue: string; data: OwedData; onClose: () => void; onPay: (balance: NetOwedBalance) => void; onRefresh: () => Promise<void> }) {
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);
  const ids = pairKeyValue.split("|");
  const pairObligations = data.obligations.filter((row) => pairKey(row.debtorContributorId, row.creditorContributorId) === pairKeyValue);
  const pairSettlements = data.settlements.filter((row) => pairKey(row.payerContributorId, row.payeeContributorId) === pairKeyValue);
  const names = data.contributorNames;
  const explanation = calculatePairBalanceExplanation(ids[0], ids[1], pairObligations, pairSettlements);
  const balance = explanation.currentBalance;
  const canConfirm = balance && (data.isAdmin || balance.creditorContributorId === data.currentContributorId);

  const voidPayment = async (settlementId: string, label: string) => {
    if (!window.confirm(`Void ${label}?\n\nThis removes its effect from the current balance. The history record will be kept.`)) return;
    setVoidingId(settlementId);
    setVoidError(null);
    const validSettlementId = validateUuid(settlementId, "This payment record is invalid.");
    if (!validSettlementId.ok) { setVoidError(validSettlementId.error); setVoidingId(null); return; }
    const result = await createClient().rpc("void_settlement", { p_settlement_id: validSettlementId.value });
    if (result.error) setVoidError("This payment could not be voided. Nothing was changed.");
    else await onRefresh();
    setVoidingId(null);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-[#092d27]/60 p-0 backdrop-blur-[2px] sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="breakdown-title">
      <section className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border-t-4 border-[#c5a65a] bg-[#f7f6f1] p-5 shadow-2xl sm:max-w-3xl sm:rounded-3xl sm:border sm:border-t-4 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-[#a64235]">Current balance</p>
            <h2 id="breakdown-title" className="mt-1 text-2xl font-bold">{balance ? `${contributorName(names, balance.debtorContributorId)} owes ${contributorName(names, balance.creditorContributorId)}` : "Settled"}</h2>
            <p className="mt-2 text-4xl font-bold text-[#1f5b50]">{formatPennies(balance?.amountPennies ?? 0)}</p>
            {!balance && <p className="mt-1 text-sm text-[#75807c]">{contributorName(names, ids[0])} and {contributorName(names, ids[1])} have no current balance.</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close breakdown" className="h-12 w-12 shrink-0 rounded-full border bg-white text-xl shadow-sm">×</button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <DirectionTotal label="After purchases" balance={explanation.purchaseBalance} names={names} />
          <DirectionTotal label="Payment adjustments" balance={explanation.paymentAdjustment} names={names} adjustment />
          <DirectionTotal label="Current balance" balance={balance} names={names} primary />
        </div>

        <section className="mt-6 rounded-2xl bg-white p-5">
          <h3 className="font-bold">Why this balance?</h3>
          <p className="mt-1 text-xs leading-5 text-[#75807c]">Each direction is shown first, then the app nets them into one purchase balance.</p>
          {explanation.purchaseDirections.length === 0 ? (
            <p className="mt-4 text-sm text-[#75807c]">No active purchases create a balance for this pair.</p>
          ) : (
            <div className="mt-4 space-y-5">
              {explanation.purchaseDirections.map((direction) => {
                const directionRows = pairObligations.filter((row) =>
                  row.debtorContributorId === direction.debtorContributorId
                  && row.creditorContributorId === direction.creditorContributorId,
                );
                const debtor = contributorName(names, direction.debtorContributorId);
                const creditor = contributorName(names, direction.creditorContributorId);
                return (
                  <div key={`${direction.debtorContributorId}-${direction.creditorContributorId}`}>
                    <div className="flex items-center justify-between gap-3 border-b border-[#e5e7e2] pb-2"><h4 className="text-xs font-bold uppercase tracking-wide text-[#596762]">{debtor} owes {creditor}</h4><strong>{formatPennies(direction.amountPennies)}</strong></div>
                    <div className="mt-2 space-y-2">
                      {directionRows.map((row, index) => (
                        <div key={`${row.purchaseId}-${row.debtorContributorId}-${index}`} className="rounded-xl bg-[#f8f8f6] p-4">
                          <div className="flex items-start justify-between gap-4"><div className="min-w-0"><p className="font-bold">{row.recipientName} — {row.description}</p><p className="mt-1 text-sm font-semibold text-[#475651]">{debtor} owes {creditor}</p></div><strong className="shrink-0">{formatPennies(row.amountPennies)}</strong></div>
                          <p className="mt-2 text-xs leading-5 text-[#75807c]">{creditor} paid {debtor}&apos;s share at checkout · {formatDate(row.purchaseDate)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className="rounded-xl border border-[#cadbd5] bg-[#f0f7f4] p-4"><p className="text-xs font-bold uppercase tracking-wide text-[#55706a]">Net purchase balance</p><DirectionSentence balance={explanation.purchaseBalance} names={names} /></div>
            </div>
          )}
        </section>

        <section className="mt-4 rounded-2xl bg-white p-5">
          <h3 className="font-bold">Payments recorded</h3>
          {voidError && <p role="alert" className="mt-3 rounded-lg bg-[#fff5f1] p-3 text-sm text-[#914d3c]">{voidError}</p>}
          {pairSettlements.length === 0 ? (
            <p className="mt-4 text-sm text-[#75807c]">No payments have been recorded.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {pairSettlements.map((row) => {
                const payer = contributorName(names, row.payerContributorId);
                const payee = contributorName(names, row.payeeContributorId);
                return (
                  <div key={row.id} className={`rounded-xl border p-4 ${row.voidedAt ? "border-[#e4e5e4] bg-[#f5f5f4] text-[#78817e]" : "border-[#dfe7e3]"}`}>
                    <div className="flex items-start justify-between gap-4"><div><p className="font-bold">{payer} paid {payee}</p><p className="mt-1 text-xs">{formatDate(row.paymentDate)}{row.voidedAt ? ` · Voided ${formatDate(row.voidedAt)}` : ""}</p></div><strong className={row.voidedAt ? "line-through" : "text-[#28685c]"}>{formatPennies(row.amountPennies)}</strong></div>
                    <p className="mt-2 text-xs leading-5 text-[#75807c]">{row.voidedAt ? "Voided — this no longer affects the current balance." : `This shifts the balance ${formatPennies(row.amountPennies)} toward ${payee} owing ${payer}.`}</p>
                    {row.notes && <p className="mt-2 break-words text-sm">{row.notes}</p>}
                    {data.isAdmin && !row.voidedAt && <button type="button" disabled={voidingId === row.id} onClick={() => void voidPayment(row.id, `${formatPennies(row.amountPennies)} payment from ${payer} to ${payee}`)} className="mt-3 min-h-10 rounded-lg border border-[#e5cfc7] px-3 text-xs font-bold text-[#914d3c] disabled:opacity-50">{voidingId === row.id ? "Voiding..." : "Void payment"}</button>}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <div className="mt-5 flex gap-3"><button type="button" onClick={onClose} className="min-h-12 flex-1 rounded-xl border bg-white px-4 font-bold">Close</button>{canConfirm && balance && <button type="button" onClick={() => onPay(balance)} className="min-h-12 flex-1 rounded-xl bg-[#1f5b50] px-4 font-bold text-white">Record payment</button>}</div>
      </section>
    </div>
  );
}

function PaymentSheet({ balance, data, onClose, onSaved }: { balance: NetOwedBalance; data: OwedData; onClose: () => void; onSaved: () => Promise<void> }) {
  const [amount, setAmount] = useState((balance.amountPennies / 100).toFixed(2));
  const [date, setDate] = useState(todayInput());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debtor = contributorName(data.contributorNames, balance.debtorContributorId);
  const creditor = contributorName(data.contributorNames, balance.creditorContributorId);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = parsePoundsToPennies(amount);
    if (!parsed.ok) { setError(parsed.error); return; }
    if (parsed.pennies <= 0) { setError("Enter an amount greater than £0."); return; }
    if (parsed.pennies > balance.amountPennies) { setError(`The payment cannot be more than the ${formatPennies(balance.amountPennies)} outstanding.`); return; }
    const validDate = validateDateInput(date, "Choose a valid payment date.");
    if (!validDate.ok) { setError(validDate.error); return; }
    const validNotes = validateOptionalText(notes, { field: "notes", maxLength: INPUT_LIMITS.settlementNotes, multiline: true });
    if (!validNotes.ok) { setError(validNotes.error); return; }
    const ids = [data.eventId, balance.debtorContributorId, balance.creditorContributorId].map((id) => validateUuid(id, "This payment link is invalid."));
    if (ids.some((result) => !result.ok)) { setError("This payment link is invalid. Refresh and try again."); return; }
    setSaving(true);
    const result = await createClient().rpc("record_settlement", {
      p_christmas_event_id: data.eventId,
      p_payer_contributor_id: balance.debtorContributorId,
      p_payee_contributor_id: balance.creditorContributorId,
      p_amount_pennies: parsed.pennies,
      p_payment_date: validDate.value,
      p_notes: validNotes.value,
    });
    if (result.error) {
      setError(settlementSaveError(result.error.code));
      setSaving(false);
      return;
    }
    await onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#13211d]/60 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="payment-title">
      <form onSubmit={(event) => void save(event)} className="w-full rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-lg sm:rounded-3xl sm:p-7">
        <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-semibold text-[#28685c]">Current balance</p><h2 id="payment-title" className="mt-1 text-2xl font-bold">Record payment</h2></div><button type="button" onClick={onClose} aria-label="Close payment form" className="h-11 w-11 shrink-0 rounded-full border text-xl">×</button></div>
        <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-[#f1f7f5] p-4 text-sm"><div><p className="text-xs text-[#64716c]">Paid by</p><strong className="mt-1 block">{debtor}</strong></div><div><p className="text-xs text-[#64716c]">Paid to</p><strong className="mt-1 block">{creditor}</strong></div><div className="col-span-2 border-t border-[#d9e7e2] pt-3"><p className="text-xs text-[#64716c]">Current balance</p><strong className="mt-1 block text-lg">{formatPennies(balance.amountPennies)}</strong></div></div>
        {error && <p role="alert" className="mt-4 rounded-xl bg-[#fff5f1] p-3 text-sm font-semibold text-[#914d3c]">{error}</p>}
        <div className="mt-5 space-y-4"><label className="block text-sm font-bold">Amount<span className="mt-2 flex h-12 items-center rounded-xl border focus-within:ring-4 focus-within:ring-[#dcece7]"><span className="pl-3 text-[#69746f]">£</span><input required inputMode="decimal" maxLength={INPUT_LIMITS.money} value={amount} onChange={(event) => setAmount(event.target.value)} className="h-full min-w-0 flex-1 rounded-xl px-2 outline-none" /></span></label><label className="block text-sm font-bold">Date<input required type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-2 h-12 w-full rounded-xl border px-3" /></label><label className="block text-sm font-bold">Notes <span className="font-normal text-[#89938f]">(optional)</span><textarea rows={3} maxLength={INPUT_LIMITS.settlementNotes} value={notes} onChange={(event) => setNotes(event.target.value)} className="mt-2 w-full resize-y rounded-xl border p-3" /></label></div>
        <div className="mt-6 grid grid-cols-2 gap-3"><button type="button" onClick={onClose} className="min-h-12 rounded-xl border font-bold">Cancel</button><button disabled={saving} className="min-h-12 rounded-xl bg-[#1f5b50] px-3 font-bold text-white disabled:opacity-50">{saving ? "Recording..." : "Record payment"}</button></div>
      </form>
    </div>
  );
}

function DirectionTotal({ label, balance, names, primary = false, adjustment = false }: { label: string; balance: NetOwedBalance | null; names: Map<string, string>; primary?: boolean; adjustment?: boolean }) {
  return <div className={`rounded-xl p-4 ${primary ? "bg-[#1f5b50] text-white" : "bg-white"}`}><p className={`text-xs font-semibold ${primary ? "text-[#c6ded8]" : "text-[#75807c]"}`}>{label}</p><p className="mt-1 text-xl font-bold">{balance ? `${adjustment ? "+" : ""}${formatPennies(balance.amountPennies)}` : formatPennies(0)}</p><p className={`mt-1 text-[11px] leading-4 ${primary ? "text-[#d7e8e3]" : "text-[#75807c]"}`}>{balance ? `${adjustment ? "Toward " : ""}${contributorName(names, balance.debtorContributorId)} owing ${contributorName(names, balance.creditorContributorId)}` : adjustment ? "No net payment effect" : "Settled"}</p></div>;
}

function DirectionSentence({ balance, names }: { balance: NetOwedBalance | null; names: Map<string, string> }) {
  return balance
    ? <p className="mt-1 text-lg font-bold">{contributorName(names, balance.debtorContributorId)} owes {contributorName(names, balance.creditorContributorId)} <span className="text-[#1f5b50]">{formatPennies(balance.amountPennies)}</span></p>
    : <p className="mt-1 text-lg font-bold text-[#1f5b50]">Settled · {formatPennies(0)}</p>;
}

function AllSettled({ compact = false }: { compact?: boolean }) {
  return <div className={`${compact ? "mt-5" : "mt-7"} rounded-2xl border border-[#d8e6e1] bg-[#f3f9f7] p-7 text-center`}><p className="text-3xl" aria-hidden>🎄</p><h2 className="mt-2 text-xl font-bold">All settled</h2><p className="mt-2 text-sm text-[#64716c]">You don&apos;t currently owe anyone and nobody owes you.</p></div>;
}

function LoadingState() {
  return <div className="mt-7 grid animate-pulse gap-4 sm:grid-cols-2"><div className="h-36 rounded-2xl bg-[#e8ecea]" /><div className="h-36 rounded-2xl bg-[#e8ecea]" /><div className="h-60 rounded-2xl bg-[#ecefed] sm:col-span-2" /></div>;
}

function contributorName(names: Map<string, string>, id: string) {
  const name = names.get(id);
  return name && name !== "Unknown contributor" ? name : "Unknown contributor (account link missing)";
}

function formatDate(value: string) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function todayInput() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function settlementSaveError(code?: string) {
  if (code === "42501") return "Only the payment receiver or Global Admin can confirm this payment.";
  if (code === "23514") return "This payment is no longer valid. Refresh and check the current outstanding balance.";
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") return "Apply the settlements migration before recording a payment.";
  return "This payment could not be recorded. Nothing was changed.";
}
