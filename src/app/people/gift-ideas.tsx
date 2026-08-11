"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
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
import { IconPlus } from "../components/icons";
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  Input,
  MoneyInput,
  Notice,
  Skeleton,
  Textarea,
  buttonClasses,
} from "../components/ui";

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

  const showEmptyState = !editor && !loading && ideas?.length === 0;

  return (
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold">Gift ideas</h3>
          <p className="mt-1 text-xs leading-5 text-ink-600">Planning only — ideas do not count as purchases.</p>
        </div>
        {/* The empty state carries its own call to action, so the header one
            would be the same button twice. */}
        {!editor && !showEmptyState && (
          <Button
            variant="tonal"
            onClick={() => { setEditor({ kind: "add" }); setConfirming(null); setError(null); setNotice(null); }}
            className="w-full sm:w-auto"
          >
            <IconPlus size={16} />
            Add gift idea
          </Button>
        )}
      </div>

      {notice && <Notice tone="success" className="mt-4">{notice}</Notice>}
      {error && <Notice tone="danger" className="mt-4">{error}</Notice>}

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
        <div className="mt-5 rounded-xl border border-dashed border-line-strong p-5 text-center">
          <p className="text-sm text-ink-600">Gift ideas are unavailable right now.</p>
          <Button variant="tonal" onClick={() => void loadIdeas()} className="mt-3">Try again</Button>
        </div>
      )}

      {showEmptyState && (
        <EmptyState
          className="mt-5"
          illustration="star"
          title="No gift ideas yet"
          body={`Save inspiration for ${recipientName} here before anything is bought.`}
          action={
            <Button onClick={() => { setEditor({ kind: "add" }); setError(null); setNotice(null); }}>
              <IconPlus size={16} />
              Add gift idea
            </Button>
          }
        />
      )}

      {!editor && !loading && ideas && ideas.length > 0 && (
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {ideas.map((idea) => {
            const itemUrl = safeHttpUrl(idea.url);
            return <article key={idea.id} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface-2 p-4">
              <div className="flex items-start justify-between gap-3">
                <h4 className="min-w-0 break-words font-semibold">{idea.title}</h4>
                {idea.estimated_price_pennies !== null && (
                  <Badge tone="success" dot={false}>Est. {formatPennies(idea.estimated_price_pennies)}</Badge>
                )}
              </div>
              {idea.retailer && <p className="mt-1.5 text-sm font-medium text-ink-600">{idea.retailer}</p>}
              {idea.notes && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-ink-600">{idea.notes}</p>}
              <p className="mt-4 text-xs font-medium text-ink-400">
                Suggested by {idea.suggested_by_name || "Unknown member (account link missing)"}
              </p>

              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                {purchasedIdeaIds.has(idea.id) ? (
                  <Badge tone="success" className="min-h-11 rounded-xl px-3">Purchased</Badge>
                ) : (
                  <ButtonLink href={`/add-purchase?recipient=${encodeURIComponent(recipientId)}&idea=${encodeURIComponent(idea.id)}`} size="md">Buy this idea</ButtonLink>
                )}
                {itemUrl && (
                  <a href={itemUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses("tonal")}>
                    View item
                  </a>
                )}
                <Button variant="secondary" onClick={() => { setEditor({ kind: "edit", idea }); setConfirming(null); setError(null); setNotice(null); }}>Edit</Button>
                <Button variant="dangerGhost" onClick={() => { setConfirming(idea); setError(null); setNotice(null); }}>Remove</Button>
              </div>

              {confirming?.id === idea.id && (
                <div className="mt-3 rounded-xl border border-berry-soft-border bg-berry-soft p-3.5">
                  <p className="text-sm font-semibold">Remove “{idea.title}”?</p>
                  <p className="mt-1 text-xs leading-5 text-ink-600">This removes the idea only. Purchases and budgets will not change.</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button variant="secondary" disabled={saving} onClick={() => setConfirming(null)}>Cancel</Button>
                    <Button variant="danger" disabled={saving} onClick={() => void removeIdea(idea)}>{saving ? "Removing..." : "Remove"}</Button>
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
    <form onSubmit={(event) => void submit(event)} className="mt-5 rounded-2xl border border-line bg-surface-2 p-4 sm:p-5">
      <h4 className="font-display text-lg font-semibold">{idea ? "Edit gift idea" : "Add gift idea"}</h4>
      <p className="mt-1 text-xs text-ink-600">For {recipientName}</p>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Field label="Gift" required className="md:col-span-2">
          <Input autoFocus required maxLength={INPUT_LIMITS.title} value={values.title} onChange={(event) => update("title", event.target.value)} />
        </Field>

        <Field label="Estimated price">
          <MoneyInput maxLength={INPUT_LIMITS.money} value={values.estimatedPrice} onValueChange={(value) => update("estimatedPrice", value)} />
        </Field>

        <Field label="Shop / retailer">
          <Input maxLength={INPUT_LIMITS.retailer} value={values.retailer} onChange={(event) => update("retailer", event.target.value)} placeholder="Amazon, Boots, Next..." />
        </Field>

        <Field label="Link" className="md:col-span-2">
          <Input type="url" inputMode="url" maxLength={INPUT_LIMITS.url} value={values.url} onChange={(event) => update("url", event.target.value)} placeholder="https://..." />
        </Field>

        <Field label="Notes" className="md:col-span-2">
          <Textarea maxLength={INPUT_LIMITS.notes} rows={4} value={values.notes} onChange={(event) => update("notes", event.target.value)} placeholder="Size, colour, or anything useful..." />
        </Field>
      </div>

      {validation && <p role="alert" className="mt-4 text-sm font-semibold text-berry">{validation}</p>}

      <div className="mt-6 grid grid-cols-2 gap-3">
        <Button variant="secondary" size="lg" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="lg" disabled={saving}>{saving ? "Saving..." : idea ? "Save changes" : "Add idea"}</Button>
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
    <div className="h-40 rounded-xl border border-line bg-surface-2 p-4">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="mt-4 h-3 w-1/3" />
      <Skeleton className="mt-7 h-3 w-1/2" />
    </div>
  );
}
