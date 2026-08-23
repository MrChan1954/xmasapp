"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/utils/supabase/client";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventRealtimeSources, EVENT_FILTERED_TABLES, type RealtimeSource } from "@/lib/realtime-scope.ts";

// Re-exported so a screen imports its subscription helper from one place.
export { eventRealtimeSources, EVENT_FILTERED_TABLES };
export type { RealtimeSource };

// One edit usually lands as several row events across several tables: saving a
// purchase writes `purchases` and `purchase_allocations` in one transaction.
// Coalesce a burst into a single refetch instead of one per row.
const COALESCE_MS = 250;

// Channel names must not collide between subscribers on the same socket.
let channelSequence = 0;

/**
 * Refetch whenever another device changes one of `sources`.
 *
 * The stream is treated purely as a "something changed" signal — the payload is
 * deliberately never read, and is never financial truth. Refetching through the
 * caller's existing loader keeps every row going through the same authorized,
 * EVENT-SCOPED query it already used, so a change notification can neither
 * widen what a client can see nor show it another event's rows. Supabase
 * applies each subscriber's RLS SELECT policy before delivering an event, so a
 * table only reaches clients already allowed to read it.
 *
 * Also refetches when a hidden tab becomes visible again. A phone that slept, or
 * a laptop that suspended, drops the websocket and misses everything sent while
 * it was away; without this the tab would silently show stale data until reload.
 *
 * `onChange` is held in a ref, so passing an inline closure does not tear down
 * and rebuild the subscription on every render.
 */
export function useRealtimeRefresh(
  sources: readonly RealtimeSource[],
  // Any return value is accepted so existing loaders can be passed as-is; some
  // resolve with the data they fetched. The result is discarded.
  onChange: () => unknown,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Depend on the contents rather than the array identity, so callers can pass a
  // literal without memoizing it.
  //
  // The FILTER is part of the key, which is what makes switching events safe:
  // the key changes, the effect tears the old channel down and opens a new one,
  // and no subscription is left listening for the event the reader has left.
  const subscriptionKey = JSON.stringify(
    [...sources]
      .map((source) => (typeof source === "string" ? { table: source } : source))
      .sort((left, right) => (left.table + (left.filter ?? "")).localeCompare(right.table + (right.filter ?? ""))),
  );

  useEffect(() => {
    if (!enabled || subscriptionKey === "[]") return;

    let disposed = false;
    let timer: number | undefined;

    const run = () => {
      if (disposed) return;
      // A background refresh that fails must not surface as an unhandled
      // rejection: the page keeps whatever it already had on screen, and the
      // next change event or tab focus retries. Loaders that own an error
      // banner still set it themselves.
      Promise.resolve(onChangeRef.current()).catch(() => {});
    };

    const schedule = () => {
      if (disposed) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(run, COALESCE_MS);
    };

    const db = createClient();
    channelSequence += 1;
    const channel = db.channel(`refresh-${channelSequence}`);

    const watched: { table: string; filter?: string }[] = JSON.parse(subscriptionKey);
    for (const { table, filter } of watched) {
      channel.on(
        "postgres_changes",
        // `filter` is omitted rather than passed as undefined: Supabase treats
        // its presence as a request to narrow, and an undefined one would be
        // sent as the string "undefined".
        filter
          ? { event: "*", schema: "public", table, filter }
          : { event: "*", schema: "public", table },
        schedule,
      );
    }
    channel.subscribe();

    const onVisible = () => {
      if (document.visibilityState === "visible") schedule();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      void db.removeChannel(channel);
    };
  }, [enabled, subscriptionKey]);
}
