"use client";

import { useCallback, useEffect, useState } from "react";
import { formatPennies } from "@/lib/currency";
import { safeHttpUrl } from "@/lib/input-validation";
import {
  WISHLIST_PLANNER_HEADING,
  WISHLIST_PLANNER_NOTE,
  sortWishlist,
  toWishlistEntry,
  type WishlistEntry,
} from "@/lib/wishlist";
import { createClient } from "@/utils/supabase/client";
import { Skeleton, cx } from "./ui";

/**
 * WHAT THE BIRTHDAY PERSON ASKED FOR, SHOWN TO THE PEOPLE BUYING.
 *
 * READ ONLY, ALWAYS. A wishlist is written by exactly one person and it is not
 * this reader -- migration 040's policies refuse a write from anybody but the
 * celebrant, so an edit control here would be a button that could not work.
 * More to the point: if a planner could write to this table, they could put a
 * private planning idea somewhere the celebrant is allowed to read it.
 *
 * IT SITS BESIDE THE FAMILY'S OWN IDEAS, NOT AMONG THEM. `gift_ideas` is where
 * the family plans, and the celebrant cannot see any of it. Keeping the two
 * lists visibly separate is what stops somebody adding a surprise to the wrong
 * one.
 *
 * NOTHING IS SHOWN WHEN THERE IS NOTHING. An empty wishlist renders no heading
 * at all rather than an empty box: most birthdays will not have one, and a
 * permanent "no wishlist" panel is furniture.
 */
export function WishlistPanel({
  personId,
  personName,
  occurrenceYear,
  className = "",
}: {
  personId: string;
  personName: string;
  occurrenceYear: number;
  className?: string;
}) {
  const [entries, setEntries] = useState<WishlistEntry[] | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const db = createClient();
    const result = await db
      .from("birthday_wishlist_ideas")
      .select("id,person_id,occurrence_year,title,estimated_price_pennies,url,notes,created_at")
      .eq("person_id", personId)
      .eq("occurrence_year", occurrenceYear)
      .order("created_at", { ascending: false });

    // A failure here is not worth a red box on somebody's planning screen: the
    // wishlist is an extra, and the birthday works without it.
    setEntries(result.error ? [] : sortWishlist((result.data ?? []).map(toWishlistEntry)));
    setLoading(false);
  }, [occurrenceYear, personId]);

  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  if (loading) {
    return <Skeleton className={cx("h-24", className)} />;
  }
  if (!entries || entries.length === 0) return null;

  const firstName = personName.split(" ")[0];

  return (
    <section className={cx("rounded-2xl border border-warning-border bg-gold-soft p-5 shadow-card sm:p-6", className)}>
      <div className="min-w-0">
        <p className="text-xs font-semibold tracking-[0.12em] uppercase text-gold">✨ {firstName}&apos;s own list</p>
        <h3 className="mt-1 font-display text-lg font-semibold text-ink-900">{WISHLIST_PLANNER_HEADING}</h3>
        <p className="mt-1 text-xs leading-5 text-ink-600">{WISHLIST_PLANNER_NOTE}</p>
      </div>

      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {entries.map((entry) => (
          <li key={entry.id} className="min-w-0 rounded-xl border border-line bg-surface p-4">
            <p className="break-words font-semibold text-ink-900">{entry.title}</p>
            {entry.estimatedPricePennies !== null && (
              <p className="mt-1 text-sm font-medium tabular-nums text-ink-600">
                they think around {formatPennies(entry.estimatedPricePennies)}
              </p>
            )}
            {entry.notes && (
              <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-line text-ink-700">{entry.notes}</p>
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
          </li>
        ))}
      </ul>
    </section>
  );
}
