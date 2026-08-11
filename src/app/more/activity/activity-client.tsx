"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "../../../../utils/supabase/client";
import { formatPennies } from "@/lib/currency";
import { PageHeader } from "../../components/app-shell";
import { Badge, EmptyState, Notice, Skeleton } from "../../components/ui";
import { useRealtimeRefresh } from "../../components/use-realtime-refresh";

type AuditEntry = {
  id: number;
  occurred_at: string;
  table_name: string;
  action: "added" | "removed" | "restored";
  actor_name: string | null;
  details: Record<string, string | null> | null;
};

const PAGE_SIZE = 100;

/** Table names are an implementation detail; these are what the family calls them. */
const SUBJECTS: Record<string, { singular: string; group: string }> = {
  people: { singular: "Person", group: "People" },
  contributors: { singular: "Contributor", group: "Contributors" },
  christmas_recipients: { singular: "Recipient", group: "People" },
  recipient_contributions: { singular: "Planned contribution", group: "Contributors" },
  purchases: { singular: "Purchase", group: "Purchases" },
  purchase_allocations: { singular: "Purchase split", group: "Purchases" },
  gift_ideas: { singular: "Gift idea", group: "Gift ideas" },
  settlements: { singular: "Payment", group: "Payments" },
  app_members: { singular: "Account", group: "Accounts" },
};

const ACTION_TONE = { added: "success", removed: "danger", restored: "warning" } as const;

/**
 * Describes one entry in the family's own language rather than echoing column
 * names. `details` is intentionally sparse — the trigger records only
 * identifiers and amounts — so anything missing degrades to the plain subject.
 */
function describe(entry: AuditEntry) {
  const subject = SUBJECTS[entry.table_name]?.singular ?? entry.table_name;
  const details = entry.details ?? {};
  const amount = details.amount_pennies;

  if (entry.table_name === "purchases" && details.description) {
    return amount
      ? `${subject}: ${details.description} (${formatPennies(Number(amount))})`
      : `${subject}: ${details.description}`;
  }
  if (entry.table_name === "settlements" && amount) {
    return `${subject} of ${formatPennies(Number(amount))}`;
  }
  if (entry.table_name === "gift_ideas" && details.title) {
    return `${subject}: ${details.title}`;
  }
  if (entry.table_name === "people" && details.name) {
    return `${subject}: ${details.name}`;
  }
  return subject;
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

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    // No admin check here: RLS on `audit_log` returns nothing to anyone who is
    // not the Global Admin, so the browser client is the whole enforcement.
    const result = await createClient()
      .from("audit_log")
      .select("id, occurred_at, table_name, action, actor_name, details")
      .order("occurred_at", { ascending: false })
      .limit(PAGE_SIZE);

    if (result.error) {
      setError("The activity log could not be loaded.");
    } else {
      setError(null);
      setEntries(result.data as AuditEntry[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // The log is written by triggers on tables that already stream, so a change
  // made on another device appears here without a reload.
  useRealtimeRefresh(
    ["purchases", "purchase_allocations", "settlements", "contributors", "gift_ideas", "people", "christmas_recipients"],
    () => load(true),
  );

  return (
    <>
      <PageHeader
        title="Activity"
        description="Everything added or removed across the app. Only the Global Admin can see this."
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
        <ul className="mt-6 grid gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-line bg-surface px-5 py-4 shadow-card"
            >
              <div className="min-w-0">
                <p className="font-medium text-ink-900">{describe(entry)}</p>
                <p className="mt-0.5 text-sm text-ink-600">
                  {/* A NULL actor can only come from the service-role client,
                      which nothing but the Family Access admin route uses. */}
                  {entry.actor_name ?? "Global Admin (Family Access)"} · {formatWhen(entry.occurred_at)}
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
  );
}
