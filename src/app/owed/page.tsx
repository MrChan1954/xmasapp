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
import {
  isAwaitingReview,
  paymentStatusLabel,
  payerStatusSummary,
  reviewPaymentError,
  unconfirmedPennies,
  validateConfirmationAmount,
  validateRejectionReason,
  type PaymentStatus,
} from "../../lib/payment-confirmation";
import { parsePoundsToPennies } from "../../lib/purchases";
import { INPUT_LIMITS, validateDateInput, validateOptionalText, validateUuid } from "../../lib/input-validation";
import { AppShell, PageHeader } from "../components/app-shell";
import { GarlandRule } from "../components/festive/garland";
import { notifyFamily } from "../components/notify-family";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  ModalHeader,
  MoneyInput,
  Notice,
  Segmented,
  Skeleton,
  Textarea,
  cx,
} from "../components/ui";
import { useRealtimeRefresh } from "../components/use-realtime-refresh";
import { loadOwedData, type OwedData, type OwedSettlementDetail } from "./owed-data";

type ViewMode = "mine" | "all";
/** Which review the receiver has chosen to make on one incoming payment. */
type ReviewChoice = "full" | "part" | "none";

export default function OwedPage() {
  const [data, setData] = useState<OwedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("mine");
  const [openPairKey, setOpenPairKey] = useState<string | null>(null);
  const [paymentBalance, setPaymentBalance] = useState<NetOwedBalance | null>(null);
  const [review, setReview] = useState<{ payment: OwedSettlementDetail; choice: ReviewChoice } | null>(null);

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

  // Balances are recomputed from purchases, their allocations, and settlements;
  // who appears at all depends on contributors and recipients. `refresh` never
  // re-raises the loading flag, so this updates the figures in place.
  //
  // A confirmation updates its settlement row in the same transaction as it
  // writes the receipt, so this existing subscription is what makes a pending
  // payment, its review and the Owed figure all move without a refresh.
  useRealtimeRefresh(
    [
      "settlements",
      "purchases",
      "purchase_allocations",
      "contributors",
      "christmas_recipients",
      "people",
    ],
    refresh,
  );

  const personalBalances = useMemo(() => data?.balances.filter((balance) =>
    balance.debtorContributorId === data.currentContributorId
    || balance.creditorContributorId === data.currentContributorId,
  ) ?? [], [data]);
  const personalSummary = data
    ? contributorOwedSummary(data.balances, data.currentContributorId)
    : { owedToYouPennies: 0, youOwePennies: 0 };

  // Payments somebody says they have sent ME, which nobody has confirmed yet.
  // This is the one thing on this screen that is waiting on the reader.
  const awaitingMyReview = useMemo(() => (data?.settlements ?? []).filter((payment) =>
    payment.payeeContributorId === data?.currentContributorId && isAwaitingReview(payment),
  ), [data]);

  // Payments I recorded that have not finished: still waiting, part received,
  // or refused. Anything fully confirmed has nothing left to say here.
  const myOpenPayments = useMemo(() => (data?.settlements ?? []).filter((payment) =>
    payment.payerContributorId === data?.currentContributorId
    && !payment.voidedAt
    && payment.status !== "confirmed",
  ), [data]);

  const names = data?.contributorNames ?? new Map<string, string>();
  const owedToYou = data ? personalBalances.filter((row) => row.creditorContributorId === data.currentContributorId) : [];
  const youOwe = data ? personalBalances.filter((row) => row.debtorContributorId === data.currentContributorId) : [];

  return (
    <AppShell width="narrow">
      <PageHeader
        title="Owed"
        description="See who owes whom, why, and which payments have been confirmed."
      />

      {error && <Notice tone="danger" className="mt-6">{error}</Notice>}
      {loading && <LoadingState />}

      {!loading && data && <>
        {awaitingMyReview.length > 0 && (
          <PendingReviewSection
            payments={awaitingMyReview}
            names={names}
            onChoose={(payment, choice) => setReview({ payment, choice })}
          />
        )}

        <section className="mt-6 grid gap-4 sm:grid-cols-2">
          <BalanceSummary label="You are owed" value={personalSummary.owedToYouPennies} detail="Money other contributors need to repay you" positive />
          <BalanceSummary label="You owe" value={personalSummary.youOwePennies} detail="Money you need to repay other contributors" />
        </section>

        {data.isAdmin && (
          <div className="mt-8 max-w-sm">
            <Segmented
              ariaLabel="Balance view"
              value={view}
              onChange={setView}
              options={[
                { value: "mine", label: "My balances" },
                { value: "all", label: "All balances" },
              ]}
            />
          </div>
        )}

        {view === "mine" ? (
          personalBalances.length === 0
            ? <AllSettled />
            : <div className="mt-6 grid items-start gap-5 lg:grid-cols-2">
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
          <section className="mt-6 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
            <h2 className="font-display text-xl font-semibold">All balances</h2>
            <p className="mt-1 text-sm text-ink-600">Current balances after purchases and confirmed payments.</p>
            {data.balances.length === 0 ? <AllSettled compact /> : (
              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {data.balances.map((balance) => <BalanceCard key={balance.pairKey} balance={balance} currentContributorId={data.currentContributorId} names={names} isAdmin onView={() => setOpenPairKey(balance.pairKey)} onPay={() => setPaymentBalance(balance)} allView />)}
              </div>
            )}
          </section>
        )}

        {myOpenPayments.length > 0 && (
          <MyPaymentsSection
            payments={myOpenPayments}
            names={names}
            onRefresh={refresh}
          />
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
        {review && <ReviewSheet
          payment={review.payment}
          choice={review.choice}
          names={names}
          onClose={() => setReview(null)}
          onReviewed={async () => { setReview(null); await refresh(); }}
        />}
      </>}
    </AppShell>
  );
}

/**
 * "Somebody says they paid you." The most important thing on the screen when it
 * is there, so it sits above the balances rather than inside a modal.
 *
 * Deliberately plain: a sentence, a figure, a date, three buttons. No jargon,
 * no ledger language, nothing to interpret.
 */
function PendingReviewSection({ payments, names, onChoose }: { payments: OwedSettlementDetail[]; names: Map<string, string>; onChoose: (payment: OwedSettlementDetail, choice: ReviewChoice) => void }) {
  return (
    <section className="mt-6 rounded-2xl border border-gold/40 bg-gold-soft p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold">
          {payments.length === 1 ? "A payment needs your confirmation" : `${payments.length} payments need your confirmation`}
        </h2>
        <Badge tone="gold">{payments.length === 1 ? "1 waiting" : `${payments.length} waiting`}</Badge>
      </div>
      <p className="mt-1 text-sm text-ink-600">Your balance only changes once you confirm what actually arrived.</p>

      <div className="mt-4 space-y-3">
        {payments.map((payment) => {
          const payer = contributorName(names, payment.payerContributorId);
          const remaining = unconfirmedPennies(payment);
          const partly = payment.confirmedAmountPennies > 0;
          return (
            <article key={payment.id} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-semibold">{payer} says they paid you</p>
                  <p className="mt-1 text-xs text-ink-600">Sent on {formatDate(payment.paymentDate)}</p>
                </div>
                <strong className="shrink-0 font-display text-2xl font-semibold tabular-nums text-accent">{formatPennies(payment.amountPennies)}</strong>
              </div>

              {partly && (
                <p className="mt-2 text-sm font-medium text-ink-600">
                  You have confirmed {formatPennies(payment.confirmedAmountPennies)} so far. {formatPennies(remaining)} is still unconfirmed.
                </p>
              )}
              {payment.notes && <p className="mt-2 break-words rounded-lg bg-surface-2 p-3 text-sm">{payment.notes}</p>}

              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <Button size="lg" onClick={() => onChoose(payment, "full")}>Received in full</Button>
                <Button variant="secondary" size="lg" onClick={() => onChoose(payment, "part")}>Received part</Button>
                <Button variant="dangerGhost" size="lg" onClick={() => onChoose(payment, "none")} className="border border-berry/30 bg-surface">Not received</Button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The payer's own view of what they have recorded.
 *
 * Only unfinished payments appear: waiting, part received, or refused. A
 * payment confirmed in full has already done its job and shows up in the
 * balance itself.
 */
function MyPaymentsSection({ payments, names, onRefresh }: { payments: OwedSettlementDetail[]; names: Map<string, string>; onRefresh: () => Promise<void> }) {
  const [cancelling, setCancelling] = useState<OwedSettlementDetail | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancelClaim = async (payment: OwedSettlementDetail) => {
    setBusyId(payment.id);
    setError(null);
    const validId = validateUuid(payment.id, "This payment record is invalid.");
    if (!validId.ok) { setError(validId.error); setBusyId(null); setCancelling(null); return; }
    const result = await createClient().rpc("void_settlement", { p_settlement_id: validId.value });
    if (result.error) {
      setError(result.error.code === "42501"
        ? "This payment can no longer be cancelled. Ask the person you paid, or a Global Admin."
        : "This payment could not be cancelled. Nothing was changed.");
    } else {
      await onRefresh();
    }
    setBusyId(null);
    setCancelling(null);
  };

  return (
    <section className="mt-6 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <h2 className="font-display text-xl font-semibold">Payments you have recorded</h2>
      <p className="mt-1 text-sm text-ink-600">These are waiting on the other person, or have come back with a problem.</p>
      {error && <Notice tone="danger" className="mt-3">{error}</Notice>}

      <div className="mt-4 space-y-3">
        {payments.map((payment) => {
          const payee = contributorName(names, payment.payeeContributorId);
          // Nothing confirmed and nothing refused: still entirely the payer's to
          // take back, and taking it back cannot move a balance.
          const canCancel = payment.status === "pending";
          return (
            <article key={payment.id} className="rounded-xl border border-line bg-surface-2 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-semibold">You paid {payee}</p>
                  <p className="mt-1 text-xs text-ink-600">Sent on {formatDate(payment.paymentDate)}</p>
                </div>
                <div className="shrink-0 text-right">
                  <strong className="font-display text-xl font-semibold tabular-nums">{formatPennies(payment.amountPennies)}</strong>
                  <div className="mt-1"><PaymentStatusBadge status={payment.status} /></div>
                </div>
              </div>
              <p className="mt-2 text-sm font-medium">{payerStatusSummary(payment)}</p>
              {payment.rejectionReason && (
                <p className="mt-2 break-words rounded-lg border border-berry-soft-border bg-berry-soft p-3 text-sm">
                  <span className="font-semibold">Reason: </span>{payment.rejectionReason}
                </p>
              )}
              {payment.status === "rejected" && (
                <p className="mt-2 text-xs leading-5 text-ink-600">This record stays in the Payment Log. If you pay again, record it as a new payment.</p>
              )}
              {canCancel && (
                <Button
                  variant="dangerGhost"
                  size="sm"
                  disabled={busyId === payment.id}
                  onClick={() => { setError(null); setCancelling(payment); }}
                  className="mt-3 border border-berry/30 bg-surface"
                >
                  {busyId === payment.id ? "Cancelling..." : "Cancel this payment"}
                </Button>
              )}
            </article>
          );
        })}
      </div>

      {cancelling && (
        <ConfirmDialog
          title={`Cancel your ${formatPennies(cancelling.amountPennies)} payment?`}
          body={`${contributorName(names, cancelling.payeeContributorId)} has not confirmed any of it yet, so nothing about your balance changes. The record stays in the Payment Log.`}
          confirmLabel="Cancel payment"
          busyLabel="Cancelling..."
          busy={busyId === cancelling.id}
          onCancel={() => setCancelling(null)}
          onConfirm={() => void cancelClaim(cancelling)}
        />
      )}
    </section>
  );
}

/**
 * The receiver's answer: all of it, some of it, or none of it.
 *
 * One modal for all three, because they are one decision. "Received in full"
 * needs no input and is a single press; the other two ask for the one thing
 * that makes them meaningful.
 */
function ReviewSheet({ payment, choice, names, onClose, onReviewed }: { payment: OwedSettlementDetail; choice: ReviewChoice; names: Map<string, string>; onClose: () => void; onReviewed: () => Promise<void> }) {
  const remaining = unconfirmedPennies(payment);
  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payer = contributorName(names, payment.payerContributorId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const validId = validateUuid(payment.id, "This payment record is invalid.");
    if (!validId.ok) { setError(validId.error); return; }

    let action: "confirm" | "reject";
    let amountPennies: number | null = null;
    let reasonText: string | null = null;

    if (choice === "none") {
      const validReason = validateRejectionReason(reason);
      if (!validReason.ok) { setError(validReason.error); return; }
      action = "reject";
      reasonText = validReason.reason;
    } else {
      // "Received in full" confirms exactly what is left, which is the whole
      // claim the first time and the remainder after a partial confirmation.
      const validAmount = choice === "full"
        ? { ok: true as const, pennies: remaining }
        : validateConfirmationAmount(amount, payment);
      if (!validAmount.ok) { setError(validAmount.error); return; }
      action = "confirm";
      amountPennies = validAmount.pennies;
    }

    setSaving(true);
    const result = await createClient().rpc("review_payment", {
      p_settlement_id: validId.value,
      p_action: action,
      p_amount_pennies: amountPennies,
      p_reason: reasonText,
    });
    if (result.error) {
      setError(reviewPaymentError(result.error.code));
      setSaving(false);
      return;
    }

    // The payer is the one side that has not heard. The database queued this
    // event inside the same transaction as the review, so this call only makes
    // it arrive sooner.
    const receiptId = (result.data as { id?: string } | null)?.id;
    if (receiptId) notifyFamily("payment_review", receiptId);

    await onReviewed();
  };

  const title = choice === "none"
    ? "Not received"
    : choice === "part" ? "How much did you receive?" : "Confirm you received this";

  return (
    <Modal labelledBy="review-title" onClose={onClose} size="md" surface="white" dismissible={!saving}>
      <form onSubmit={(event) => void submit(event)}>
        <ModalHeader
          id="review-title"
          eyebrow={`${payer} says they paid you`}
          title={title}
          onClose={onClose}
          closeLabel="Close payment review"
        />
        <div className="px-5 pb-6 sm:px-7 sm:pb-7">
          <div className="grid grid-cols-3 gap-3 rounded-xl border border-accent-soft-border bg-accent-soft p-4 text-sm">
            <div>
              <p className="text-xs font-medium text-ink-600">Claimed</p>
              <strong className="mt-1 block font-semibold tabular-nums">{formatPennies(payment.amountPennies)}</strong>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-600">Already confirmed</p>
              <strong className="mt-1 block font-semibold tabular-nums">{formatPennies(payment.confirmedAmountPennies)}</strong>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-600">Still unconfirmed</p>
              <strong className="mt-1 block font-semibold tabular-nums">{formatPennies(remaining)}</strong>
            </div>
          </div>

          {error && <Notice tone="danger" className="mt-4">{error}</Notice>}

          {choice === "full" && (
            <p className="mt-4 text-sm leading-6">
              This confirms {formatPennies(remaining)} arrived. {payer} will owe you {formatPennies(remaining)} less, and they will be told.
            </p>
          )}

          {choice === "part" && (
            <div className="mt-4">
              <Field label="How much did you receive?" required>
                <MoneyInput required maxLength={INPUT_LIMITS.money} value={amount} onValueChange={setAmount} />
              </Field>
              <p className="mt-2 text-xs leading-5 text-ink-600">
                Anything you do not confirm stays outstanding. {payer} keeps owing it until it arrives.
              </p>
            </div>
          )}

          {choice === "none" && (
            <div className="mt-4">
              <Field label="Why has it not arrived?" required>
                <Textarea
                  required
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Nothing has arrived in my bank yet."
                />
              </Field>
              <p className="mt-2 text-xs leading-5 text-ink-600">
                {payer} will see this. Your balance does not change, and they can record a new payment later.
              </p>
            </div>
          )}

          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button variant="secondary" size="lg" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="lg" variant={choice === "none" ? "danger" : "primary"} disabled={saving}>
              {saving ? "Saving..." : choice === "none" ? "Mark not received" : "Confirm"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function BalanceSummary({ label, value, detail, positive = false }: { label: string; value: number; detail: string; positive?: boolean }) {
  return (
    <div className={cx(
      "rounded-2xl border p-5 shadow-card sm:p-6",
      positive ? "dark border-pine-700 bg-linear-to-br from-pine-900 to-pine-800 text-white" : "border-line bg-surface",
    )}>
      <p className={cx("text-sm font-medium", positive ? "text-pine-100" : "text-ink-600")}>{label}</p>
      <p className="mt-2 font-display text-3xl font-semibold tabular-nums sm:text-4xl">{formatPennies(value)}</p>
      <p className={cx("mt-2 text-xs leading-5", positive ? "text-pine-100/90" : "text-ink-600")}>{detail}</p>
    </div>
  );
}

function BalanceSection({ title, empty, balances, currentContributorId, names, isAdmin, onView, onPay }: { title: string; empty: string; balances: NetOwedBalance[]; currentContributorId: string; names: Map<string, string>; isAdmin: boolean; onView: (balance: NetOwedBalance) => void; onPay: (balance: NetOwedBalance) => void }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      <GarlandRule className="mt-4" />
      {balances.length === 0
        ? <p className="mt-4 text-sm text-ink-600">{empty}</p>
        : <div className="mt-2 divide-y divide-line">{balances.map((balance) => <BalanceCard key={balance.pairKey} balance={balance} currentContributorId={currentContributorId} names={names} isAdmin={isAdmin} onView={() => onView(balance)} onPay={() => onPay(balance)} />)}</div>}
    </section>
  );
}

/** A ledger line, not a card-in-card: name left, amount right, actions beneath. */
function BalanceCard({ balance, currentContributorId, names, isAdmin, onView, onPay, allView = false }: { balance: NetOwedBalance; currentContributorId: string; names: Map<string, string>; isAdmin: boolean; onView: () => void; onPay: () => void; allView?: boolean }) {
  const debtor = contributorName(names, balance.debtorContributorId);
  const creditor = contributorName(names, balance.creditorContributorId);
  const iOweThis = balance.debtorContributorId === currentContributorId;
  const iAmOwedThis = balance.creditorContributorId === currentContributorId;
  const title = allView
    ? `${debtor} owes ${creditor}`
    : iAmOwedThis ? `${debtor} owes you` : `You owe ${creditor}`;
  // The person who owes it can now say they have paid; the person owed can
  // record what they received, which confirms it in one step.
  const recordLabel = iOweThis
    ? "I have paid this"
    : iAmOwedThis ? "Record a payment received" : "Record payment";
  return (
    <article className="py-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="min-w-0 truncate font-semibold">{title}</p>
        <p className="shrink-0 font-display text-2xl font-semibold tabular-nums text-ink-900">{formatPennies(balance.amountPennies)}</p>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onView}>Why this balance?</Button>
        {(iOweThis || iAmOwedThis || isAdmin)
          ? <Button variant="tonal" size="sm" onClick={onPay}>{recordLabel}</Button>
          : <span className="text-xs font-medium text-ink-400">Only these two can record a payment</span>}
      </div>
    </article>
  );
}

function Breakdown({ pairKeyValue, data, onClose, onPay, onRefresh }: { pairKeyValue: string; data: OwedData; onClose: () => void; onPay: (balance: NetOwedBalance) => void; onRefresh: () => Promise<void> }) {
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);
  const [confirmingVoid, setConfirmingVoid] = useState<{ id: string; label: string } | null>(null);
  const ids = pairKeyValue.split("|");
  const pairObligations = data.obligations.filter((row) => pairKey(row.debtorContributorId, row.creditorContributorId) === pairKeyValue);
  const pairSettlements = data.settlements.filter((row) => pairKey(row.payerContributorId, row.payeeContributorId) === pairKeyValue);
  const names = data.contributorNames;
  const explanation = calculatePairBalanceExplanation(ids[0], ids[1], pairObligations, pairSettlements);
  const balance = explanation.currentBalance;
  const canRecord = balance && (
    data.isAdmin
    || balance.creditorContributorId === data.currentContributorId
    || balance.debtorContributorId === data.currentContributorId
  );

  const voidPayment = async (settlementId: string) => {
    setVoidingId(settlementId);
    setVoidError(null);
    const validSettlementId = validateUuid(settlementId, "This payment record is invalid.");
    if (!validSettlementId.ok) { setVoidError(validSettlementId.error); setVoidingId(null); setConfirmingVoid(null); return; }
    const result = await createClient().rpc("void_settlement", { p_settlement_id: validSettlementId.value });
    if (result.error) setVoidError("This payment could not be voided. Nothing was changed.");
    else await onRefresh();
    setVoidingId(null);
    setConfirmingVoid(null);
  };

  return (
    <Modal labelledBy="breakdown-title" onClose={onClose} size="lg" dismissible={!confirmingVoid}>
      <ModalHeader
        id="breakdown-title"
        eyebrow="Current balance"
        title={balance ? `${contributorName(names, balance.debtorContributorId)} owes ${contributorName(names, balance.creditorContributorId)}` : "Settled"}
        onClose={onClose}
        closeLabel="Close breakdown"
      />
      <div className="px-5 pb-6 sm:px-7 sm:pb-7">
        <p className="font-display text-4xl font-semibold tabular-nums text-accent">{formatPennies(balance?.amountPennies ?? 0)}</p>
        {!balance && <p className="mt-1 text-sm text-ink-600">{contributorName(names, ids[0])} and {contributorName(names, ids[1])} have no current balance.</p>}

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <DirectionTotal label="After purchases" balance={explanation.purchaseBalance} names={names} />
          <DirectionTotal label="Confirmed payments" balance={explanation.paymentAdjustment} names={names} adjustment />
          <DirectionTotal label="Current balance" balance={balance} names={names} primary />
        </div>

        <section className="mt-5 rounded-2xl border border-line bg-surface p-5">
          <h3 className="font-display text-lg font-semibold">Why this balance?</h3>
          <p className="mt-1 text-xs leading-5 text-ink-600">Each direction is shown first, then the app nets them into one purchase balance.</p>
          {explanation.purchaseDirections.length === 0 ? (
            <p className="mt-4 text-sm text-ink-600">No active purchases create a balance for this pair.</p>
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
                    <div className="flex items-center justify-between gap-3 border-b border-line pb-2">
                      <h4 className="text-sm font-semibold text-ink-600">{debtor} owes {creditor}</h4>
                      <strong className="font-semibold tabular-nums">{formatPennies(direction.amountPennies)}</strong>
                    </div>
                    <div className="mt-2 space-y-2">
                      {directionRows.map((row, index) => (
                        <div key={`${row.purchaseId}-${row.debtorContributorId}-${index}`} className="rounded-xl bg-surface-2 p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <p className="font-semibold">{row.recipientName} — {row.description}</p>
                              <p className="mt-1 text-sm font-medium text-ink-600">{debtor} owes {creditor}</p>
                            </div>
                            <strong className="shrink-0 font-semibold tabular-nums">{formatPennies(row.amountPennies)}</strong>
                          </div>
                          <p className="mt-2 text-xs leading-5 text-ink-600">{creditor} paid {debtor}&apos;s share at checkout · {formatDate(row.purchaseDate)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className="rounded-xl border border-accent-soft-border bg-accent-soft p-4">
                <p className="text-xs font-semibold tracking-eyebrow text-accent uppercase">Net purchase balance</p>
                <DirectionSentence balance={explanation.purchaseBalance} names={names} />
              </div>
            </div>
          )}
        </section>

        <section className="mt-4 rounded-2xl border border-line bg-surface p-5">
          <h3 className="font-display text-lg font-semibold">Payments recorded</h3>
          <p className="mt-1 text-xs leading-5 text-ink-600">Only the amount the receiver has confirmed changes the balance.</p>
          {voidError && <Notice tone="danger" className="mt-3">{voidError}</Notice>}
          {pairSettlements.length === 0 ? (
            <p className="mt-4 text-sm text-ink-600">No payments have been recorded.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {pairSettlements.map((row) => {
                const payer = contributorName(names, row.payerContributorId);
                const payee = contributorName(names, row.payeeContributorId);
                const remaining = unconfirmedPennies(row);
                return (
                  <div key={row.id} className={cx("rounded-xl border p-4", row.voidedAt ? "border-line bg-surface-3 text-ink-600" : "border-line bg-surface-2")}>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-semibold">{payer} paid {payee}</p>
                        <p className="mt-1 text-xs">{formatDate(row.paymentDate)}{row.voidedAt ? ` · Voided ${formatDate(row.voidedAt)}` : ""}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <strong className={cx("font-semibold tabular-nums", row.voidedAt ? "line-through" : "text-accent")}>{formatPennies(row.amountPennies)}</strong>
                        <div className="mt-1"><PaymentStatusBadge status={row.status} /></div>
                      </div>
                    </div>

                    <p className="mt-2 text-xs leading-5 text-ink-600">
                      {row.voidedAt
                        ? "Voided — this no longer affects the current balance."
                        : row.confirmedAmountPennies === 0
                          ? `Nothing confirmed yet, so this has not changed the balance.${remaining > 0 && !row.rejectedAt ? ` ${payee} still has ${formatPennies(remaining)} to review.` : ""}`
                          : `${formatPennies(row.confirmedAmountPennies)} confirmed by ${payee}, which shifts the balance that much toward ${payee} owing ${payer}.${remaining > 0 ? ` ${formatPennies(remaining)} of the claim is still unconfirmed.` : ""}`}
                    </p>
                    {row.rejectionReason && <p className="mt-2 break-words text-sm"><span className="font-semibold">Reason: </span>{row.rejectionReason}</p>}
                    {row.notes && <p className="mt-2 break-words text-sm">{row.notes}</p>}

                    {row.receipts.length > 0 && (
                      <ol className="mt-3 space-y-1 border-t border-line pt-2 text-xs text-ink-600">
                        {row.receipts.map((receipt) => (
                          <li key={receipt.id} className="flex items-baseline justify-between gap-3">
                            <span>
                              {receipt.source === "migration"
                                ? "Recorded before confirmations existed"
                                : receipt.action === "confirm"
                                  ? `${contributorName(names, receipt.reviewerContributorId)} confirmed ${formatPennies(receipt.amountPennies)}`
                                  : `${contributorName(names, receipt.reviewerContributorId)} marked ${formatPennies(receipt.amountPennies)} as not received`}
                            </span>
                            <time className="shrink-0 tabular-nums">{formatDate(receipt.createdAt)}</time>
                          </li>
                        ))}
                      </ol>
                    )}

                    {data.isAdmin && !row.voidedAt && (
                      <Button
                        variant="dangerGhost"
                        size="sm"
                        disabled={voidingId === row.id}
                        onClick={() => { setVoidError(null); setConfirmingVoid({ id: row.id, label: `${formatPennies(row.amountPennies)} payment from ${payer} to ${payee}` }); }}
                        className="mt-3 border border-berry/30 bg-surface"
                      >
                        {voidingId === row.id ? "Voiding..." : "Void payment"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <div className="mt-5 flex gap-3">
          <Button variant="secondary" size="lg" onClick={onClose} className="flex-1">Close</Button>
          {canRecord && balance && <Button size="lg" onClick={() => onPay(balance)} className="flex-1">Record payment</Button>}
        </div>
      </div>

      {confirmingVoid && (
        <ConfirmDialog
          title={`Void ${confirmingVoid.label}?`}
          body="This removes its effect from the current balance. The history record will be kept."
          confirmLabel="Void payment"
          busyLabel="Voiding..."
          busy={voidingId === confirmingVoid.id}
          onCancel={() => setConfirmingVoid(null)}
          onConfirm={() => void voidPayment(confirmingVoid.id)}
        />
      )}
    </Modal>
  );
}

/**
 * Recording a payment.
 *
 * The same form for both sides, but it must be honest about what pressing Save
 * does, and that depends entirely on who is pressing it: the receiver's record
 * settles money immediately, the payer's asks somebody to agree first.
 */
function PaymentSheet({ balance, data, onClose, onSaved }: { balance: NetOwedBalance; data: OwedData; onClose: () => void; onSaved: () => Promise<void> }) {
  // Claims already waiting on the receiver have reserved part of this balance,
  // and the database enforces that. Showing the same figure here means somebody
  // finds out before they type, not after they press Save.
  const alreadyClaimed = data.settlements
    .filter((payment) =>
      payment.payerContributorId === balance.debtorContributorId
      && payment.payeeContributorId === balance.creditorContributorId
      && isAwaitingReview(payment),
    )
    .reduce((total, payment) => total + unconfirmedPennies(payment), 0);
  const claimable = Math.max(0, balance.amountPennies - alreadyClaimed);

  const [amount, setAmount] = useState((claimable / 100).toFixed(2));
  const [date, setDate] = useState(todayInput());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debtor = contributorName(data.contributorNames, balance.debtorContributorId);
  const creditor = contributorName(data.contributorNames, balance.creditorContributorId);
  const iAmPayer = balance.debtorContributorId === data.currentContributorId;
  const iAmReceiver = balance.creditorContributorId === data.currentContributorId;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = parsePoundsToPennies(amount);
    if (!parsed.ok) { setError(parsed.error); return; }
    if (parsed.pennies <= 0) { setError(`Enter an amount greater than ${formatPennies(0)}.`); return; }
    if (parsed.pennies > claimable) {
      setError(alreadyClaimed > 0
        ? `Only ${formatPennies(claimable)} is left to record. ${formatPennies(alreadyClaimed)} is already waiting for ${creditor} to confirm.`
        : `The payment cannot be more than the ${formatPennies(balance.amountPennies)} outstanding.`);
      return;
    }
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

    // Whoever has not just acted needs to hear: the receiver is asked to
    // confirm a claim, or the payer learns their repayment was acknowledged.
    const settlementId = (result.data as { id?: string } | null)?.id;
    if (settlementId) notifyFamily("payment", settlementId);

    await onSaved();
  };

  return (
    <Modal labelledBy="payment-title" onClose={onClose} size="md" surface="white" dismissible={!saving}>
      <form onSubmit={(event) => void save(event)}>
        <ModalHeader
          id="payment-title"
          eyebrow="Current balance"
          title={iAmPayer ? "Tell them you have paid" : iAmReceiver ? "Record a payment you received" : "Record a payment"}
          onClose={onClose}
          closeLabel="Close payment form"
        />
        <div className="px-5 pb-6 sm:px-7 sm:pb-7">
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-accent-soft-border bg-accent-soft p-4 text-sm">
            <div><p className="text-xs font-medium text-ink-600">Paid by</p><strong className="mt-1 block font-semibold">{debtor}</strong></div>
            <div><p className="text-xs font-medium text-ink-600">Paid to</p><strong className="mt-1 block font-semibold">{creditor}</strong></div>
            <div className="col-span-2 border-t border-accent-soft-border pt-3">
              <p className="text-xs font-medium text-ink-600">Current balance</p>
              <strong className="mt-1 block font-display text-lg font-semibold tabular-nums">{formatPennies(balance.amountPennies)}</strong>
              {alreadyClaimed > 0 && (
                <p className="mt-1 text-xs text-ink-600">
                  {formatPennies(alreadyClaimed)} of this is already waiting for {creditor} to confirm, so {formatPennies(claimable)} is left to record.
                </p>
              )}
            </div>
          </div>

          <p className="mt-3 text-xs leading-5 text-ink-600">
            {iAmReceiver
              ? "You are the person being paid, so this counts as confirmed straight away and reduces the balance."
              : `${creditor} will be asked to confirm how much arrived. The balance changes when they do, not now.`}
          </p>

          {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
          <div className="mt-5 space-y-4">
            <Field label="Amount" required>
              <MoneyInput required maxLength={INPUT_LIMITS.money} value={amount} onValueChange={setAmount} />
            </Field>
            <Field label="Date" required>
              <Input required type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </Field>
            <Field label={<>Notes <span className="font-normal text-ink-400">(optional)</span></>}>
              <Textarea rows={3} maxLength={INPUT_LIMITS.settlementNotes} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </Field>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button variant="secondary" size="lg" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="lg" disabled={saving}>{saving ? "Recording..." : iAmPayer ? "I have paid this" : "Record payment"}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const tone = status === "confirmed"
    ? "success"
    : status === "rejected" ? "danger" : status === "voided" ? "neutral" : status === "partially_confirmed" ? "gold" : "warning";
  return <Badge tone={tone}>{paymentStatusLabel(status)}</Badge>;
}

function DirectionTotal({ label, balance, names, primary = false, adjustment = false }: { label: string; balance: NetOwedBalance | null; names: Map<string, string>; primary?: boolean; adjustment?: boolean }) {
  return (
    <div className={cx("rounded-xl border p-4", primary ? "dark border-pine-700 bg-pine-800 text-white" : "border-line bg-surface")}>
      <p className={cx("text-xs font-medium", primary ? "text-pine-100" : "text-ink-600")}>{label}</p>
      <p className="mt-1 font-display text-xl font-semibold tabular-nums">{balance ? `${adjustment ? "+" : ""}${formatPennies(balance.amountPennies)}` : formatPennies(0)}</p>
      <p className={cx("mt-1 text-[11px] leading-4", primary ? "text-pine-100/90" : "text-ink-600")}>{balance ? `${adjustment ? "Toward " : ""}${contributorName(names, balance.debtorContributorId)} owing ${contributorName(names, balance.creditorContributorId)}` : adjustment ? "No confirmed payment effect" : "Settled"}</p>
    </div>
  );
}

function DirectionSentence({ balance, names }: { balance: NetOwedBalance | null; names: Map<string, string> }) {
  return balance
    ? <p className="mt-1 text-lg font-semibold">{contributorName(names, balance.debtorContributorId)} owes {contributorName(names, balance.creditorContributorId)} <span className="tabular-nums text-accent">{formatPennies(balance.amountPennies)}</span></p>
    : <p className="mt-1 text-lg font-semibold text-accent">Settled · {formatPennies(0)}</p>;
}

function AllSettled({ compact = false }: { compact?: boolean }) {
  return (
    <EmptyState
      className={compact ? "mt-5" : "mt-8"}
      illustration="tree"
      title="All settled"
      body="You don't currently owe anyone and nobody owes you."
    />
  );
}

function LoadingState() {
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2">
      <Skeleton className="h-36 rounded-2xl" />
      <Skeleton className="h-36 rounded-2xl" />
      <Skeleton className="h-60 rounded-2xl sm:col-span-2" />
    </div>
  );
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
  if (code === "42501") return "Only the payer, the receiver or Global Admin can record this payment.";
  if (code === "23514") return "This payment is no longer valid. Refresh and check the current outstanding balance, including anything already awaiting confirmation.";
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") return "Apply the payment confirmations migration before recording a payment.";
  return "This payment could not be recorded. Nothing was changed.";
}
