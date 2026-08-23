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
import { createClient } from "@/utils/supabase/client";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath } from "@/lib/events.ts";
import { PageHeader } from "../components/app-shell";
import { notifyFamily } from "../components/notify-family";
import { GarlandRule } from "../components/festive/garland";
import { FinancialProgressBar } from "../components/financial-progress";
import { PhotoPicker, usePendingPhotos } from "../components/photo-picker";
import {
  Badge,
  Button,
  Field,
  Input,
  MoneyInput,
  Notice,
  SectionCard,
  Segmented,
  Select,
  Textarea,
  cx,
} from "../components/ui";
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

export function PurchaseForm({ eventId }: { eventId: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { refresh } = useFamily();
  // Staged until the purchase exists; see the upload after the save RPC.
  const pendingPhotos = usePendingPhotos();
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
      const [recipientRows, contributorRows, auth] = await Promise.all([
        db.from("christmas_recipients").select("id,person_id,budget_pennies,active").eq("christmas_event_id", eventId).order("created_at"),
        db.from("contributors").select("id,person_id,active").eq("christmas_event_id", eventId),
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
  }, [editId, eventId, ideaId, queryError, requestedRecipientId]);

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

    // Only now does a purchase exist for the photos to belong to. Failures here
    // are reported but never block the save: the money is already recorded, and
    // a photo can be added again from the purchase itself.
    const savedId = (result.data as { id?: string } | null)?.id ?? editId;

    // A brand new purchase only. Editing one already-notified purchase is not a
    // new event for the family, and the server would refuse it anyway: the
    // freshness check reads `created_at`, and the event ledger has already been
    // claimed for this purchase.
    if (savedId && !editId) notifyFamily("purchase", savedId);
    if (savedId) {
      const outcome = await pendingPhotos.uploadTo({ kind: "purchase", id: savedId });
      if (outcome.failed > 0) {
        setError(`The purchase was saved, but ${outcome.failed} ${outcome.failed === 1 ? "photo" : "photos"} could not be uploaded. You can add them from the purchase.`);
        setSaving(false);
        return;
      }
    }

    await refresh();
    router.push(eventPath(eventId, "people") ?? "/");
  };

  if (loading) {
    return <p className="py-6 text-sm font-medium text-ink-600">Loading purchase form...</p>;
  }

  // Nobody to buy for. A purchase belongs to a recipient, so there is no
  // half-usable version of this form: it needs a target or it needs to say so.
  // The navigation already withholds the Add tab for such an event; this is for
  // anybody who arrives by URL anyway.
  if (!editId && !recipients.some((row) => row.active)) {
    return (
      <div className="pb-10">
        <PageHeader
          title="Add purchase"
          description="This event has nobody to buy for yet."
        />
        <Notice tone="info" className="mt-6">
          A purchase belongs to a recipient, so somebody has to be added to this event
          first. The Global Admin can do that on the set-up screen.
        </Notice>
        <div className="mt-6">
          <Button size="lg" onClick={() => router.push(eventPath(eventId, "people") ?? "/")}>
            Go to set up
          </Button>
        </div>
      </div>
    );
  }

  return (
    // Extra bottom padding on mobile so the sticky submit bar never covers the
    // end of the form; on desktop the submit lives in the sticky rail instead.
    <form onSubmit={(event) => void save(event)} className="pb-36 lg:pb-0">
      <PageHeader
        title={editId ? "Edit purchase" : "Add purchase"}
        description="Record what was bought, who paid at checkout, and who is responsible for the cost."
        actions={<Button variant="secondary" size="lg" onClick={() => router.push(eventPath(eventId, "people") ?? "/")} className="w-full sm:w-auto">Cancel</Button>}
      />

      {prefillNotice && <Notice tone="warning" className="mt-5">{prefillNotice}</Notice>}
      {error && <Notice tone="danger" className="mt-5">{error}</Notice>}

      <div className="mt-8 grid items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        <div className="space-y-5">
          <SectionCard eyebrow="Step one" title="The gift">
            <GarlandRule className="mt-4" />
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Recipient" required className="sm:col-span-2">
                <Select required disabled={Boolean(editId || ideaId)} value={recipientId} onChange={(event) => { setRecipientId(event.target.value); setAllocations({}); setAutomaticSnapshotLocked(false); }}>
                  <option value="">Choose a person</option>
                  {recipients.filter((row) => row.active || row.id === recipientId).map((row) => <option key={row.id} value={row.id}>{row.name} — Budget {formatPennies(row.budgetPennies)}</option>)}
                </Select>
              </Field>

              {selectedRecipient && (
                <RecipientBudgetSummary
                  recipient={selectedRecipient}
                  projectedSpentPennies={projectedBudget?.projectedSpentPennies ?? null}
                  editing={Boolean(editId)}
                />
              )}

              <Field label="Gift / item" required className="sm:col-span-2">
                <Input required maxLength={INPUT_LIMITS.title} value={description} onChange={(event) => setDescription(event.target.value)} />
              </Field>

              <Field label="Price paid" required>
                <MoneyInput
                  required
                  maxLength={INPUT_LIMITS.money}
                  value={price}
                  onValueChange={(value) => { setPrice(value); if (splitType === "automatic") setAutomaticSnapshotLocked(false); }}
                />
              </Field>

              <Field label="Who paid?" required hint="The person who physically paid the shop or website.">
                <Select required value={payerId} onChange={(event) => setPayerId(event.target.value)}>
                  <option value="">Choose contributor</option>
                  {contributors.filter((row) => row.active).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                </Select>
              </Field>
            </div>
          </SectionCard>

          <SectionCard eyebrow="Step two" title="Details">
            <GarlandRule className="mt-4" />
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Gift is at" hint="Where the physical gift is currently stored.">
                <Select value={giftLocationPersonId} onChange={(event) => setGiftLocationPersonId(event.target.value)}>
                  <option value="">Not recorded</option>
                  {giftLocations.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                </Select>
              </Field>

              <Field label="Purchase date" required>
                <Input required type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} />
              </Field>

              <Field label="Retailer" className="sm:col-span-2">
                <Input maxLength={INPUT_LIMITS.retailer} value={retailer} onChange={(event) => setRetailer(event.target.value)} placeholder="Amazon, Boots, Next..." />
              </Field>

              <Field label="Notes" className="sm:col-span-2">
                <Textarea rows={4} maxLength={INPUT_LIMITS.notes} value={notes} onChange={(event) => setNotes(event.target.value)} />
              </Field>

              <div className="sm:col-span-2">
                <PhotoPicker
                  photos={pendingPhotos.photos}
                  onAdd={(files) => void pendingPhotos.add(files)}
                  onRemove={pendingPhotos.remove}
                  error={pendingPhotos.error}
                  onDismissError={() => pendingPhotos.setError(null)}
                  preparing={pendingPhotos.preparing}
                  disabled={saving}
                />
              </div>

              <fieldset className="sm:col-span-2">
                <legend className="text-sm font-semibold">Status</legend>
                <div className="mt-2">
                  <Segmented
                    options={[{ value: "purchased", label: "Purchased" }, { value: "wrapped", label: "Wrapped" }]}
                    value={status}
                    onChange={setStatus}
                    ariaLabel="Purchase status"
                  />
                </div>
              </fieldset>
            </div>
          </SectionCard>
        </div>

        <section className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6 lg:sticky lg:top-24">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-semibold">Contribution split</h2>
              <p className="mt-1 text-xs leading-5 text-ink-600">Financial responsibility, not who paid at checkout.</p>
            </div>
            <Badge tone={splitType === "automatic" ? "success" : "warning"}>{splitType === "automatic" ? "Automatic split" : "Custom split"}</Badge>
          </div>

          {weightsLoading ? (
            <p className="mt-5 text-sm text-ink-600">Calculating split...</p>
          ) : allocationRows.length === 0 ? (
            <Notice tone="danger" className="mt-5">This recipient has no active contributor allocation to split against.</Notice>
          ) : (
            <div className="mt-5 divide-y divide-line border-y border-line">
              {allocationRows.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0 truncate font-semibold">{row.name}</span>
                  {splitType === "custom" ? (
                    <MoneyAllocationInput name={row.name} pennies={row.responsibilityPennies} onChange={(pennies) => setAllocations((current) => ({ ...current, [row.id]: pennies }))} />
                  ) : <strong className="font-semibold tabular-nums">{formatPennies(row.responsibilityPennies)}</strong>}
                </div>
              ))}
            </div>
          )}

          <GarlandRule className="mt-4" />

          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="font-medium text-ink-600">Allocated</span>
            <strong className={cx("font-semibold tabular-nums", balanced ? "text-accent" : "text-berry")}>
              {formatPennies(allocationTotal)}{expectedPrice !== null && ` of ${formatPennies(expectedPrice)}`}
            </strong>
          </div>

          <Button
            variant="tonal"
            onClick={() => { if (splitType === "automatic") { setAllocations(effectiveAllocations); setSplitType("custom"); } else { setSplitType("automatic"); setAutomaticSnapshotLocked(false); } }}
            className="mt-4 w-full"
          >
            {splitType === "automatic" ? "Adjust split" : "Use automatic split"}
          </Button>

          {/* Desktop submit lives in the sticky rail; mobile gets the bar below. */}
          <Button type="submit" size="lg" disabled={saving || !balanced} className="mt-4 hidden min-h-14 w-full text-base lg:inline-flex">
            {saving ? "Saving purchase..." : editId ? "Save purchase changes" : "Save purchase"}
          </Button>
        </section>
      </div>

      {/*
        On mobile the split rail is the last thing on a long page, so the submit
        button would sit far below the fold. Pin it, with the running total, just
        above the tab bar.
      */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-ground/95 px-4 pt-3 pb-[max(6.25rem,calc(env(safe-area-inset-bottom)+5.75rem))] backdrop-blur-md lg:hidden">
        <div className="mx-auto flex max-w-[1240px] items-center gap-3">
          <p className="min-w-0 flex-1 text-xs leading-4 text-ink-600">
            Allocated
            <strong className={cx("ml-1.5 font-semibold tabular-nums", balanced ? "text-accent" : "text-berry")}>
              {formatPennies(allocationTotal)}{expectedPrice !== null && ` of ${formatPennies(expectedPrice)}`}
            </strong>
          </p>
          <Button type="submit" size="lg" disabled={saving || !balanced} className="shrink-0">
            {saving ? "Saving..." : editId ? "Save changes" : "Save purchase"}
          </Button>
        </div>
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
    <section className="dark min-w-0 rounded-2xl border border-pine-700 bg-linear-to-br from-pine-900 to-pine-800 p-4 text-white shadow-card sm:col-span-2 sm:p-5" aria-label={`${recipient.name} budget position`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-eyebrow text-gold uppercase">Budget position</p>
          <h3 className="mt-1 break-words font-display text-lg font-semibold">{recipient.name}</h3>
        </div>
        {editing && <Badge tone="neutral" dot={false}>Editing purchase</Badge>}
      </div>
      <dl className="mt-4 grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3">
        <BudgetMetric label="Budget" value={formatPennies(recipient.budgetPennies)} />
        <BudgetMetric label="Already spent" value={formatPennies(recipient.spentPennies)} />
        <BudgetMetric className="col-span-2 sm:col-span-1" label={currentDifference < 0 ? "Currently over budget" : currentDifference === 0 ? "Current position" : "Currently remaining"} value={currentDifference === 0 ? "Budget reached" : formatPennies(Math.abs(currentDifference))} warning={currentDifference < 0} />
      </dl>
      <FinancialProgressBar actualPennies={recipient.spentPennies} plannedPennies={recipient.budgetPennies} mode="budget" showDifference={false} />
      {projectedSpentPennies !== null && projectedDifference !== null && (
        <div className="mt-4 border-t border-line pt-4">
          <p className={cx("text-xs font-semibold tracking-eyebrow uppercase", projectedDifference < 0 ? "text-berry" : "text-accent")}>After this purchase</p>
          <div className="mt-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <strong className="break-words font-display text-xl font-semibold tabular-nums">{formatPennies(projectedSpentPennies)} spent</strong>
            <strong className={cx("text-sm font-semibold tabular-nums break-words", projectedDifference < 0 ? "text-berry" : "text-accent")}>
              {projectedDifference < 0 ? `${formatPennies(Math.abs(projectedDifference))} over budget` : projectedDifference === 0 ? "Budget reached" : `${formatPennies(projectedDifference)} remaining`}
            </strong>
          </div>
          <FinancialProgressBar actualPennies={projectedSpentPennies} plannedPennies={recipient.budgetPennies} mode="budget" showDifference={false} />
        </div>
      )}
    </section>
  );
}

function BudgetMetric({ label, value, warning = false, className = "" }: { label: string; value: string; warning?: boolean; className?: string }) {
  return (
    <div className={cx("min-w-0 rounded-xl border border-line bg-surface p-3", className)}>
      <dt className="text-xs font-medium text-ink-600">{label}</dt>
      <dd className={cx("mt-1 break-words font-semibold tabular-nums", warning && "text-berry")}>{value}</dd>
    </div>
  );
}

function MoneyAllocationInput({ name, pennies, onChange }: { name: string; pennies: number; onChange: (pennies: number) => void }) {
  const [value, setValue] = useState(priceInput(pennies));
  return (
    <MoneyInput
      compact
      aria-label={`${name} responsibility`}
      maxLength={INPUT_LIMITS.money}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        const parsed = parsePoundsToPennies(next);
        if (parsed.ok) onChange(parsed.pennies);
      }}
      onBlur={() => {
        const parsed = parsePoundsToPennies(value);
        if (!parsed.ok) setValue(priceInput(pennies));
      }}
      className="w-32 shrink-0"
    />
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
