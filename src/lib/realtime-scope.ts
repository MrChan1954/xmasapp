/**
 * Which Realtime tables can honestly be narrowed to one event.
 *
 * Pure policy, deliberately separate from the React hook that acts on it: this
 * is a decision about the SCHEMA, it needs no browser and no Supabase client,
 * and keeping it here is what lets `scripts/event-realtime.test.mjs` check it
 * against the migrations directly.
 */

/**
 * One table to watch, optionally narrowed to a single event.
 *
 * A plain string is the whole table, which is right for family-global data
 * (`people`) and for user-scoped data (`notifications`).
 */
export type RealtimeSource = string | { table: string; filter?: string };

/**
 * The published tables that carry their event id in a column of their own, and
 * can therefore be filtered server-side.
 *
 * Everything else published by migration 014 reaches its event only through a
 * parent row — `purchases` and `gift_ideas` through `christmas_recipients`,
 * `purchase_allocations` through `purchases`, `recipient_contributions`
 * through `christmas_recipients`. Postgres logical replication filters on the
 * changed row's own columns, so there is no honest filter to write for those;
 * inventing one would silently drop real changes. They stay unfiltered, and the
 * refetch they trigger is itself event-scoped, which is where the correctness
 * actually comes from.
 *
 * `people` is deliberately absent: it is family-global, and a renamed person
 * legitimately affects every event.
 */
export const EVENT_FILTERED_TABLES = ["christmas_recipients", "contributors", "settlements"] as const;

/** The column every one of those tables carries. */
export const EVENT_FILTER_COLUMN = "christmas_event_id";

/**
 * Narrow the tables that can be narrowed, and leave the rest alone.
 *
 * NOTE ON DELETES: with the default replica identity these tables use, a DELETE
 * carries only the primary key, so a filtered subscription cannot match one and
 * will not deliver it. That is safe HERE and only here: none of the three is
 * ever hard-deleted by this application — a contributor and a recipient are
 * retired with `active`, a payment with `voided_at` — so every change that
 * actually happens arrives as an INSERT or an UPDATE. `purchase_allocations`,
 * which IS hard-deleted and re-inserted whenever a purchase is edited, is not
 * on the filtered list precisely because of this.
 */
export function eventRealtimeSources(
  tables: readonly string[],
  eventId: string | null,
): RealtimeSource[] {
  return tables.map((table) => {
    if (!eventId) return table;
    if (!(EVENT_FILTERED_TABLES as readonly string[]).includes(table)) return table;
    return { table, filter: `${EVENT_FILTER_COLUMN}=eq.${eventId}` };
  });
}
