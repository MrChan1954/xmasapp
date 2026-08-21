"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { INPUT_LIMITS, MAX_PENNIES, validateRequiredText, validateUuid } from "@/lib/input-validation";
import {
  validateRecipientAllocationSnapshot,
  type RecipientAllocation,
} from "@/lib/recipient-allocations";
import { createClient } from "@/utils/supabase/client";
import { isAuthRoute } from "./components/nav-items";
import { useRealtimeRefresh } from "./components/use-realtime-refresh";

export type Person = { id: string; name: string; budgetPennies: number; active: boolean; spentPennies: number | null; giftCount: number | null; ideaCount: number | null };
export type SaveRecipientInput = {
  id?: string;
  name: string;
  budgetPennies: number;
  allocations: RecipientAllocation[];
};
type Family = { people: Person[]; loading: boolean; error: string | null; role: "admin" | "member" | null; isAdmin: boolean; saveRecipient: (input: SaveRecipientInput) => Promise<void>; archive: (id: string) => Promise<void>; restore: (id: string) => Promise<void>; setIdeaCount: (id: string, count: number) => void; setPurchaseMetrics: (id: string, spentPennies: number, count: number) => void; refresh: (quiet?: boolean) => Promise<void> };
const Context = createContext<Family | null>(null);
const YEAR = 2026;

