"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatPennies } from "@/lib/currency";
import {
  INPUT_LIMITS,
  validateDateInput,
  validateEnum,
  validateOptionalText,
  validateRequiredText,
  validateUuid,
} from "@/lib/input-validation";
import {
  calculatePurchaseBudgetPreview,
  normalizePurchaseStatus,
  parsePoundsToPennies,
  splitPurchaseByWeights,
  type PurchaseStatus,
} from "@/lib/purchases";
import { createClient } from "../../../utils/supabase/client";
import { FinancialProgressBar } from "../components/financial-progress";
import { useFamily } from "../family-context";

type RecipientOption = {
  id: string;
  personId: string;
  name: string;
  budgetPennies: number;
  spentPennies: number;
  active: boolean;
};

type ContributorOption = {
  id: string;
  personId: string;
  name: string;
  active: boolean;
};

type WeightRow = ContributorOption & { weightPennies: number };

type PurchaseRow = {
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
  originating_gift_idea_id: string | null;
  gift_location_person_id: string | null;
};

type AllocationRow = {
  contributor_id: string;
  responsibility_pennies: number;
};

export function PurchaseForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { refresh } = useFamily();
  const rawEditId = searchParams.get("edit");
  const rawIdeaId = searchParams.get("idea");
  const rawRecipientId = searchParams.get("recipient");
  const editIdResult = rawEditId === null ? null : validateUuid(rawEditId, "The purchase edit link is invalid.");
  const ideaIdResult = rawIdeaId === null ? null : validateUuid(rawIdeaId, "The gift idea link is invalid.");
  const recipientIdResult = rawRecipientId === null ? null : validateUuid(rawRecipientId, "The recipient link is invalid.");
  const editId = editIdResult?.ok ? editIdResult.value : null;
  const ideaId = ideaIdResult?.ok ? ideaIdResult.value : null;
  const requestedRecipientId = recipientIdResult?.ok ? recipientIdResult.value : null;
  const queryError = !editIdResult?.ok && editIdResult !== null
    ? editIdResult.error
    : !ideaIdResult?.ok && ideaIdResult !== null
      ? ideaIdResult.error
      : !recipientIdResult?.ok && recipientIdResult !== null
        ? recipientIdResult.error
        : editId && ideaId
          ? "Choose either a purchase to edit or a gift idea to buy, not both."
          : null;

  const [recipients, setRecipients] = useState<RecipientOption[]>([]);
  const [contributors, setContributors] = useState<ContributorOption[]>([]);
  const [giftLocations, setGiftLocations] = useState<{ id: string; name: string }[]>([]);
  const [weights, setWeights] = useState<WeightRow[]>([]);
  const [recipientId, setRecipientId] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [payerId, setPayerId] = useState("");
  const [giftLocationPersonId, setGiftLocationPersonId] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(todayInput());
  const [retailer, setRetailer] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<PurchaseStatus>("purchased");
  const [splitType, setSplitType] = useState<"automatic" | "custom">("automatic");
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  const [originatingIdeaId, setOriginatingIdeaId] = useState<string | null>(ideaId);
  const [originalPurchasePricePennies, setOriginalPurchasePricePennies] = useState(0);
  const [automaticSnapshotLocked, setAutomaticSnapshotLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [weightsLoading, setWeightsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      if (queryError) {
        setError(queryError);
        setLoading(false);
        return;
      }
      const db = createClient();
      const event = await db.from("christmas_events").select("id").eq("year", 2026).maybeSingle();
      if (!active) return;
      if (event.error || !event.data) {
        setError("Christmas 2026 could not be loaded.");
        setLoading(false);
        return;
      }

      const [recipientRows, contributorRows, auth] = await Promise.all([
        db.from("christmas_recipients").select("id,person_id,budget_pennies,active").eq("christmas_event_id", event.data.id).order("created_at"),
        db.from("contributors").select("id,person_id,active").eq("christmas_event_id", event.data.id),
        db.auth.getUser(),
      ]);
      if (!active) return;
      if (recipientRows.error || contributorRows.error || !auth.data.user) {
        setError("Purchase choices could not be loaded. Check your connection and try again.");
        setLoading(false);
        return;
      }

      const personIds = [...new Set([
        ...recipientRows.data.map((row) => row.person_id),
        ...contributorRows.data.map((row) => row.person_id),
      ])];
      const recipientIds = recipientRows.data.map((row) => row.id);
      const [peopleResult, membershipResult, purchaseTotalsResult] = await Promise.all([
        db.from("people").select("id,name").in("id", personIds),
        db.from("app_members").select("contributor_id,person_id").eq("user_id", auth.data.user.id).eq("active", true).maybeSingle(),
        recipientIds.length
          ? db.from("purchases").select("christmas_recipient_id,actual_price_pennies").in("christmas_recipient_id", recipientIds).is("deleted_at", null)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (!active) return;
      if (peopleResult.error || membershipResult.error || purchaseTotalsResult.error) {
        setError("Family names, spending totals, or your contributor account could not be loaded.");
        setLoading(false);
        return;
      }

      const names = new Map(peopleResult.data.map((row) => [row.id, row.name]));
      const spentByRecipient = new Map<string, number>();
      for (const purchase of purchaseTotalsResult.data ?? []) {
        spentByRecipient.set(
          purchase.christmas_recipient_id,
          (spentByRecipient.get(purchase.christmas_recipient_id) ?? 0) + purchase.actual_price_pennies,
        );
      }
      const nextRecipients = recipientRows.data.flatMap((row) => {
        const name = names.get(row.person_id);
        return name ? [{ id: row.id, personId: row.person_id, name, budgetPennies: row.budget_pennies, spentPennies: spentByRecipient.get(row.id) ?? 0, active: row.active }] : [];
      });
      const nextContributors = contributorRows.data.flatMap((row) => {
        const name = names.get(row.person_id);
        return name ? [{ id: row.id, personId: row.person_id, name, active: row.active }] : [];
      }).sort((left, right) => left.name.localeCompare(right.name));
      setRecipients(nextRecipients);
      setContributors(nextContributors);
      setGiftLocations(nextContributors
        .filter((row) => row.active)
        .map((row) => ({ id: row.personId, name: row.name }))
        .sort((left, right) => left.name.localeCompare(right.name)));

      if (requestedRecipientId && !nextRecipients.some((row) => row.id === requestedRecipientId)) {
        setError("The selected Christmas recipient could not be found.");
        setLoading(false);
        return;
      }

      let initialRecipientId = requestedRecipientId ?? nextRecipients.find((row) => row.active)?.id ?? "";
      let initialPayerId = membershipResult.data?.contributor_id ?? nextContributors.find((row) => row.personId === membershipResult.data?.person_id && row.active)?.id ?? "";

      if (editId) {
        const [purchaseResult, allocationsResult] = await Promise.all([
          db.from("purchases").select("id,christmas_recipient_id,description,actual_price_pennies,checkout_payer_contributor_id,gift_location_person_id,purchase_date,retailer,notes,status,split_type,originating_gift_idea_id").eq("id", editId).is("deleted_at", null).maybeSingle(),
          db.from("purchase_allocations").select("contributor_id,responsibility_pennies").eq("purchase_id", editId),
        ]);
        if (!active) return;
        if (purchaseResult.error || allocationsResult.error || !purchaseResult.data) {
          setError(purchaseFeatureError("This purchase could not be loaded for editing.", purchaseResult.error?.code ?? allocationsResult.error?.code));
          setLoading(false);
          return;
        }
        const purchase = purchaseResult.data as PurchaseRow;
        initialRecipientId = purchase.christmas_recipient_id;
        initialPayerId = purchase.checkout_payer_contributor_id;
        setDescription(purchase.description);
        setPrice(priceInput(purchase.actual_price_pennies));
        setOriginalPurchasePricePennies(purchase.actual_price_pennies);
        setPurchaseDate(purchase.purchase_date);
        setRetailer(purchase.retailer ?? "");
        setNotes(purchase.notes ?? "");
        setStatus(normalizePurchaseStatus(purchase.status) ?? "purchased");
        setGiftLocationPersonId(purchase.gift_location_person_id && nextContributors.some((row) => row.active && row.personId === purchase.gift_location_person_id) ? purchase.gift_location_person_id : "");
        setSplitType(purchase.split_type);
        setOriginatingIdeaId(purchase.originating_gift_idea_id);
        setAllocations(Object.fromEntries((allocationsResult.data as AllocationRow[]).map((row) => [row.contributor_id, row.responsibility_pennies])));
        setAutomaticSnapshotLocked(purchase.split_type === "automatic");
      } else if (ideaId) {
        const ideaResult = await db.from("gift_ideas").select("id,christmas_recipient_id,title,estimated_price_pennies,retailer").eq("id", ideaId).maybeSingle();
        if (!active) return;
        if (ideaResult.error || !ideaResult.data) {
          setError("This gift idea could not be used. It may have been removed.");
          setLoading(false);
          return;
        }
        initialRecipientId = ideaResult.data.christmas_recipient_id;
        setDescription(ideaResult.data.title);
        setPrice(ideaResult.data.estimated_price_pennies === null ? "" : priceInput(ideaResult.data.estimated_price_pennies));
        setRetailer(ideaResult.data.retailer ?? "");
        setOriginatingIdeaId(ideaResult.data.id);
        setPrefillNotice("The estimated idea price was copied in. Confirm or change the actual amount paid before saving.");
      }

      setRecipientId(initialRecipientId);
      setPayerId(initialPayerId);
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [editId, ideaId, queryError, requestedRecipientId]);

  useEffect(() => {
    if (!recipientId) return;
    let active = true;
    const loadWeights = async () => {
      setWeightsLoading(true);
      const result = await createClient()
        .from("recipient_contributions")
        .select("contributor_id,planned_amount_pennies")
        .eq("christmas_recipient_id", recipientId)
        .gt("planned_amount_pennies", 0);
      if (!active) return;
      if (result.error) {
        setError("The recipient responsibility split could not be loaded.");
        setWeights([]);
        setWeightsLoading(false);
        return;
      }
      const nextWeights = result.data.flatMap((row) => {
        const contributor = contributors.find((item) => item.id === row.contributor_id && item.active);
        return contributor ? [{ ...contributor, weightPennies: row.planned_amount_pennies }] : [];
      }).sort((left, right) => left.name.localeCompare(right.name));
      setWeights(nextWeights);
      setWeightsLoading(false);
    };
    void loadWeights();
    return () => { active = false; };
  }, [contributors, recipientId]);

  const calculatedAutomaticAllocations = useMemo(() => {
    if (splitType !== "automatic" || automaticSnapshotLocked || weights.length === 0) return null;
    const parsed = parsePoundsToPennies(price);
    if (!parsed.ok) return null;
    try {
      return Object.fromEntries(splitPurchaseByWeights(
        parsed.pennies,
        weights.map((row) => ({ contributorId: row.id, weightPennies: row.weightPennies })),
      ).map((row) => [row.contributorId, row.responsibilityPennies]));
    } catch {
      return null;
    }
  }, [automaticSnapshotLocked, price, splitType, weights]);

  const effectiveAllocations = calculatedAutomaticAllocations ?? allocations;

  const allocationRows = useMemo(() => {
    const contributorById = new Map(contributors.map((row) => [row.id, row]));
    const ids = splitType === "automatic" && !automaticSnapshotLocked
      ? weights.map((row) => row.id)
      : Object.keys(effectiveAllocations);
    return ids.flatMap((id) => {
      const contributor = contributorById.get(id);
      return contributor ? [{ ...contributor, responsibilityPennies: effectiveAllocations[id] ?? 0 }] : [];
    });
  }, [automaticSnapshotLocked, contributors, effectiveAllocations, splitType, weights]);

  const allocationTotal = allocationRows.reduce((sum, row) => sum + row.responsibilityPennies, 0);
  const parsedPrice = parsePoundsToPennies(price);
  const expectedPrice = parsedPrice.ok ? parsedPrice.pennies : null;
  const balanced = expectedPrice !== null && allocationRows.length > 0 && allocationTotal === expectedPrice;
  const selectedRecipient = recipients.find((row) => row.id === recipientId);
  const projectedBudget = useMemo(() => {
    if (!selectedRecipient || expectedPrice === null) return null;
    try {
      return calculatePurchaseBudgetPreview({
        budgetPennies: selectedRecipient.budgetPennies,
        currentSpentPennies: selectedRecipient.spentPennies,
        newPricePennies: expectedPrice,
        replacedPricePennies: editId ? originalPurchasePricePennies : 0,
      });
    } catch {
      return null;
    }
  }, [editId, expectedPrice, originalPurchasePricePennies, selectedRecipient]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const validRecipientId = validateUuid(recipientId, "Choose who this gift is for.");
    if (!validRecipientId.ok || !recipients.some((row) => row.id === validRecipientId.value)) { setError(validRecipientId.ok ? "Choose a valid Christmas recipient." : validRecipientId.error); return; }
    const title = validateRequiredText(description, { field: "the gift or item", maxLength: INPUT_LIMITS.title });
    if (!title.ok) { setError(title.error); return; }
    if (!parsedPrice.ok) { setError(parsedPrice.error); return; }
    const validPayerId = validateUuid(payerId, "Choose who physically paid at checkout.");
    if (!validPayerId.ok || !contributors.some((row) => row.id === validPayerId.value && row.active)) { setError(validPayerId.ok ? "Choose a valid active contributor." : validPayerId.error); return; }
    const validDate = validateDateInput(purchaseDate, "Choose a valid purchase date.");
    if (!validDate.ok) { setError(validDate.error); return; }
    const validStatus = validateEnum(status, ["purchased", "wrapped"] as const, "Choose Purchased or Wrapped.");
    if (!validStatus.ok) { setError(validStatus.error); return; }
    const validGiftLocation = giftLocationPersonId === ""
      ? null
      : validateUuid(giftLocationPersonId, "Choose a valid gift location.");
    if (validGiftLocation && (!validGiftLocation.ok || !giftLocations.some((row) => row.id === validGiftLocation.value))) {
      setError(validGiftLocation.ok ? "Choose an active contributor as the gift location." : validGiftLocation.error);
      return;
    }
    const validSplitType = validateEnum(splitType, ["automatic", "custom"] as const, "Choose a valid responsibility split.");
    if (!validSplitType.ok) { setError(validSplitType.error); return; }
    if (!balanced) { setError(`The responsibility split must equal ${formatPennies(parsedPrice.pennies)} exactly.`); return; }
    const validRetailer = validateOptionalText(retailer, { field: "the retailer", maxLength: INPUT_LIMITS.retailer });
    if (!validRetailer.ok) { setError(validRetailer.error); return; }
    const validNotes = validateOptionalText(notes, { field: "notes", maxLength: INPUT_LIMITS.notes, multiline: true });
    if (!validNotes.ok) { setError(validNotes.error); return; }
    const validIdeaId = originatingIdeaId === null ? null : validateUuid(originatingIdeaId, "The linked gift idea is invalid.");
    if (validIdeaId && !validIdeaId.ok) { setError(validIdeaId.error); return; }
    if (allocationRows.some((row) => !validateUuid(row.id).ok || !Number.isSafeInteger(row.responsibilityPennies) || row.responsibilityPennies < 0)) {
      setError("One responsibility allocation is invalid. Refresh and try again.");
      return;
    }

    setSaving(true);
    const result = await createClient().rpc("save_purchase_with_location", {
      p_purchase_id: editId,
      p_christmas_recipient_id: validRecipientId.value,
      p_description: title.value,
      p_actual_price_pennies: parsedPrice.pennies,
      p_checkout_payer_contributor_id: validPayerId.value,
      p_gift_location_person_id: validGiftLocation?.value ?? null,
      p_purchase_date: validDate.value,
      p_retailer: validRetailer.value,
      p_notes: validNotes.value,
      p_status: validStatus.value,
      p_split_type: validSplitType.value,
      p_originating_gift_idea_id: validIdeaId?.value ?? null,
      p_allocations: allocationRows.map((row) => ({
        contributor_id: row.id,
        responsibility_pennies: row.responsibilityPennies,
      })),
    });
    if (result.error) {
      setError(purchaseFeatureError("This purchase could not be saved. Nothing was changed.", result.error.code));
      setSaving(false);
      return;
    }
    await refresh();
    router.push("/people");
  };

  if (loading) {
    return <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8"><p className="text-sm font-semibold text-[#7b8581]">Loading purchase form...</p></div>;
  }

  return (
    <form onSubmit={(event) => void save(event)} className="mx-auto max-w-6xl px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-[#a64235]">Christmas 2026</p>
          <h1 className="mt-1 text-4xl font-bold">{editId ? "Edit purchase" : "Add purchase"}</h1>
          <p className="mt-2 text-sm leading-6 text-[#7b8581]">Record what was bought, who paid at checkout, and who is responsible for the cost.</p>
        </div>
        <button type="button" onClick={() => router.push("/people")} className="min-h-12 w-full rounded-xl border border-[#d8dbd3] bg-white px-4 text-sm font-bold shadow-sm sm:w-auto">Cancel</button>
      </header>

      {prefillNotice && <p className="mt-5 rounded-xl border border-[#ead9aa] bg-[#fff8e4] p-4 text-sm font-semibold text-[#715b1c]">{prefillNotice}</p>}
      {error && <p role="alert" className="mt-5 rounded-xl border border-[#ecd4ca] bg-[#fff5f1] p-4 text-sm font-semibold text-[#9a503c]">{error}</p>}

      <div className="mt-7 grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        <section className="rounded-2xl border border-[#e2e1d8] bg-white p-5 shadow-sm sm:p-7">
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block text-sm font-bold sm:col-span-2">Recipient *
              <select required disabled={Boolean(editId || ideaId)} value={recipientId} onChange={(event) => { setRecipientId(event.target.value); setAllocations({}); setAutomaticSnapshotLocked(false); }} className="mt-2 h-12 w-full rounded-xl border bg-white px-3 disabled:bg-[#f2f4f3]">
                <option value="">Choose a person</option>
                {recipients.filter((row) => row.active || row.id === recipientId).map((row) => <option key={row.id} value={row.id}>{row.name} — Budget {formatPennies(row.budgetPennies)}</option>)}
              </select>
            </label>

            {selectedRecipient && (
              <RecipientBudgetSummary
                recipient={selectedRecipient}
                projectedSpentPennies={projectedBudget?.projectedSpentPennies ?? null}
                editing={Boolean(editId)}
              />
            )}

            <label className="block text-sm font-bold sm:col-span-2">Gift / item *
              <input required maxLength={INPUT_LIMITS.title} value={description} onChange={(event) => setDescription(event.target.value)} className="mt-2 h-12 w-full rounded-xl border px-3" />
            </label>

            <label className="block text-sm font-bold">Price paid *
              <span className="mt-2 flex h-12 items-center rounded-xl border bg-white focus-within:ring-4 focus-within:ring-[#dcece7]"><span className="pl-3 text-[#69746f]">£</span><input required inputMode="decimal" maxLength={INPUT_LIMITS.money} value={price} onChange={(event) => { setPrice(event.target.value); if (splitType === "automatic") setAutomaticSnapshotLocked(false); }} className="h-full min-w-0 flex-1 rounded-xl px-2 outline-none" /></span>
            </label>

            <label className="block text-sm font-bold">Who paid? *
              <select required value={payerId} onChange={(event) => setPayerId(event.target.value)} className="mt-2 h-12 w-full rounded-xl border bg-white px-3">
                <option value="">Choose contributor</option>
                {contributors.filter((row) => row.active).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
              <span className="mt-1 block text-xs font-normal leading-5 text-[#89938f]">The person who physically paid the shop or website.</span>
            </label>

            <label className="block text-sm font-bold">Gift is at
              <select value={giftLocationPersonId} onChange={(event) => setGiftLocationPersonId(event.target.value)} className="mt-2 h-12 w-full rounded-xl border bg-white px-3">
                <option value="">Not recorded</option>
                {giftLocations.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
              <span className="mt-1 block text-xs font-normal leading-5 text-[#89938f]">Where the physical gift is currently stored.</span>
            </label>

            <label className="block text-sm font-bold">Purchase date *
              <input required type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} className="mt-2 h-12 w-full rounded-xl border px-3" />
            </label>

            <label className="block text-sm font-bold sm:col-span-2">Retailer
              <input maxLength={INPUT_LIMITS.retailer} value={retailer} onChange={(event) => setRetailer(event.target.value)} placeholder="Amazon, Boots, Next..." className="mt-2 h-12 w-full rounded-xl border px-3" />
            </label>

            <label className="block text-sm font-bold sm:col-span-2">Notes
              <textarea rows={4} maxLength={INPUT_LIMITS.notes} value={notes} onChange={(event) => setNotes(event.target.value)} className="mt-2 w-full resize-y rounded-xl border p-3" />
            </label>

            <fieldset className="sm:col-span-2">
              <legend className="text-sm font-bold">Status</legend>
              <div className="mt-2 grid grid-cols-2 rounded-xl border border-[#d5d9d3] bg-[#f6f6f2] p-1" role="group" aria-label="Purchase status">
                {(["purchased", "wrapped"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={status === option}
                    onClick={() => setStatus(option)}
                    className={`min-h-11 rounded-lg px-3 text-sm font-bold transition ${status === option ? "bg-[#174f45] text-white shadow-sm" : "text-[#5f6d68]"}`}
                  >
                    {option === "purchased" ? "Purchased" : "Wrapped"}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        </section>

        <section className="rounded-2xl border border-[#e2e1d8] bg-white p-5 shadow-sm sm:p-7 lg:sticky lg:top-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-lg font-bold">Contribution split</h2><p className="mt-1 text-xs text-[#7b8581]">Financial responsibility, not who paid at checkout.</p></div>
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${splitType === "automatic" ? "bg-[#e4f1ed] text-[#28685c]" : "bg-[#fff3d2] text-[#765d16]"}`}>{splitType === "automatic" ? "Automatic split" : "Custom split"}</span>
          </div>

          {weightsLoading ? <p className="mt-5 text-sm text-[#89938f]">Calculating split...</p> : allocationRows.length === 0 ? <p className="mt-5 rounded-xl bg-[#fff5f1] p-3 text-sm text-[#9a503c]">This recipient has no active contributor allocation to split against.</p> : (
            <div className="mt-5 space-y-2">
              {allocationRows.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3 rounded-xl bg-[#f8f8f6] p-3">
                  <span className="min-w-0 truncate font-semibold">{row.name}</span>
                  {splitType === "custom" ? (
                    <MoneyAllocationInput name={row.name} pennies={row.responsibilityPennies} onChange={(pennies) => setAllocations((current) => ({ ...current, [row.id]: pennies }))} />
                  ) : <strong>{formatPennies(row.responsibilityPennies)}</strong>}
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex items-center justify-between border-t pt-4 text-sm"><span className="font-semibold">Allocated</span><strong className={balanced ? "text-[#28685c]" : "text-[#9a503c]"}>{formatPennies(allocationTotal)}{expectedPrice !== null && ` of ${formatPennies(expectedPrice)}`}</strong></div>

          <button type="button" onClick={() => { if (splitType === "automatic") { setAllocations(effectiveAllocations); setSplitType("custom"); } else { setSplitType("automatic"); setAutomaticSnapshotLocked(false); } }} className="mt-4 min-h-11 w-full rounded-xl border text-sm font-bold text-[#28685c]">{splitType === "automatic" ? "Adjust split" : "Use automatic split"}</button>

          <button disabled={saving || !balanced} className="mt-5 min-h-14 w-full rounded-xl bg-[#174f45] px-5 text-base font-bold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-45">{saving ? "Saving purchase..." : editId ? "Save purchase changes" : "Save purchase"}</button>
        </section>
      </div>
    </form>
  );
}

function priceInput(pennies: number) {
  return (pennies / 100).toFixed(2).replace(/\.00$/, "");
}

function RecipientBudgetSummary({
  recipient,
  projectedSpentPennies,
  editing,
}: {
  recipient: RecipientOption;
  projectedSpentPennies: number | null;
  editing: boolean;
}) {
  const currentDifference = recipient.budgetPennies - recipient.spentPennies;
  const projectedDifference = projectedSpentPennies === null ? null : recipient.budgetPennies - projectedSpentPennies;
  return (
    <section className="min-w-0 rounded-2xl border border-[#cddbd6] bg-[#f2f8f6] p-4 sm:col-span-2 sm:p-5" aria-label={`${recipient.name} budget position`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2"><div><p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#28685c]">Budget position</p><h2 className="mt-1 break-words text-lg font-bold">{recipient.name}</h2></div>{editing && <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold uppercase text-[#60706a]">Editing purchase</span>}</div>
      <dl className="mt-4 grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3">
        <BudgetMetric label="Budget" value={formatPennies(recipient.budgetPennies)} />
        <BudgetMetric label="Already spent" value={formatPennies(recipient.spentPennies)} />
        <BudgetMetric className="col-span-2 sm:col-span-1" label={currentDifference < 0 ? "Currently over budget" : currentDifference === 0 ? "Current position" : "Currently remaining"} value={currentDifference === 0 ? "Budget reached" : formatPennies(Math.abs(currentDifference))} warning={currentDifference < 0} />
      </dl>
      <FinancialProgressBar actualPennies={recipient.spentPennies} plannedPennies={recipient.budgetPennies} mode="budget" showDifference={false} />
      {projectedSpentPennies !== null && projectedDifference !== null && (
        <div className={`mt-4 border-t pt-4 ${projectedDifference < 0 ? "border-[#e3b3aa]" : "border-[#cddbd6]"}`}>
          <p className={`text-xs font-bold uppercase tracking-wide ${projectedDifference < 0 ? "text-[#a63f33]" : "text-[#28685c]"}`}>After this purchase</p>
          <div className="mt-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><strong className="break-words text-xl tabular-nums">{formatPennies(projectedSpentPennies)} spent</strong><strong className={`break-words text-sm tabular-nums ${projectedDifference < 0 ? "text-[#a63f33]" : "text-[#174f45]"}`}>{projectedDifference < 0 ? `${formatPennies(Math.abs(projectedDifference))} over budget` : projectedDifference === 0 ? "Budget reached" : `${formatPennies(projectedDifference)} remaining`}</strong></div>
          <FinancialProgressBar actualPennies={projectedSpentPennies} plannedPennies={recipient.budgetPennies} mode="budget" showDifference={false} />
        </div>
      )}
    </section>
  );
}

function BudgetMetric({ label, value, warning = false, className = "" }: { label: string; value: string; warning?: boolean; className?: string }) {
  return <div className={`min-w-0 rounded-xl bg-white p-3 ${className}`}><dt className="text-[10px] font-bold uppercase tracking-wide text-[#7b8581]">{label}</dt><dd className={`mt-1 break-words font-bold tabular-nums ${warning ? "text-[#a63f33]" : ""}`}>{value}</dd></div>;
}

function MoneyAllocationInput({ name, pennies, onChange }: { name: string; pennies: number; onChange: (pennies: number) => void }) {
  const [value, setValue] = useState(priceInput(pennies));
  return (
    <span className="flex h-10 w-32 items-center rounded-lg border bg-white">
      <span className="pl-2 text-sm text-[#69746f]">£</span>
      <input
        aria-label={`${name} responsibility`}
        inputMode="decimal"
        maxLength={INPUT_LIMITS.money}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          const parsed = parsePoundsToPennies(next);
          if (parsed.ok) onChange(parsed.pennies);
        }}
        onBlur={() => {
          const parsed = parsePoundsToPennies(value);
          if (!parsed.ok) setValue(priceInput(pennies));
        }}
        className="h-full min-w-0 flex-1 rounded-lg px-1 text-right outline-none"
      />
    </span>
  );
}

function todayInput() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function purchaseFeatureError(message: string, code?: string) {
  if (code === "42P01" || code === "42703" || code === "42883" || code === "PGRST202" || code === "PGRST204" || code === "PGRST205") {
    return "Purchases is not ready yet. The Purchases database migration must be applied first.";
  }
  if (code === "23505") return "This gift idea already has an active purchase.";
  return message;
}
