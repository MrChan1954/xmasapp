"use client";

import { FormEvent, useCallback, useState } from "react";
import { formatPennies } from "@/lib/currency";
import { INPUT_LIMITS, safeHttpUrl } from "@/lib/input-validation";
import {
  WISHLIST_EMPTY,
  sortWishlist,
  toWishlistEntry,
  validateWish,
  type WishlistEntry,
} from "@/lib/wishlist";
import { createClient } from "@/utils/supabase/client";
import { IconPlus } from "../../components/icons";
import { Button, EmptyState, Field, Input, MoneyInput, Notice, Textarea } from "../../components/ui";

/**
 * THE BIRTHDAY PERSON'S OWN LIST, ON THEIR OWN SCREEN.
 *
 * WHAT IT TALKS TO. `birthday_wishlist_ideas`, directly, through ordinary
 * PostgREST calls behind row level security. There is no SECURITY DEFINER
 * routine in this path and deliberately so: a definer routine is a thing that
 * bypasses policies, and the one reader who must never bypass a policy on a
 * birthday is the person whose birthday it is.
 *
 * WHY IT CANNOT LEAK. The table it reads has no recipient, no event, no
 * purchase and no status -- there is no column on it that could say a wish had
 * been acted on, and no join from it that reaches one. `toWishlistEntry` then
 * copies a named list of fields and nothing else. Both are belt; the policies in
 * migration 040 are the braces.
 *
 * `canWrite` IS NOT THE PERMISSION. The database decides, and refuses a write
 * from anyone but the birthday person resolved inside their own Area. This
 * renders the form for somebody who will be allowed, rather than offering one
 * that is going to fail.
 */