export function FamilyProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"admin" | "member" | null>(null);
  const authRoute = isAuthRoute(pathname);

  // `quiet` skips the loading flag so a background refresh (another device
  // changed something) updates the data in place instead of blanking the page
  // behind a skeleton. Matches the same option on Family Access.
  const load = useCallback(async (quiet = false) => {
    if (authRoute) { setLoading(false); return; }
    const db = createClient(); if (!quiet) setLoading(true);
    const auth = await db.auth.getUser();
    // The signed-out and revoked-member redirects used to live in `proxy.ts`.
    // They are here now because Cloudflare Workers cannot run Next 16's
    // Node-runtime proxy. This is a navigation convenience only — it was never
    // the security boundary. Every row stays behind RLS and every admin route
    // re-authorizes independently (see the comment in the family-access route).
    if (!auth.data.user) { setRole(null); setLoading(false); router.replace("/login"); return; }
    const membership = await db.from("app_members").select("role").eq("user_id", auth.data.user.id).eq("active", true).maybeSingle();
    if (!membership.data) {
      await db.auth.signOut();
      setRole(null);
      setLoading(false);
      router.replace("/login?error=access_denied");
      return;
    }
    setRole(membership.data.role === "admin" ? "admin" : "member");
    const event = await db.from("christmas_events").select("id").eq("year", YEAR).maybeSingle();
    if (event.error || !event.data) { setError("Christmas 2026 could not be loaded."); setLoading(false); return; }
    const recipients = await db.from("christmas_recipients").select("id,person_id,active,budget_pennies").eq("christmas_event_id", event.data.id).order("created_at");
    if (recipients.error) { setError("The Christmas people list could not be loaded."); setLoading(false); return; }
    const recipientIds = recipients.data.map((row) => row.id);
    const [personRows, ideaRows, purchaseRows] = await Promise.all([
      db.from("people").select("id,name").in("id", recipients.data.map((row) => row.person_id)),
      recipientIds.length
        ? db.from("gift_ideas").select("christmas_recipient_id").in("christmas_recipient_id", recipientIds)
        : Promise.resolve({ data: [], error: null }),
      recipientIds.length
        ? db.from("purchases").select("id,christmas_recipient_id,actual_price_pennies").in("christmas_recipient_id", recipientIds).is("deleted_at", null)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (personRows.error) { setError("Family names could not be loaded."); setLoading(false); return; }
    const names = new Map(personRows.data.map((row) => [row.id, row.name]));
    const ideaCounts = new Map<string, number>();
    if (!ideaRows.error) {
      for (const idea of ideaRows.data ?? []) {
        ideaCounts.set(
          idea.christmas_recipient_id,
          (ideaCounts.get(idea.christmas_recipient_id) ?? 0) + 1,
        );
      }
    }
    const spentByRecipient = new Map<string, number>();
    const purchaseCounts = new Map<string, number>();
    if (!purchaseRows.error) {
      for (const purchase of purchaseRows.data ?? []) {
        spentByRecipient.set(
          purchase.christmas_recipient_id,
          (spentByRecipient.get(purchase.christmas_recipient_id) ?? 0) + purchase.actual_price_pennies,
        );
        purchaseCounts.set(
          purchase.christmas_recipient_id,
          (purchaseCounts.get(purchase.christmas_recipient_id) ?? 0) + 1,
        );
      }
    }
    setPeople(recipients.data.flatMap((row) => { const name = names.get(row.person_id); return name ? [{ id: row.id, name, budgetPennies: row.budget_pennies, active: row.active, spentPennies: purchaseRows.error ? null : (spentByRecipient.get(row.id) ?? 0), giftCount: purchaseRows.error ? null : (purchaseCounts.get(row.id) ?? 0), ideaCount: ideaRows.error ? null : (ideaCounts.get(row.id) ?? 0) }] : []; }));
    const metricErrors = [
      ideaRows.error ? "Gift idea counts are unavailable until the Gift Ideas migration is applied." : null,
      purchaseRows.error ? "Purchase totals are unavailable until the Purchases migration is applied." : null,
    ].filter(Boolean);
    setError(metricErrors.length ? metricErrors.join(" ") : null); setLoading(false);
  }, [authRoute, router]);

  useEffect(() => { const handle = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(handle); }, [load]);

  // The people list, their budgets, and their idea/purchase counts all come from
  // these tables. Refreshing quietly keeps the grid on screen while it updates.
  // Skipped on auth routes, where there is no session to authorize a stream.
  useRealtimeRefresh(
    ["people", "christmas_recipients", "gift_ideas", "purchases"],
    () => load(true),
    { enabled: !authRoute },
  );

  const mutate = async (operation: PromiseLike<{ error: unknown | null }>, message: string) => { const result = await operation; if (result.error) { setError(message); throw new Error(message); } await load(); };
  const validatePersonValues = (id: string | null, name: string, budgetPennies: number) => {
    const validName = validateRequiredText(name, { field: "a name", maxLength: INPUT_LIMITS.name });
    if (!validName.ok) throw new Error(validName.error);
    if (!Number.isSafeInteger(budgetPennies) || budgetPennies < 0 || budgetPennies > MAX_PENNIES) throw new Error("Enter a valid Christmas budget.");
    if (id) {
      const validId = validateUuid(id, "Select a valid Christmas recipient.");
      if (!validId.ok) throw new Error(validId.error);
    }
    return validName.value;
  };
  const saveRecipient = async ({ id, name, budgetPennies, allocations }: SaveRecipientInput) => {
    const validName = validatePersonValues(id ?? null, name, budgetPennies);
    const validAllocations = validateRecipientAllocationSnapshot(budgetPennies, allocations);
    if (!validAllocations.ok) throw new Error(validAllocations.error);
    const db = createClient();
    const event = await db.from("christmas_events").select("id").eq("year", YEAR).single();
    if (event.error || !event.data) throw new Error("Christmas 2026 could not be loaded.");
    await mutate(db.rpc("save_christmas_recipient_with_contributions", {
      p_christmas_recipient_id: id ?? null,
      p_christmas_event_id: event.data.id,
      p_name: validName,
      p_budget_pennies: budgetPennies,
      p_allocations: validAllocations.value.map((allocation) => ({
        contributor_id: allocation.contributorId,
        planned_amount_pennies: allocation.plannedAmountPennies,
      })),
    }), id ? "The person could not be updated." : "The person could not be added.");
  };
  const setActive = async (id: string, active: boolean) => {
    const validId = validateUuid(id, "Select a valid Christmas recipient.");
    if (!validId.ok) throw new Error(validId.error);
    await mutate(createClient().rpc("set_christmas_recipient_active", { p_christmas_recipient_id: validId.value, p_active: active }), active ? "The person could not be restored." : "The person could not be removed.");
  };
  const archive = async (id: string) => setActive(id, false);
  const restore = async (id: string) => setActive(id, true);
  const setIdeaCount = useCallback((id: string, count: number) => setPeople((current) => current.map((person) => person.id === id ? { ...person, ideaCount: count } : person)), []);
  const setPurchaseMetrics = useCallback((id: string, spentPennies: number, count: number) => setPeople((current) => current.map((person) => person.id === id ? { ...person, spentPennies, giftCount: count } : person)), []);
  return <Context.Provider value={{ people, loading, error, role, isAdmin: role === "admin", saveRecipient, archive, restore, setIdeaCount, setPurchaseMetrics, refresh: load }}>{children}</Context.Provider>;
}

export function useFamily() { const value = useContext(Context); if (!value) throw new Error("FamilyProvider missing"); return value; }
export function useTotals() { const { people } = useFamily(); return useMemo(() => { const active = people.filter((person) => person.active); const budgetPennies = active.reduce((sum, person) => sum + person.budgetPennies, 0); const spentPennies = active.some((person) => person.spentPennies === null) ? null : active.reduce((sum, person) => sum + (person.spentPennies ?? 0), 0); return { active, budgetPennies, spentPennies, remainingPennies: spentPennies === null ? null : budgetPennies - spentPennies }; }, [people]); }
