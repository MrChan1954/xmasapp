"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { formatPennies } from "@/lib/currency";
import { PageHeader } from "../../components/app-shell";
import { Badge, ChipRow, EmptyState, FilterChip, Input, Notice, Segmented, Skeleton, Toolbar } from "../../components/ui";
import { useAreas } from "../../components/use-areas";
import { useRealtimeRefresh } from "../../components/use-realtime-refresh";

type AuditEntry = {
  id: number;
  occurred_at: string;
  table_name: string;
  action: "added" | "removed" | "restored";
  actor_name: string | null;
  subject: string | null;
  context: string | null;
  amount_pennies: number | null;
};

const PAGE_SIZE = 300;

/** Table names are an implementation detail; these are what the family calls them. */
const KINDS = {
  purchases: "Purchases",
  purchase_allocations: "Purchase splits",
  gift_ideas: "Gift ideas",
  settlements: "Payments",
  contributors: "Contributors",
  recipient_contributions: "Planned amounts",
  christmas_recipients: "People on the list",
  people: "People",
  app_members: "Accounts",
} as const;

const ACTION_TONE = { added: "success", removed: "danger", restored: "warning" } as const;

type ActionFilter = "all" | "added" | "removed" | "restored";
type SortKey = "newest" | "oldest" | "largest";

/**
 * Turns the structured columns into one readable line. The trigger resolves
 * names at write time, so this is only composition — no lookups, and entries
 * stay accurate even after the underlying record is deleted.
 */
function describe(entry: AuditEntry) {
  const { table_name: kind, subject, context, amount_pennies: amount } = entry;
  const money = amount !== null ? formatPennies(amount) : null;

  if (kind === "settlements") {
    return subject && context ? `${subject} paid ${context}${money ? ` ${money}` : ""}` : `Payment${money ? ` ${money}` : ""}`;
  }
  if (kind === "purchases") {
    return `${subject ?? "Purchase"}${money ? ` (${money})` : ""}${context ? ` for ${context}` : ""}`;
  }
  if (kind === "purchase_allocations") {
    return `${subject ?? "Someone"}'s share${money ? ` of ${money}` : ""}${context ? ` on ${context}` : ""}`;
  }
  if (kind === "recipient_contributions") {
    return `${subject ?? "Someone"}'s planned${money ? ` ${money}` : ""}${context ? ` for ${context}` : ""}`;
  }
  if (kind === "gift_ideas") {
    return `${subject ?? "Gift idea"}${context ? ` for ${context}` : ""}`;
  }
  if (kind === "app_members") {
    return `Account for ${subject ?? "someone"}${context ? ` (${context})` : ""}`;
  }
  if (kind === "christmas_recipients") {
    return `${subject ?? "Someone"} as a recipient${money ? ` (${money} budget)` : ""}`;
  }
  return subject ?? KINDS[kind as keyof typeof KINDS] ?? kind;
}

