import { createClient } from "../../../utils/supabase/client";
import {
  calculateNetOwedBalances,
  type NetOwedBalance,
  type PurchaseObligation,
  type SettlementLedgerEntry,
} from "../../lib/owed";

const CHRISTMAS_YEAR = 2026;

export type OwedObligationDetail = PurchaseObligation & {
  purchaseId: string;
  recipientName: string;
  description: string;
  purchaseDate: string;
};

export type OwedSettlementDetail = SettlementLedgerEntry & {
  id: string;
  paymentDate: string;
  notes: string | null;
  createdAt: string;
  voidedAt: string | null;
};

export type OwedData = {
  eventId: string;
  currentContributorId: string;
  isAdmin: boolean;
  contributorNames: Map<string, string>;
  obligations: OwedObligationDetail[];
  settlements: OwedSettlementDetail[];
  balances: NetOwedBalance[];
};

export async function loadOwedData(): Promise<OwedData> {
  const db = createClient();
  const [authResult, eventResult] = await Promise.all([
    db.auth.getUser(),
    db.from("christmas_events").select("id").eq("year", CHRISTMAS_YEAR).maybeSingle(),
  ]);

  const user = authResult.data.user;
  if (authResult.error || !user) throw new Error("Your signed-in account could not be verified.");
  if (eventResult.error || !eventResult.data) throw new Error("Christmas 2026 could not be loaded.");
  const eventId = eventResult.data.id;

  const [memberResult, contributorResult, recipientResult] = await Promise.all([
    db.from("app_members").select("person_id,contributor_id,role,active").eq("user_id", user.id).eq("active", true).maybeSingle(),
    db.from("contributors").select("id,person_id,active").eq("christmas_event_id", eventId),
    db.from("christmas_recipients").select("id,person_id").eq("christmas_event_id", eventId),
  ]);
  if (memberResult.error || !memberResult.data) throw new Error("Your active family membership could not be loaded.");
  if (contributorResult.error || recipientResult.error) throw new Error("Christmas contributor details could not be loaded.");
  const member = memberResult.data;

  const currentContributor = contributorResult.data.find((row) =>
    row.active && (
      row.id === member.contributor_id
      || row.person_id === member.person_id
    ),
  );
  if (!currentContributor) throw new Error("Your account is not linked to an active Christmas contributor.");

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
      .select("id,payer_contributor_id,payee_contributor_id,amount_pennies,payment_date,notes,created_at,voided_at")
      .eq("christmas_event_id", eventId)
      .order("payment_date", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);
  if (peopleResult.error || purchaseResult.error) throw new Error("Purchase responsibility details could not be loaded.");
  if (settlementResult.error) throw new Error(owedFeatureError(settlementResult.error.code));

  const purchases = purchaseResult.data ?? [];
  const purchaseIds = purchases.map((row) => row.id);
  const allocationResult = purchaseIds.length
    ? await db.from("purchase_allocations")
      .select("purchase_id,contributor_id,responsibility_pennies")
      .in("purchase_id", purchaseIds)
    : { data: [], error: null };
  if (allocationResult.error) throw new Error("Purchase responsibility allocations could not be loaded.");

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

  const settlements: OwedSettlementDetail[] = (settlementResult.data ?? []).map((row) => ({
    id: row.id,
    payerContributorId: row.payer_contributor_id,
    payeeContributorId: row.payee_contributor_id,
    amountPennies: row.amount_pennies,
    paymentDate: row.payment_date,
    notes: row.notes,
    createdAt: row.created_at,
    voidedAt: row.voided_at,
  }));

  return {
    eventId,
    currentContributorId: currentContributor.id,
    isAdmin: member.role === "admin",
    contributorNames,
    obligations,
    settlements,
    balances: calculateNetOwedBalances(obligations, settlements),
  };
}

function owedFeatureError(code?: string) {
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") {
    return "Owed and payments are not ready yet. Apply the settlements migration, then refresh.";
  }
  return "Payment history could not be loaded. Check your connection and try again.";
}