export function WishlistEditor({
  personId,
  occurrenceYear,
  initial,
  canWrite,
}: {
  personId: string;
  occurrenceYear: number;
  initial: WishlistEntry[];
  canWrite: boolean;
}) {
  const [entries, setEntries] = useState<WishlistEntry[]>(() => sortWishlist(initial));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WishlistEntry | null>(null);
  const [confirming, setConfirming] = useState<WishlistEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * THE SERVER RENDER IS THE SOURCE, AND IT CAN CHANGE UNDER US.
   *
   * A navigation back to this page re-runs the loader and hands down a fresh
   * `initial`, while React keeps this component mounted. Adjusting state DURING
   * the render -- React's own pattern for a prop-derived value -- is what
   * keeps the list from showing what the last render had. An effect would do
   * the same thing one wasted render later.
   */
  const [rendered, setRendered] = useState(initial);
  if (rendered !== initial) {
    setRendered(initial);
    setEntries(sortWishlist(initial));
  }

  const reload = useCallback(async () => {
    const db = createClient();
    const result = await db
      .from("birthday_wishlist_ideas")
      // Named columns, never `*`. See the note at the top of this file.
      .select("id,person_id,occurrence_year,title,estimated_price_pennies,url,notes,created_at")
      .eq("person_id", personId)
      .eq("occurrence_year", occurrenceYear)
      .order("created_at", { ascending: false });

    if (result.error) {
      setError("Your list could not be loaded just now. Try again in a moment.");
      return false;
    }
    setEntries(sortWishlist((result.data ?? []).map(toWishlistEntry)));
    setError(null);
    return true;
  }, [occurrenceYear, personId]);

  const save = async (values: WishlistInput, existing?: WishlistEntry) => {
    const checked = validateWish(values);
    if (!checked.ok) return checked.error;

    setBusy(true);
    setError(null);
    setNotice(null);
    const db = createClient();

    /**
     * `area_id` and `created_by_app_member_id` are NOT sent. Migration 040's
     * trigger derives both from the person, so there is nothing here for a
     * browser to get wrong and nothing to spoof.
     */
    const result = existing
      ? await db.from("birthday_wishlist_ideas")
        .update({
          title: checked.value.title,
          estimated_price_pennies: checked.value.estimatedPricePennies,
          url: checked.value.url,
          notes: checked.value.notes,
        })
        .eq("id", existing.id)
      : await db.from("birthday_wishlist_ideas")
        .insert({
          person_id: personId,
          occurrence_year: occurrenceYear,
          title: checked.value.title,
          estimated_price_pennies: checked.value.estimatedPricePennies,
          url: checked.value.url,
          notes: checked.value.notes,
        });

    if (result.error) {
      setBusy(false);
      // 23505 is the one-wish-per-year index. Everything else is either a
      // refusal from a policy or a genuine outage, and neither is something the
      // person typing can act on differently.
      return result.error.code === "23505"
        ? "That is already on your list."
        : "That could not be saved. Check what you have typed and try again.";
    }

    const loaded = await reload();
    setBusy(false);
    if (!loaded) return null;
    setAdding(false);
    setEditing(null);
    setNotice(existing ? `“${checked.value.title}” was updated.` : `“${checked.value.title}” was added to your list.`);
    return null;
  };

  const remove = async (entry: WishlistEntry) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await createClient()
      .from("birthday_wishlist_ideas")
      .delete()
      .eq("id", entry.id)
      .eq("person_id", personId);

    if (result.error) {
      setError("That could not be removed just now. Try again in a moment.");
      setBusy(false);
      return;
    }

    const loaded = await reload();
    setBusy(false);
    if (!loaded) return;
    setConfirming(null);
    setNotice(`“${entry.title}” was taken off your list.`);
  };

  const editorOpen = adding || editing !== null;

  return (
    <section className="mt-6 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold text-ink-900">Your ideas</h3>
          <p className="mt-1 text-xs leading-5 text-ink-600">
            For your birthday in {occurrenceYear}. You can change or remove anything here at any time.
          </p>
        </div>
        {canWrite && !editorOpen && entries.length > 0 && (
          <Button
            variant="tonal"
            onClick={() => { setAdding(true); setConfirming(null); setError(null); setNotice(null); }}
            className="w-full sm:w-auto"
          >
            <IconPlus size={16} />
            Add idea
          </Button>
        )}
      </div>

      {notice && <Notice tone="success" className="mt-4">{notice}</Notice>}
      {error && <Notice tone="danger" className="mt-4">{error}</Notice>}

      {editorOpen && (
        <WishForm
          entry={editing ?? undefined}
          busy={busy}
          onCancel={() => { setAdding(false); setEditing(null); setError(null); }}
          onSave={save}
        />
      )}

      {!editorOpen && entries.length === 0 && (
        <EmptyState
          className="mt-5"
          icon={<span aria-hidden>✨</span>}
          title="Your list is empty"
          body={WISHLIST_EMPTY}
          action={canWrite
            ? (
              <Button onClick={() => { setAdding(true); setError(null); setNotice(null); }}>
                <IconPlus size={16} />
                Add idea
              </Button>
            )
            : undefined}
        />
      )}

      {!editorOpen && entries.length > 0 && (
        <ul className="mt-5 grid gap-3 md:grid-cols-2">
          {entries.map((entry) => (
            <li key={entry.id} className="min-w-0 rounded-xl border border-line bg-surface-2 p-4">
              <p className="break-words font-semibold text-ink-900">{entry.title}</p>

              {/* Their OWN guess at a price. There is no other price on this
                  screen, and no column on this table that could carry one. */}
              {entry.estimatedPricePennies !== null && (
                <p className="mt-1 text-sm font-medium tabular-nums text-ink-600">
                  around {formatPennies(entry.estimatedPricePennies)}
                </p>
              )}

              {entry.notes && (
                <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-line text-ink-700">
                  {entry.notes}
                </p>
              )}

              {safeHttpUrl(entry.url) && (
                <a
                  href={safeHttpUrl(entry.url)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block text-sm font-semibold break-all text-accent underline underline-offset-2"
                >
                  View link
                </a>
              )}

              {canWrite && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => { setEditing(entry); setAdding(false); setConfirming(null); setError(null); setNotice(null); }}
                  >
                    Edit
                  </Button>
                  {confirming?.id === entry.id
                    ? (
                      <>
                        <Button variant="dangerGhost" size="sm" disabled={busy} onClick={() => void remove(entry)}>
                          Remove it
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                          Keep it
                        </Button>
                      </>
                    )
                    : (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setConfirming(entry); setNotice(null); }}>
                        Remove
                      </Button>
                    )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type WishlistInput = {
  title: string;
  estimatedPrice: string;
  url: string;
  notes: string;
};

function WishForm({
  entry,
  busy,
  onCancel,
  onSave,
}: {
  entry?: WishlistEntry;
  busy: boolean;
  onCancel: () => void;
  onSave: (values: WishlistInput, existing?: WishlistEntry) => Promise<string | null>;
}) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [price, setPrice] = useState(
    entry?.estimatedPricePennies === null || entry?.estimatedPricePennies === undefined
      ? ""
      : (entry.estimatedPricePennies / 100).toFixed(2),
  );
  const [url, setUrl] = useState(entry?.url ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const failure = await onSave({ title, estimatedPrice: price, url, notes }, entry);
    setProblem(failure);
  };

  return (
    <form onSubmit={submit} className="mt-5 rounded-xl border border-line-strong bg-surface-2 p-4 sm:p-5">
      {problem && <Notice tone="danger" className="mb-4">{problem}</Notice>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What would you like?" required className="sm:col-span-2">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={INPUT_LIMITS.title}
            placeholder="AirPods"
            autoFocus
            required
          />
        </Field>

        <Field label="Roughly what does it cost?" hint="Optional — a guess is fine.">
          <MoneyInput value={price} onValueChange={setPrice} placeholder="129.00" />
        </Field>

        <Field label="Link" hint="Optional.">
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            maxLength={INPUT_LIMITS.url}
            inputMode="url"
            placeholder="https://"
          />
        </Field>

        <Field label="Anything else?" hint="Optional — size, colour, which one." className="sm:col-span-2">
          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={INPUT_LIMITS.notes}
            rows={3}
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>{entry ? "Save changes" : "Add to my list"}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