function formatWhen(value: string) {
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ActivityClient() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /*
   * The family on screen, resolved the same way the switcher resolves it, so
   * this screen and the menu can never disagree about which one that is.
   * `active` is null until the list has loaded; the read below waits for it.
   */
  const { active, loading: areasLoading } = useAreas();
  const activeAreaId = active?.id ?? null;

  const [action, setAction] = useState<ActionFilter>("all");
  const [kind, setKind] = useState<string>("all");
  const [actor, setActor] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");

  const load = useCallback(async (quiet = false) => {
    /*
     * NOTHING UNTIL WE KNOW WHICH FAMILY THIS IS ABOUT. Reading first and
     * narrowing afterwards would put another family's activity on screen for
     * however long the Area takes to resolve, which is the whole defect.
     */
    if (!activeAreaId) {
      /*
       * No family resolved. While the list is still arriving that is simply
       * "not yet", and the skeleton is the right thing to show. Once it HAS
       * arrived and there is still nothing, waiting for ever is not -- an
       * account with no family gets the empty state rather than a skeleton
       * that never resolves.
       */
      if (!areasLoading) setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);

    /**
     * ROW LEVEL SECURITY IS NOT THE WHOLE ANSWER HERE, AND USED TO BE ASKED TO BE.
     *
     * `audit_log`'s policy is `is_active_app_member() AND is_area_member(area_id)`
     * -- it asks which families you BELONG to, not which one you are STANDING
     * IN. For a login in one family those are the same sentence. For a login in
     * several they are not, and this screen asked the wrong one: standing in
     * one family it listed the activity of every family the account belonged
     * to, interleaved, with no way to tell which row came from where.
     *
     * Found in live Q10 browser QA: the same three hundred entries came back
     * whichever family was selected, byte for byte.
     *
     * This is NOT a cross-tenant leak -- the policy still refuses an Area you
     * are not a member of, so nobody ever saw a stranger's family. It is the
     * acting-Area rule being skipped, and that rule is the one the whole
     * application rests on: the selected Area is authoritative for every read.
     *
     * The bell is deliberately account-global and stays that way. This screen
     * was never meant to be, and nothing documented it as such.
     */
    const result = await createClient()
      .from("audit_log")
      .select("id, occurred_at, table_name, action, actor_name, subject, context, amount_pennies")
      .eq("area_id", activeAreaId)
      .order("occurred_at", { ascending: false })
      .limit(PAGE_SIZE);

    if (result.error) {
      setError("The activity log could not be loaded.");
    } else {
      setError(null);
      setEntries(result.data as AuditEntry[]);
    }
    setLoading(false);
  }, [activeAreaId, areasLoading]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // The log is written by triggers on tables that already stream, so activity
  // from another device appears without a reload.
  useRealtimeRefresh(
    ["purchases", "purchase_allocations", "settlements", "contributors", "gift_ideas", "people", "christmas_recipients", "recipient_contributions"],
    () => load(true),
  );

  // Only offer filters that this log actually contains, so nothing dead-ends.
  const kinds = useMemo(
    () => [...new Set(entries.map((entry) => entry.table_name))].sort(),
    [entries],
  );
  const actors = useMemo(
    () => [...new Set(entries.map((entry) => entry.actor_name).filter((name): name is string => Boolean(name)))].sort(),
    [entries],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (action !== "all" && entry.action !== action) return false;
      if (kind !== "all" && entry.table_name !== kind) return false;
      if (actor !== "all" && (entry.actor_name ?? "") !== actor) return false;
      if (!needle) return true;
      return `${describe(entry)} ${entry.actor_name ?? ""}`.toLowerCase().includes(needle);
    });

    if (sort === "largest") {
      // Entries with no money sort last rather than being treated as zero.
      return [...filtered].sort((a, b) => (b.amount_pennies ?? -1) - (a.amount_pennies ?? -1));
    }
    return sort === "oldest" ? [...filtered].reverse() : filtered;
  }, [entries, action, kind, actor, query, sort]);

  const counts = useMemo(
    () => ({
      all: entries.length,
      added: entries.filter((entry) => entry.action === "added").length,
      removed: entries.filter((entry) => entry.action === "removed").length,
      restored: entries.filter((entry) => entry.action === "restored").length,
    }),
    [entries],
  );

  return (
    <>
      <PageHeader
        title="Activity"
        description="Everything added or removed across the app, and who did it."
      />

      {error && <Notice tone="danger" className="mt-6">{error}</Notice>}

      {loading && (
        <div className="mt-6 grid gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      )}

      {!loading && !error && entries.length === 0 && (
        <EmptyState
          className="mt-6"
          illustration="star"
          title="Nothing recorded yet"
          body="Adds and removals will appear here as the family uses the app."
        />
      )}

      {!loading && entries.length > 0 && (
        <>
          <Toolbar
            className="mt-6"
            start={
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search activity"
                aria-label="Search activity"
                className="sm:w-64"
              />
            }
            end={
              <Segmented
                ariaLabel="Sort activity"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "newest", label: "Newest" },
                  { value: "oldest", label: "Oldest" },
                  { value: "largest", label: "Largest" },
                ]}
              />
            }
          />

          <ChipRow label="Action" className="mt-4">
            {(["all", "added", "removed", "restored"] as const).map((value) => (
              <FilterChip
                key={value}
                active={action === value}
                count={counts[value]}
                onClick={() => setAction(value)}
              >
                {value === "all" ? "All" : value[0].toUpperCase() + value.slice(1)}
              </FilterChip>
            ))}
          </ChipRow>

          <ChipRow label="Type" className="mt-3">
            <FilterChip active={kind === "all"} onClick={() => setKind("all")}>All</FilterChip>
            {kinds.map((value) => (
              <FilterChip key={value} active={kind === value} onClick={() => setKind(value)}>
                {KINDS[value as keyof typeof KINDS] ?? value}
              </FilterChip>
            ))}
          </ChipRow>

          {actors.length > 1 && (
            <ChipRow label="Who" className="mt-3">
              <FilterChip active={actor === "all"} onClick={() => setActor("all")}>Everyone</FilterChip>
              {actors.map((name) => (
                <FilterChip key={name} active={actor === name} onClick={() => setActor(name)}>
                  {name}
                </FilterChip>
              ))}
            </ChipRow>
          )}

          <p className="mt-5 text-sm text-ink-600">
            {visible.length === entries.length
              ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`
              : `${visible.length} of ${entries.length} entries`}
          </p>

          {visible.length === 0 ? (
            <EmptyState
              className="mt-4"
              illustration="star"
              title="Nothing matches"
              body="Try a different filter or search."
            />
          ) : (
            <ul className="mt-3 grid gap-2">
              {visible.map((entry) => (
                <li
                  key={entry.id}
                  /**
                   * `min-w-0` MATTERS ON A GRID ITEM, and its absence was
                   * visible on a phone.
                   *
                   * These rows are items of a single-column `grid`, and a grid
                   * item's `min-width` defaults to `auto` -- it will not shrink
                   * below its own min-content width. One row containing a long
                   * unbreakable run of characters therefore widened the TRACK,
                   * and every other row with it: measured at 390px in live Q10
                   * QA, one gift name pushed all three hundred rows to 407px
                   * and scrolled the whole page sideways by 33.
                   *
                   * `break-words` is the other half. Without it the long run
                   * has nowhere to break and overflows the row instead of the
                   * page, which is tidier and still wrong.
                   */
                  className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-line bg-surface px-5 py-4 shadow-card"
                >
                  <div className="min-w-0">
                    <p className="font-medium break-words text-ink-900">{describe(entry)}</p>
                    <p className="mt-0.5 text-sm text-ink-600">
                      {/* A missing actor can only come from the service-role
                          client, which nothing but the Family Access route uses. */}
                      {entry.actor_name ?? "Family admin (Family Access)"} · {formatWhen(entry.occurred_at)} ·{" "}
                      {KINDS[entry.table_name as keyof typeof KINDS] ?? entry.table_name}
                    </p>
                  </div>
                  <Badge tone={ACTION_TONE[entry.action]}>{entry.action}</Badge>
                </li>
              ))}
            </ul>
          )}

          {entries.length === PAGE_SIZE && (
            <p className="mt-4 text-sm text-ink-600">Showing the most recent {PAGE_SIZE} entries.</p>
          )}
        </>
      )}
    </>
  );
}
