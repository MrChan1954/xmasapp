"use client";

import { useEffect, useRef } from "react";
import { createClient } from "../../../utils/supabase/client";

// One edit usually lands as several row events across several tables: saving a
// purchase writes `purchases` and `purchase_allocations` in one transaction.
// Coalesce a burst into a single refetch instead of one per row.
const COALESCE_MS = 250;

// Channel names must not collide between subscribers on the same socket.
let channelSequence = 0;

/**
 * Refetch whenever another device changes one of `tables`.
 *
 * The stream is treated purely as a "something changed" signal — the payload is
 * deliberately never read. Refetching through the caller's existing loader keeps
 * every row going through the same authorized path (RLS for direct queries, the
 * admin route for Family Access), so a change notification can never widen what
 * a client can see. Supabase applies each subscriber's RLS SELECT policy before
 * delivering an event, so a table only reaches clients already allowed to read it.
 *
 * Also refetches when a hidden tab becomes visible again. A phone that slept, or
 * a laptop that suspended, drops the websocket and misses everything sent while
 * it was away; without this the tab would silently show stale data until reload.
 *
 * `onChange` is held in a ref, so passing an inline closure does not tear down
 * and rebuild the subscription on every render.
 */
export function useRealtimeRefresh(
  tables: readonly string[],
  // Any return value is accepted so existing loaders can be passed as-is; some
  // resolve with the data they fetched. The result is discarded.
  onChange: () => unknown,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Depend on the contents rather than the array identity, so callers can pass a
  // literal without memoizing it.
  const tableKey = [...tables].sort().join(",");

  useEffect(() => {
    if (!enabled || !tableKey) return;

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
    const channel = db.channel(`refresh-${channelSequence}-${tableKey}`);

    for (const table of tableKey.split(",")) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, schedule);
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
  }, [enabled, tableKey]);
}
