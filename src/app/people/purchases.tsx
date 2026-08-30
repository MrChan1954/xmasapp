"use client";

import { useCallback, useEffect, useState } from "react";
import { formatPennies } from "@/lib/currency";
import {
  normalizePurchaseStatus,
  purchaseLifecycleLabel,
  type PurchaseStatus,
} from "@/lib/purchases";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath } from "@/lib/events.ts";
import { createClient } from "@/utils/supabase/client";
import { useFamily } from "../family-context";
import { IconPlus } from "../components/icons";
import { notifyFamily } from "../components/notify-family";
import { PhotoGallery } from "../components/photo-gallery";
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Notice,
  Segmented,
  Skeleton,
} from "../components/ui";

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
  /*
   * THE EVENT THESE PURCHASES BELONG TO.
   *
   * Both links below pointed at `/add-purchase`, which is the COMPATIBILITY
   * route into the family's Christmas -- so from any other occasion they left
   * the event, and in a family with no Christmas they landed on the dashboard
   * and did nothing at all. Found in live QA.
   */
  const { eventId } = useFamily();
  const addPurchaseHref = eventId ? eventPath(eventId, "add-purchase") : null;

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

    // Goes only to the contributors carrying part of this gift's cost, and once
    // per status: marking wrapped after purchased sends both, marking wrapped
    // twice sends one.
    notifyFamily("gift_status", purchase.id);

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
    setNotice(`“${purchase.description}” was removed from this event's spending. Its history was preserved.`);
    setBusy(null);
  };

  return (
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold">Purchases</h3>
          <p className="mt-1 text-xs leading-5 text-ink-600">Actual gifts bought for this person.</p>
        </div>
        <ButtonLink href={`${addPurchaseHref}?recipient=${encodeURIComponent(recipientId)}`} className="w-full sm:w-auto">
          <IconPlus size={16} />
          Add purchase
        </ButtonLink>
      </div>

      {notice && <Notice tone="success" className="mt-4">{notice}</Notice>}
      {error && <Notice tone="danger" className="mt-4">{error}</Notice>}

      {loading ? (
        <div className="mt-5 grid gap-3 md:grid-cols-2"><PurchaseSkeleton /><PurchaseSkeleton /></div>
      ) : purchases === null ? (
        <Button variant="tonal" onClick={() => void loadPurchases()} className="mt-5">Try loading purchases again</Button>
      ) : purchases.length === 0 ? (
        <EmptyState
          className="mt-5"
          illustration="stocking"
          title="No purchases yet"
          body="When a gift is bought for this person, record it here so budgets stay accurate."
        />
      ) : (
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {purchases.map((purchase) => {
            const status = normalizePurchaseStatus(purchase.status) ?? "purchased";
            const purchaseAllocations = allocations.filter((row) => row.purchase_id === purchase.id);
            return (
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

                <PhotoGallery parent={{ kind: "purchase", id: purchase.id }} label={purchase.description} />

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
                  <ButtonLink variant="secondary" href={`${addPurchaseHref}?edit=${encodeURIComponent(purchase.id)}`}>Edit</ButtonLink>
                  <Button variant="dangerGhost" disabled={busy === purchase.id} onClick={() => setConfirming(purchase)}>Remove</Button>
                </div>

                {confirming?.id === purchase.id && (
                  <div className="mt-3 rounded-xl border border-berry-soft-border bg-berry-soft p-3.5">
                    <p className="text-sm font-semibold">Remove “{purchase.description}”?</p>
                    <p className="mt-1 text-xs leading-5 text-ink-600">This removes {formatPennies(purchase.actual_price_pennies)} from this event&apos;s spending. Financial history will be preserved.</p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button variant="secondary" disabled={busy === purchase.id} onClick={() => setConfirming(null)}>Cancel</Button>
                      <Button variant="danger" disabled={busy === purchase.id} onClick={() => void removePurchase(purchase)}>{busy === purchase.id ? "Removing…" : "Remove purchase"}</Button>
                    </div>
                  </div>
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
  return (
    <div className="h-48 rounded-xl border border-line bg-surface-2 p-4">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="mt-4 h-3 w-1/3" />
      <Skeleton className="mt-8 h-10" />
    </div>
  );
}
