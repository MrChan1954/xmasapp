"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatPennies } from "@/lib/currency";
import {
  INPUT_LIMITS,
  parseMoneyToPennies,
  safeHttpUrl,
  validateHttpUrl,
  validateOptionalText,
  validateRequiredText,
} from "@/lib/input-validation";
import { createClient } from "../../../utils/supabase/client";

type GiftIdea = {
  id: string;
  christmas_recipient_id: string;
  title: string;
  estimated_price_pennies: number | null;
  retailer: string | null;
  url: string | null;
  notes: string | null;
  suggested_by_name: string | null;
  created_at: string;
  updated_at: string;
};

type EditorState =
  | { kind: "add" }
  | { kind: "edit"; idea: GiftIdea }
  | null;

type IdeaValues = {
  title: string;
  estimatedPrice: string;
  retailer: string;
  url: string;
  notes: string;
};

export function GiftIdeas({
  recipientId,
  recipientName,
  onCountChange,
}: {
  recipientId: string;
  recipientName: string;
  onCountChange: (count: number) => void;
}) {
  const [ideas, setIdeas] = useState<GiftIdea[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState>(null);
  const [confirming, setConfirming] = useState<GiftIdea | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [purchasedIdeaIds, setPurchasedIdeaIds] = useState<Set<string>>(new Set());

  const loadIdeas = useCallback(async () => {
    setLoading(true);
    const db = createClient();
    const [result, linkedPurchases] = await Promise.all([
      db.rpc("list_gift_ideas", { p_christmas_recipient_id: recipientId }),
      db.from("purchases").select("originating_gift_idea_id").eq("christmas_recipient_id", recipientId).is("deleted_at", null).not("originating_gift_idea_id", "is", null),
    ]);

    if (result.error) {
      setError(giftIdeaError("load", result.error.code));
      setIdeas(null);
      setLoading(false);
      return false;
    }

    const nextIdeas = (result.data ?? []) as GiftIdea[];
    setIdeas(nextIdeas);
    setPurchasedIdeaIds(new Set((linkedPurchases.data ?? []).flatMap((row) => row.originating_gift_idea_id ? [row.originating_gift_idea_id] : [])));
    onCountChange(nextIdeas.length);
    setError(null);
    setLoading(false);
    return true;
  }, [onCountChange, recipientId]);

  useEffect(() => {
    const handle = window.setTimeout(() => void loadIdeas(), 0);
    return () => window.clearTimeout(handle);
  }, [loadIdeas]);

  const saveIdea = async (values: IdeaValues, idea?: GiftIdea) => {
    const validation = validateIdea(values);
    if (!validation.ok) {
      return validation.error;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    const db = createClient();
    const result = await db.rpc("save_gift_idea", {
      p_gift_idea_id: idea?.id ?? null,
      p_christmas_recipient_id: recipientId,
      p_title: validation.values.title,
      p_estimated_price_pennies: validation.values.estimatedPricePennies,
      p_retailer: validation.values.retailer,
      p_url: validation.values.url,
      p_notes: validation.values.notes,
    });

    if (result.error) {
      setError(giftIdeaError(idea ? "edit" : "add", result.error.code));
      setSaving(false);
      return null;
    }

    const loaded = await loadIdeas();
    setSaving(false);
    if (!loaded) return null;
    setEditor(null);
    setNotice(idea ? `“${validation.values.title}” was updated.` : `“${validation.values.title}” was added.`);
    return null;
  };

  const removeIdea = async (idea: GiftIdea) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    const result = await createClient()
      .from("gift_ideas")
      .delete()
      .eq("id", idea.id)
      .eq("christmas_recipient_id", recipientId);

    if (result.error) {
      setError(giftIdeaError("remove", result.error.code));
      setSaving(false);
      return;
    }

    const loaded = await loadIdeas();
    setSaving(false);
    if (!loaded) return;
    setConfirming(null);
    setNotice(`“${idea.title}” was removed. Budgets and purchases were not changed.`);
  };

  return (
    <section className="rounded-2xl border border-[#e3e1d8] bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">Gift ideas</h3>
          <p className="mt-1 text-xs leading-5 text-[#7b8581]">Planning only — ideas do not count as purchases.</p>
        </div>
        {!editor && (
          <button
            type="button"
            onClick={() => { setEditor({ kind: "add" }); setConfirming(null); setError(null); setNotice(null); }}
            className="min-h-12 w-full rounded-xl bg-[#e6f1ed] px-4 text-sm font-bold text-[#174f45] sm:w-auto"
          >
            + Add gift idea
          </button>
        )}
      </div>

      {notice && <p role="status" className="mt-4 rounded-xl bg-[#edf7f3] p-3 text-sm font-semibold text-[#28685c]">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-[#fff2ed] p-3 text-sm font-semibold text-[#9a503c]">{error}</p>}

      {editor && (
        <GiftIdeaEditor
          recipientName={recipientName}
          idea={editor.kind === "edit" ? editor.idea : undefined}
          saving={saving}
          onCancel={() => { setEditor(null); setError(null); }}
          onSave={saveIdea}
        />
      )}

      {!editor && loading && (
        <div className="mt-5 grid gap-3 md:grid-cols-2" aria-label="Loading gift ideas">
          <IdeaSkeleton />
          <IdeaSkeleton />
        </div>
      )}

      {!editor && !loading && ideas === null && (
        <div className="mt-5 rounded-xl border border-dashed border-[#d8dfdb] p-5 text-center">
          <p className="text-sm text-[#7b8581]">Gift ideas are unavailable right now.</p>
          <button type="button" onClick={() => void loadIdeas()} className="mt-3 min-h-11 rounded-xl border px-4 text-sm font-bold text-[#28685c]">Try again</button>
        </div>
      )}

      {!editor && !loading && ideas?.length === 0 && (
        <div className="mt-5 rounded-xl border border-dashed border-[#d8dfdb] px-5 py-7 text-center">
          <p className="text-sm font-semibold text-[#7b8581]">No gift ideas yet.</p>
          <button
            type="button"
            onClick={() => { setEditor({ kind: "add" }); setError(null); setNotice(null); }}
            className="mt-4 min-h-12 w-full rounded-xl bg-[#174f45] px-5 text-sm font-bold text-white sm:w-auto"
          >
            + Add gift idea
          </button>
        </div>
      )}

      {!editor && !loading && ideas && ideas.length > 0 && (
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {ideas.map((idea) => {
            const itemUrl = safeHttpUrl(idea.url);
            return <article key={idea.id} className="flex min-w-0 flex-col rounded-xl border border-[#e3e8e5] bg-[#fbfcfb] p-4">
              <div className="flex items-start justify-between gap-3">
                <h4 className="min-w-0 break-words font-bold">{idea.title}</h4>
                {idea.estimated_price_pennies !== null && (
                  <span className="shrink-0 rounded-full bg-[#e9f3f0] px-2.5 py-1 text-xs font-bold text-[#28685c]">
                    Est. {formatPennies(idea.estimated_price_pennies)}
                  </span>
                )}
              </div>
              {idea.retailer && <p className="mt-2 text-sm font-semibold text-[#56635e]">{idea.retailer}</p>}
              {idea.notes && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[#69746f]">{idea.notes}</p>}
              <p className="mt-4 text-xs font-semibold text-[#89938f]">
                Suggested by {idea.suggested_by_name || "Unknown member (account link missing)"}
              </p>

              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                {purchasedIdeaIds.has(idea.id) ? (
                  <span className="inline-flex min-h-11 items-center rounded-xl bg-[#edf7f3] px-3 text-xs font-bold text-[#28685c]">Purchased</span>
                ) : (
                  <Link href={`/add-purchase?recipient=${encodeURIComponent(recipientId)}&idea=${encodeURIComponent(idea.id)}`} className="inline-flex min-h-11 items-center rounded-xl bg-[#1f5b50] px-3 text-xs font-bold text-white">Buy this idea</Link>
                )}
                {itemUrl && (
                  <a href={itemUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-xl bg-[#e4f1ed] px-3 text-xs font-bold text-[#28685c]">
                    View item
                  </a>
                )}
                <button type="button" onClick={() => { setEditor({ kind: "edit", idea }); setConfirming(null); setError(null); setNotice(null); }} className="min-h-11 rounded-xl border bg-white px-3 text-xs font-bold">Edit</button>
                <button type="button" onClick={() => { setConfirming(idea); setError(null); setNotice(null); }} className="min-h-11 rounded-xl px-3 text-xs font-bold text-[#9a503c]">Remove</button>
              </div>

              {confirming?.id === idea.id && (
                <div className="mt-3 rounded-xl border border-[#ead1c7] bg-[#fff5f1] p-3">
                  <p className="text-sm font-bold">Remove “{idea.title}”?</p>
                  <p className="mt-1 text-xs leading-5 text-[#7c655e]">This removes the idea only. Purchases and budgets will not change.</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button type="button" disabled={saving} onClick={() => setConfirming(null)} className="min-h-11 rounded-xl border bg-white text-xs font-bold disabled:opacity-50">Cancel</button>
                    <button type="button" disabled={saving} onClick={() => void removeIdea(idea)} className="min-h-11 rounded-xl bg-[#9a503c] text-xs font-bold text-white disabled:opacity-50">{saving ? "Removing..." : "Remove"}</button>
                  </div>
                </div>
              )}
            </article>;
          })}
        </div>
      )}
    </section>
  );
}

function GiftIdeaEditor({
  recipientName,
  idea,
  saving,
  onCancel,
  onSave,
}: {
  recipientName: string;
  idea?: GiftIdea;
  saving: boolean;
  onCancel: () => void;
  onSave: (values: IdeaValues, idea?: GiftIdea) => Promise<string | null>;
}) {
  const [values, setValues] = useState<IdeaValues>({
    title: idea?.title ?? "",
    estimatedPrice: idea?.estimated_price_pennies === null || idea?.estimated_price_pennies === undefined
      ? ""
      : priceInput(idea.estimated_price_pennies),
    retailer: idea?.retailer ?? "",
    url: idea?.url ?? "",
    notes: idea?.notes ?? "",
  });
  const [validation, setValidation] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const validationError = await onSave(values, idea);
    setValidation(validationError);
  };

  const update = (field: keyof IdeaValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setValidation(null);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-5 rounded-2xl border border-[#dfe6e2] bg-[#f8faf9] p-4 sm:p-5">
      <h4 className="text-lg font-bold">{idea ? "Edit gift idea" : "Add gift idea"}</h4>
      <p className="mt-1 text-xs text-[#7b8581]">For {recipientName}</p>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="block text-sm font-bold md:col-span-2">
          Gift <span className="text-[#a5543f]">*</span>
          <input autoFocus required maxLength={INPUT_LIMITS.title} value={values.title} onChange={(event) => update("title", event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-[#d5ddd9] bg-white px-3 outline-none focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]" />
        </label>

        <label className="block text-sm font-bold">
          Estimated price
          <span className="mt-2 flex h-12 items-center rounded-xl border border-[#d5ddd9] bg-white focus-within:border-[#75a99a] focus-within:ring-4 focus-within:ring-[#dcece7]">
            <span className="pl-3 text-[#69746f]">£</span>
            <input inputMode="decimal" maxLength={INPUT_LIMITS.money} placeholder="0.00" value={values.estimatedPrice} onChange={(event) => update("estimatedPrice", event.target.value)} className="h-full min-w-0 flex-1 rounded-xl px-2 outline-none" />
          </span>
        </label>

        <label className="block text-sm font-bold">
          Shop / retailer
          <input maxLength={INPUT_LIMITS.retailer} value={values.retailer} onChange={(event) => update("retailer", event.target.value)} placeholder="Amazon, Boots, Next..." className="mt-2 h-12 w-full rounded-xl border border-[#d5ddd9] bg-white px-3 outline-none focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]" />
        </label>

        <label className="block text-sm font-bold md:col-span-2">
          Link
          <input type="url" inputMode="url" maxLength={INPUT_LIMITS.url} value={values.url} onChange={(event) => update("url", event.target.value)} placeholder="https://..." className="mt-2 h-12 w-full rounded-xl border border-[#d5ddd9] bg-white px-3 outline-none focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]" />
        </label>

        <label className="block text-sm font-bold md:col-span-2">
          Notes
          <textarea maxLength={INPUT_LIMITS.notes} rows={4} value={values.notes} onChange={(event) => update("notes", event.target.value)} placeholder="Size, colour, or anything useful..." className="mt-2 w-full resize-y rounded-xl border border-[#d5ddd9] bg-white p-3 outline-none focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]" />
        </label>
      </div>

      {validation && <p role="alert" className="mt-4 text-sm font-semibold text-[#9a503c]">{validation}</p>}

      <div className="mt-6 grid grid-cols-2 gap-3">
        <button type="button" disabled={saving} onClick={onCancel} className="min-h-12 rounded-xl border bg-white font-bold disabled:opacity-50">Cancel</button>
        <button disabled={saving} className="min-h-12 rounded-xl bg-[#1f5b50] font-bold text-white disabled:opacity-50">{saving ? "Saving..." : idea ? "Save changes" : "Add idea"}</button>
      </div>
    </form>
  );
}

function validateIdea(values: IdeaValues):
  | { ok: true; values: { title: string; estimatedPricePennies: number | null; retailer: string | null; url: string | null; notes: string | null } }
  | { ok: false; error: string } {
  const title = validateRequiredText(values.title, { field: "a gift idea", maxLength: INPUT_LIMITS.title });
  if (!title.ok) return title;
  const price = parseMoneyToPennies(values.estimatedPrice, { field: "an estimated price", allowEmpty: true });
  if (!price.ok) return price;
  const retailer = validateOptionalText(values.retailer, { field: "the shop name", maxLength: INPUT_LIMITS.retailer });
  if (!retailer.ok) return retailer;
  const notes = validateOptionalText(values.notes, { field: "notes", maxLength: INPUT_LIMITS.notes, multiline: true });
  if (!notes.ok) return notes;
  const urlResult = validateHttpUrl(values.url);
  if (!urlResult.ok) return urlResult;

  return {
    ok: true,
    values: {
      title: title.value,
      estimatedPricePennies: price.value,
      retailer: retailer.value,
      url: urlResult.value,
      notes: notes.value,
    },
  };
}

function priceInput(pennies: number) {
  return (pennies / 100).toFixed(2).replace(/\.00$/, "");
}

function giftIdeaError(action: "load" | "add" | "edit" | "remove", code?: string) {
  if (code === "42P01" || code === "42883" || code === "PGRST202") {
    return "Gift Ideas is not ready yet. The Gift Ideas database migration must be applied first.";
  }
  const messages = {
    load: "Gift ideas could not be loaded. Check your connection and try again.",
    add: "This gift idea could not be added. Nothing was saved.",
    edit: "This gift idea could not be updated. Your previous version was kept.",
    remove: "This gift idea could not be removed. It is still saved.",
  };
  return messages[action];
}

function IdeaSkeleton() {
  return (
    <div className="h-40 animate-pulse rounded-xl border border-[#e8ecea] bg-[#fbfcfb] p-4">
      <div className="h-4 w-2/3 rounded bg-[#e9eeeb]" />
      <div className="mt-4 h-3 w-1/3 rounded bg-[#eef2f0]" />
      <div className="mt-7 h-3 w-1/2 rounded bg-[#eef2f0]" />
    </div>
  );
}
