import { createClient } from "@/utils/supabase/client";
import {
  calculateNetOwedBalances,
  type NetOwedBalance,
  type PurchaseObligation,
  type SettlementLedgerEntry,
} from "../../lib/owed";
import { paymentStatusOf, type PaymentReceiptSource, type PaymentStatus } from "../../lib/payment-confirmation";

export type OwedObligationDetail = PurchaseObligation & {
  purchaseId: string;
  recipientName: string;
  description: string;
  purchaseDate: string;
};

/** One review action taken on a payment. Append-only; newest last. */
export type OwedReceiptDetail = {
  id: string;
  settlementId: string;
  action: "confirm" | "reject";
  amountPennies: number;
  reason: string | null;
  source: PaymentReceiptSource;
  reviewerContributorId: string;
  createdAt: string;
};

/** An active contributor, for the pickers on the admin-only payment form. */
export type OwedContributorOption = { id: string; name: string };

export type OwedSettlementDetail = SettlementLedgerEntry & {
  id: string;
  paymentDate: string;
  notes: string | null;
  createdAt: string;
  voidedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  confirmedAt: string | null;
  lastReviewedAt: string | null;
  /** The database's own generated status, not a second opinion computed here. */
  status: PaymentStatus;
  receipts: OwedReceiptDetail[];
};

export type OwedData = {
  eventId: string;
  currentContributorId: string;
  isAdmin: boolean;
  contributorNames: Map<string, string>;
  /** Active contributors only, name-sorted. Used by the admin payment form. */
  contributors: OwedContributorOption[];
  obligations: OwedObligationDetail[];
  settlements: OwedSettlementDetail[];
  balances: NetOwedBalance[];
};

/**
 * Every figure the Owed screen draws, for ONE event.
 *
 * The event is supplied by the caller -- ultimately by the URL, validated on
 * the server -- rather than looked up by year. The arithmetic below is
 * unchanged: the same obligations, the same confirmed-only settlement rule, the
 * same `calculateNetOwedBalances`. All that changed is which rows reach it.
 */
