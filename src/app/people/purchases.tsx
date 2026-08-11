"use client";

<<<<<<< HEAD
import Link from "next/link";
=======
>>>>>>> 7534a2d (redesign and realtime)
import { useCallback, useEffect, useState } from "react";
import { formatPennies } from "@/lib/currency";
import {
  normalizePurchaseStatus,
  purchaseLifecycleLabel,
  type PurchaseStatus,
} from "@/lib/purchases";
import { createClient } from "../../../utils/supabase/client";
<<<<<<< HEAD
=======
import { IconPlus } from "../components/icons";
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Notice,
  Segmented,
  Skeleton,
} from "../components/ui";
>>>>>>> 7534a2d (redesign and realtime)

type Purchase = {
  id: string;
  christmas_recipient_id: string;
  description: string;
  actual_price_pennies: number;
  checkout_payer_contributor_id: string;
  purchase_date: string;
  retailer: string | null;
  notes: string | null;
  status: string;
  split_type: "automatic" | "custom";
  gift_location_person_id: string | null;
};

type Allocation = {
  purchase_id: string;
  contributor_id: string;
  responsibility_pennies: number;
};

export function Purchases({
  recipientId,
  onMetricsChange,
}: {
  recipientId: string;
  onMetricsChange: (spentPennies: number, count: number) => void;
}) {
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [contributorNames, setContributorNames] = useState<Map<string, string>>(new Map());
  const [locationNames, setLocationNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Purchase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadPurchases = useCallback(async () => {
    setLoading(true);
    const db = createClient();
    const purchaseResult = await db
      .from("purchases")
      .select("id,christmas_recipient_id,description,actual_price_pennies,checkout_payer_contributor_id,gift_location_person_id,purchase_date,retailer,notes,status,split_type")
      .eq("christmas_recipient_id", recipientId)
      .is("deleted_at", null)
      .order("purchase_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (purchaseResult.error) {
      setError(purchaseError("load", purchaseResult.error.code));
      setPurchases(null);
      setLoading(false);
      return false;
    }

    const nextPurchases = purchaseResult.data as Purchase[];
    const purchaseIds = nextPurchases.map((row) => row.id);
    const allocationResult = purchaseIds.length
      ? await db.from("purchase_allocations").select("purchase_id,contributor_id,responsibility_pennies").in("purchase_id", purchaseIds)
      : { data: [], error: null };
    if (allocationResult.error) {
      setError("Purchase responsibility details could not be loaded.");
      setPurchases(null);
      setLoading(false);
      return false;
    }

    const nextAllocations = allocationResult.data as Allocation[];
    const contributorIds = [...new Set([
      ...nextPurchases.map((row) => row.checkout_payer_contributor_id),
      ...nextAllocations.map((row) => row.contributor_id),
    ])];
    const contributorResult = contributorIds.length
      ? await db.from("contributors").select("id,person_id").in("id", contributorIds)
      : { data: [], error: null };
    if (contributorResult.error) {
      setError("Checkout payer names could not be loaded.");
      setPurchases(null);
      setLoading(false);
      return false;
    }
    const personIds = [...new Set([
      ...contributorResult.data.map((row) => row.person_id),
      ...nextPurchases.flatMap((row) => row.gift_location_person_id ? [row.gift_location_person_id] : []),
    ])];
    const peopleResult = personIds.length
      ? await db.from("people").select("id,name").in("id", personIds)
      : { data: [], error: null };
    if (peopleResult.error) {
      setError("Checkout payer names could not be loaded.");
      setPurchases(null);
      setLoading(false);
      return false;
    }
    const peopleById = new Map(peopleResult.data.map((row) => [row.id, row.name]));
    setLocationNames(peopleById);
    setContributorNames(new Map(contributorResult.data.flatMap((row) => {
      const name = peopleById.get(row.person_id);
      return name ? [[row.id, name] as [string, string]] : [];
    })));
    setPurchases(nextPurchases);
    setAllocations(nextAllocations);
    onMetricsChange(
      nextPurchases.reduce((sum, row) => sum + row.actual_price_pennies, 0),
      nextPurchases.length,
    );
    setError(null);
    setLoading(false);
    return true;
  }, [onMetricsChange, recipientId]);

  useEffect(() => {
    const handle = window.setTimeout(() => void loadPurchases(), 0);
    return () => window.clearTimeout(handle);
  }, [loadPurchases]);

  const updateStatus = async (purchase: Purchase, status: PurchaseStatus) => {
    setBusy(purchase.id);
    setError(null);
    setNotice(null);
    const result = await createClient().rpc("set_purchase_status", {
      p_purchase_id: purchase.id,
      p_status: status,
    });
    if (result.error) {
      setError(purchaseError("status", result.error.code));
      setBusy(null);
      return;
    }
    await loadPurchases();
    setNotice(`“${purchase.description}” is now ${purchaseLifecycleLabel(status).toLowerCase()}.`);
    setBusy(null);
  };

  const removePurchase = async (purchase: Purchase) => {
    setBusy(purchase.id);
    setError(null);
    setNotice(null);
    const result = await createClient().rpc("void_purchase", {
      p_purchase_id: purchase.id,
    });
    if (result.error) {
      setError(purchaseError("remove", result.error.code));
      setBusy(null);
      return;
    }
    await loadPurchases();
    setConfirming(null);
    setNotice(`“${purchase.description}” was removed from Christmas spending. Its history was preserved.`);
    setBusy(null);
  };

  return (
<<<<<<< HEAD
    <section className="rounded-2xl border border-[#e3e1d8] bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-lg font-bold">Purchases</h3><p className="mt-1 text-xs text-[#7b8581]">Actual gifts bought for this person.</p></div>
        <Link href={`/add-purchase?recipient=${encodeURIComponent(recipientId)}`} className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[#174f45] px-4 text-sm font-bold text-white shadow-sm sm:w-auto">+ Add purchase</Link>
      </div>

      {notice && <p role="status" className="mt-4 rounded-xl bg-[#edf7f3] p-3 text-sm font-semibold text-[#28685c]">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-[#fff2ed] p-3 text-sm font-semibold text-[#9a503c]">{error}</p>}
=======
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold">Purchases</h3>
          <p className="mt-1 text-xs leading-5 text-ink-600">Actual gifts bought for this person.</p>
        </div>
        <ButtonLink href={`/add-purchase?recipient=${encodeURIComponent(recipientId)}`} className="w-full sm:w-auto">
          <IconPlus size={16} />
          Add purchase
        </ButtonLink>
      </div>

      {notice && <Notice tone="success" className="mt-4">{notice}</Notice>}
      {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
>>>>>>> 7534a2d (redesign and realtime)

      {loading ? (
        <div className="mt-5 grid gap-3 md:grid-cols-2"><PurchaseSkeleton /><PurchaseSkeleton /></div>
      ) : purchases === null ? (
<<<<<<< HEAD
        <button type="button" onClick={() => void loadPurchases()} className="mt-5 min-h-11 rounded-xl border px-4 text-sm font-bold text-[#28685c]">Try loading purchases again</button>
      ) : purchases.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed border-[#d7d8d1] bg-[#faf9f5] px-5 py-7 text-center"><span className="text-2xl" aria-hidden>🎁</span><p className="mt-2 text-sm font-semibold text-[#7b8581]">No purchases yet.</p></div>
=======
        <Button variant="tonal" onClick={() => void loadPurchases()} className="mt-5">Try loading purchases again</Button>
      ) : purchases.length === 0 ? (
        <EmptyState
          className="mt-5"
          illustration="stocking"
          title="No purchases yet"
          body="When a gift is bought for this person, record it here so budgets stay accurate."
        />
>>>>>>> 7534a2d (redesign and realtime)
      ) : (
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {purchases.map((purchase) => {
            const status = normalizePurchaseStatus(purchase.status) ?? "purchased";
            const purchaseAllocations = allocations.filter((row) => row.purchase_id === purchase.id);
            return (
<<<<<<< HEAD
              <article key={purchase.id} className="rounded-xl border border-[#e3e8e5] bg-[#fbfcfb] p-4">
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="break-words font-bold">{purchase.description}</h4>{purchase.retailer && <p className="mt-1 text-sm font-semibold text-[#69746f]">{purchase.retailer}</p>}</div><strong className="shrink-0 text-lg text-[#28685c]">{formatPennies(purchase.actual_price_pennies)}</strong></div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#7b8581]"><span>Paid at checkout by <strong className="text-[#4f5b57]">{contributorNames.get(purchase.checkout_payer_contributor_id) ?? "Unknown contributor"}</strong></span>{purchase.gift_location_person_id && <span>Stored with <strong className="text-[#4f5b57]">{locationNames.get(purchase.gift_location_person_id) ?? "Unknown person"}</strong></span>}<span>{formatPurchaseDate(purchase.purchase_date)}</span></div>
                {purchase.notes && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[#69746f]">{purchase.notes}</p>}
                <div className="mt-3 flex items-center justify-between gap-3"><span className="rounded-full bg-[#edf7f3] px-2.5 py-1 text-[10px] font-bold uppercase text-[#28685c]">{purchaseLifecycleLabel(status)}</span><span className="text-[10px] font-bold uppercase text-[#89938f]">{purchase.split_type === "automatic" ? "Automatic split" : "Custom split"}</span></div>

                {purchaseAllocations.length > 0 && (
                  <details className="mt-3 rounded-xl bg-white px-3 py-2 text-sm"><summary className="min-h-11 cursor-pointer py-3 text-xs font-bold text-[#60706a]">Responsibility split</summary><div className="mt-2 space-y-1 border-t pt-2">{purchaseAllocations.map((allocation) => <div key={allocation.contributor_id} className="flex justify-between gap-3 text-xs"><span>{contributorNames.get(allocation.contributor_id) ?? "Unknown contributor"}</span><strong>{formatPennies(allocation.responsibility_pennies)}</strong></div>)}</div></details>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <div className="grid min-w-52 flex-1 grid-cols-2 rounded-xl border border-[#cad5d0] bg-white p-1" role="group" aria-label={`${purchase.description} status`}>
                    {(["purchased", "wrapped"] as const).map((option) => (
                      <button key={option} type="button" aria-pressed={status === option} disabled={busy === purchase.id || status === option} onClick={() => void updateStatus(purchase, option)} className={`min-h-11 rounded-lg px-3 text-xs font-bold transition disabled:cursor-default ${status === option ? "bg-[#174f45] text-white" : "text-[#28685c] disabled:opacity-100"}`}>{purchaseLifecycleLabel(option)}</button>
                    ))}
                  </div>
                  <Link href={`/add-purchase?edit=${encodeURIComponent(purchase.id)}`} className="inline-flex min-h-11 items-center rounded-xl border bg-white px-3 text-xs font-bold">Edit</Link>
                  <button type="button" disabled={busy === purchase.id} onClick={() => setConfirming(purchase)} className="min-h-11 rounded-xl px-3 text-xs font-bold text-[#9a503c] disabled:opacity-50">Remove</button>
                </div>

                {confirming?.id === purchase.id && (
                  <div className="mt-3 rounded-xl border border-[#ead1c7] bg-[#fff5f1] p-3"><p className="text-sm font-bold">Remove “{purchase.description}”?</p><p className="mt-1 text-xs leading-5 text-[#7c655e]">This removes {formatPennies(purchase.actual_price_pennies)} from Christmas spending. Financial history will be preserved.</p><div className="mt-3 grid grid-cols-2 gap-2"><button type="button" disabled={busy === purchase.id} onClick={() => setConfirming(null)} className="min-h-11 rounded-xl border bg-white text-xs font-bold">Cancel</button><button type="button" disabled={busy === purchase.id} onClick={() => void removePurchase(purchase)} className="min-h-11 rounded-xl bg-[#9a503c] text-xs font-bold text-white disabled:opacity-50">{busy === purchase.id ? "Removing..." : "Remove purchase"}</button></div></div>
=======
              <article key={purchase.id} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="break-words font-semibold">{purchase.description}</h4>
                    {purchase.retailer && <p className="mt-1 text-sm font-medium text-ink-600">{purchase.retailer}</p>}
                  </div>
                  <strong className="shrink-0 font-display text-lg font-semibold tabular-nums text-ink-900">{formatPennies(purchase.actual_price_pennies)}</strong>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-600">
                  <span>Paid at checkout by <strong className="font-semibold text-ink-900">{contributorNames.get(purchase.checkout_payer_contributor_id) ?? "Unknown contributor"}</strong></span>
                  {purchase.gift_location_person_id && <span>Stored with <strong className="font-semibold text-ink-900">{locationNames.get(purchase.gift_location_person_id) ?? "Unknown person"}</strong></span>}
                  <span>{formatPurchaseDate(purchase.purchase_date)}</span>
                </div>
                {purchase.notes && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-ink-600">{purchase.notes}</p>}
                <div className="mt-3 flex items-center justify-between gap-3">
                  <Badge tone="success">{purchaseLifecycleLabel(status)}</Badge>
                  <span className="text-xs font-medium text-ink-400">{purchase.split_type === "automatic" ? "Automatic split" : "Custom split"}</span>
                </div>

                {purchaseAllocations.length > 0 && (
                  <details className="mt-3 rounded-xl border border-line bg-surface px-3 py-1">
                    <summary className="min-h-11 cursor-pointer py-3 text-xs font-semibold text-ink-600">Responsibility split</summary>
                    <div className="space-y-1.5 border-t border-line pb-3 pt-2">
                      {purchaseAllocations.map((allocation) => (
                        <div key={allocation.contributor_id} className="flex justify-between gap-3 text-xs">
                          <span className="text-ink-600">{contributorNames.get(allocation.contributor_id) ?? "Unknown contributor"}</span>
                          <strong className="font-semibold tabular-nums">{formatPennies(allocation.responsibility_pennies)}</strong>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2 pt-1">
                  <div className="min-w-52 flex-1">
                    <Segmented
                      options={[{ value: "purchased", label: "Purchased" }, { value: "wrapped", label: "Wrapped" }]}
                      value={status}
                      onChange={(option) => void updateStatus(purchase, option)}
                      ariaLabel={`${purchase.description} status`}
                      disabled={busy === purchase.id}
                      lockActive
                    />
                  </div>
                  <ButtonLink variant="secondary" href={`/add-purchase?edit=${encodeURIComponent(purchase.id)}`}>Edit</ButtonLink>
                  <Button variant="dangerGhost" disabled={busy === purchase.id} onClick={() => setConfirming(purchase)}>Remove</Button>
                </div>

                {confirming?.id === purchase.id && (
                  <div className="mt-3 rounded-xl border border-berry-soft-border bg-berry-soft p-3.5">
                    <p className="text-sm font-semibold">Remove “{purchase.description}”?</p>
                    <p className="mt-1 text-xs leading-5 text-ink-600">This removes {formatPennies(purchase.actual_price_pennies)} from Christmas spending. Financial history will be preserved.</p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button variant="secondary" disabled={busy === purchase.id} onClick={() => setConfirming(null)}>Cancel</Button>
                      <Button variant="danger" disabled={busy === purchase.id} onClick={() => void removePurchase(purchase)}>{busy === purchase.id ? "Removing..." : "Remove purchase"}</Button>
                    </div>
                  </div>
>>>>>>> 7534a2d (redesign and realtime)
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatPurchaseDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function purchaseError(action: "load" | "status" | "remove", code?: string) {
  if (code === "42P01" || code === "42703" || code === "42883" || code === "PGRST202" || code === "PGRST204" || code === "PGRST205") return "Purchases is not ready yet. The Purchases database migration must be applied first.";
  return action === "load" ? "Purchases could not be loaded. Check your connection and try again." : action === "status" ? "The purchase status could not be changed." : "The purchase could not be removed. It is still included in spending.";
}

function PurchaseSkeleton() {
<<<<<<< HEAD
  return <div className="h-48 animate-pulse rounded-xl border bg-[#fbfcfb] p-4"><div className="h-4 w-2/3 rounded bg-[#e9eeeb]" /><div className="mt-4 h-3 w-1/3 rounded bg-[#eef2f0]" /><div className="mt-8 h-10 rounded bg-[#eef2f0]" /></div>;
=======
  return (
    <div className="h-48 rounded-xl border border-line bg-surface-2 p-4">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="mt-4 h-3 w-1/3" />
      <Skeleton className="mt-8 h-10" />
    </div>
  );
>>>>>>> 7534a2d (redesign and realtime)
}