export async function loadOwedData(eventId: string): Promise<OwedData> {
  const db = createClient();
  const authResult = await db.auth.getUser();

  const user = authResult.data.user;
  if (authResult.error || !user) throw new Error("Your signed-in account could not be verified.");

  const [memberResult, contributorResult, recipientResult] = await Promise.all([
    db.from("app_members").select("person_id,contributor_id,role,active").eq("user_id", user.id).eq("active", true).maybeSingle(),
    db.from("contributors").select("id,person_id,active").eq("christmas_event_id", eventId),
    db.from("christmas_recipients").select("id,person_id").eq("christmas_event_id", eventId),
  ]);
  if (memberResult.error || !memberResult.data) throw new Error("Your active family membership could not be loaded.");
  if (contributorResult.error || recipientResult.error) throw new Error("Event contributor details could not be loaded.");
  const member = memberResult.data;

  const currentContributor = contributorResult.data.find((row) =>
    row.active && (
      row.id === member.contributor_id
      || row.person_id === member.person_id
    ),
  );
  if (!currentContributor) throw new Error("Your account is not a contributor to this event.");

  const recipientIds = recipientResult.data.map((row) => row.id);
  const personIds = [...new Set([
    ...contributorResult.data.map((row) => row.person_id),
    ...recipientResult.data.map((row) => row.person_id),
  ])];
  const [peopleResult, purchaseResult, settlementResult] = await Promise.all([
    personIds.length
      ? db.from("people").select("id,name").in("id", personIds)
      : Promise.resolve({ data: [], error: null }),
    recipientIds.length
      ? db.from("purchases")
        .select("id,christmas_recipient_id,description,checkout_payer_contributor_id,purchase_date")
        .in("christmas_recipient_id", recipientIds)
        .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    db.from("settlements")
      .select("id,payer_contributor_id,payee_contributor_id,amount_pennies,confirmed_amount_pennies,payment_date,notes,created_at,voided_at,rejected_at,rejection_reason,confirmed_at,last_reviewed_at,status")
      .eq("christmas_event_id", eventId)
      .order("payment_date", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);
  if (peopleResult.error || purchaseResult.error) throw new Error("Purchase responsibility details could not be loaded.");
  if (settlementResult.error) throw new Error(owedFeatureError(settlementResult.error.code));

  const purchases = purchaseResult.data ?? [];
  const purchaseIds = purchases.map((row) => row.id);
  const settlementIds = (settlementResult.data ?? []).map((row) => row.id);
  const [allocationResult, receiptResult] = await Promise.all([
    purchaseIds.length
      ? db.from("purchase_allocations")
        .select("purchase_id,contributor_id,responsibility_pennies")
        .in("purchase_id", purchaseIds)
      : Promise.resolve({ data: [], error: null }),
    // The review history behind each payment. Oldest first, because it reads as
    // a story: claimed, then part received, then the rest.
    settlementIds.length
      ? db.from("payment_receipts")
        .select("id,settlement_id,action,amount_pennies,reason,source,reviewer_contributor_id,created_at")
        .in("settlement_id", settlementIds)
        .order("created_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (allocationResult.error) throw new Error("Purchase responsibility allocations could not be loaded.");
  if (receiptResult.error) throw new Error(owedFeatureError(receiptResult.error.code));

  const personNames = new Map((peopleResult.data ?? []).map((row) => [row.id, row.name]));
  const contributorNames = new Map(contributorResult.data.map((row) => [
    row.id,
    personNames.get(row.person_id) ?? "Unknown contributor",
  ]));
  const recipientNames = new Map(recipientResult.data.map((row) => [
    row.id,
    personNames.get(row.person_id) ?? "Unknown recipient",
  ]));
  const purchaseById = new Map(purchases.map((row) => [row.id, row]));

  const obligations: OwedObligationDetail[] = (allocationResult.data ?? []).flatMap((allocation) => {
    const purchase = purchaseById.get(allocation.purchase_id);
    if (!purchase || allocation.responsibility_pennies <= 0 || allocation.contributor_id === purchase.checkout_payer_contributor_id) return [];
    return [{
      purchaseId: purchase.id,
      debtorContributorId: allocation.contributor_id,
      creditorContributorId: purchase.checkout_payer_contributor_id,
      amountPennies: allocation.responsibility_pennies,
      recipientName: recipientNames.get(purchase.christmas_recipient_id) ?? "Unknown recipient",
      description: purchase.description,
      purchaseDate: purchase.purchase_date,
    }];
  });

  const receiptsBySettlement = new Map<string, OwedReceiptDetail[]>();
  for (const row of receiptResult.data ?? []) {
    const receipt: OwedReceiptDetail = {
      id: row.id,
      settlementId: row.settlement_id,
      action: row.action,
      amountPennies: row.amount_pennies,
      reason: row.reason,
      source: row.source,
      reviewerContributorId: row.reviewer_contributor_id,
      createdAt: row.created_at,
    };
    receiptsBySettlement.set(row.settlement_id, [
      ...(receiptsBySettlement.get(row.settlement_id) ?? []),
      receipt,
    ]);
  }

  const settlements: OwedSettlementDetail[] = (settlementResult.data ?? []).map((row) => ({
    id: row.id,
    payerContributorId: row.payer_contributor_id,
    payeeContributorId: row.payee_contributor_id,
    amountPennies: row.amount_pennies,
    confirmedAmountPennies: row.confirmed_amount_pennies,
    paymentDate: row.payment_date,
    notes: row.notes,
    createdAt: row.created_at,
    voidedAt: row.voided_at,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    confirmedAt: row.confirmed_at,
    lastReviewedAt: row.last_reviewed_at,
    // The generated column is authoritative. `paymentStatusOf` is the fallback
    // for the moment between a deploy and the migration being applied, and the
    // two are asserted to agree in `payment-confirmation.test.ts`.
    status: (row.status as PaymentStatus | null) ?? paymentStatusOf({
      amountPennies: row.amount_pennies,
      confirmedAmountPennies: row.confirmed_amount_pennies,
      rejectedAt: row.rejected_at,
      voidedAt: row.voided_at,
    }),
    receipts: receiptsBySettlement.get(row.id) ?? [],
  }));

  return {
    eventId,
    currentContributorId: currentContributor.id,
    isAdmin: member.role === "admin",
    contributorNames,
    contributors: contributorResult.data
      .filter((row) => row.active)
      .map((row) => ({ id: row.id, name: contributorNames.get(row.id) ?? "Unknown contributor" }))
      .sort((left, right) => left.name.localeCompare(right.name, "en-GB")),
    obligations,
    settlements,
    balances: calculateNetOwedBalances(obligations, settlements),
  };
}

function owedFeatureError(code?: string) {
  if (code === "42703" || code === "PGRST204") {
    return "Payment confirmations are not ready yet. Apply the payment confirmations migration, then refresh.";
  }
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") {
    return "Owed and payments are not ready yet. Apply the settlements and payment confirmations migrations, then refresh.";
  }
  return "Payment history could not be loaded. Check your connection and try again.";
}
