"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventIdFromPath } from "@/lib/events.ts";
import { INPUT_LIMITS, MAX_PENNIES, validateRequiredText, validateUuid } from "@/lib/input-validation";
import {
  validateRecipientAllocationSnapshot,
  type RecipientAllocation,
} from "@/lib/recipient-allocations";
import { getCurrentMemberClient } from "@/utils/supabase/current-member-client";
import { createClient } from "@/utils/supabase/client";
import { isAuthRoute } from "./components/nav-items";
import { eventRealtimeSources, useRealtimeRefresh } from "./components/use-realtime-refresh";

export type Person = { id: string; personId: string; name: string; budgetPennies: number; active: boolean; spentPennies: number | null; giftCount: number | null; ideaCount: number | null };
export type SaveRecipientInput = {
  id?: string;
  name: string;
  budgetPennies: number;
  allocations: RecipientAllocation[];
};
/**
 * The event the chrome is about.
 *
 * `celebrantPersonId` is here so a screen can tell whether a recipient IS the
 * birthday person -- which is what decides whether their own wishlist is worth
 * showing beside the family's ideas. A birthday event has exactly one
 * celebrant; every other kind has none.
 */
export type ActiveEvent = { id: string; name: string; type: string; eventDate: string; status: string; year: number | null; celebrantPersonId: string | null };
type Family = { eventId: string | null; event: ActiveEvent | null; people: Person[]; loading: boolean; error: string | null; role: "admin" | "member" | null; isAdmin: boolean; saveRecipient: (input: SaveRecipientInput) => Promise<void>; addExistingPerson: (input: { personId: string; name: string; budgetPennies: number; allocations: RecipientAllocation[] }) => Promise<void>; archive: (id: string) => Promise<void>; restore: (id: string) => Promise<void>; setIdeaCount: (id: string, count: number) => void; setPurchaseMetrics: (id: string, spentPennies: number, count: number) => void; refresh: (quiet?: boolean) => Promise<void> };
const Context = createContext<Family | null>(null);

/**
 * THE URL OWNS THE EVENT.
 *
 * This provider used to find its event by year, which is what made the whole
 * application mean "Christmas 2026". It now reads the id straight out of the
 * path on every render, so a refresh, a bookmark, a shared link and a tab
 * restored from sleep all resolve to the same event, and React state can never
 * disagree with the address bar. Outside an event -- the dashboard, Family
 * Access, Account -- there is no event and no event-scoped data is fetched.
 */
export function FamilyProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const eventId = eventIdFromPath(pathname);
  const [people, setPeople] = useState<Person[]>([]);
  const [event, setEvent] = useState<ActiveEvent | null>(null);
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
    // The role in the family on screen. A `maybeSingle()` here would error for a
    // login in two families and strip the admin controls from somebody who is
    // an administrator -- in both.
    const membership = { data: await getCurrentMemberClient() };
    if (!membership.data) {
      await db.auth.signOut();
      setRole(null);
      setLoading(false);
      router.replace("/login?error=access_denied");
      return;
    }
    setRole(membership.data.role === "admin" ? "admin" : "member");
    // Outside an event there is nothing event-scoped to fetch. The role above
    // is still needed, because the navigation chrome renders everywhere.
    if (!eventId) { setPeople([]); setEvent(null); setError(null); setLoading(false); return; }
    // Identity only, for the chrome that has to name the active event. The
    // server has already validated this id in `requireEvent`; this read is
    // behind the same RLS policy and cannot widen what it returns.
    const eventRow = await db.from("events").select("id,name,event_type,event_date,status,year,celebrant_person_id").eq("id", eventId).maybeSingle();
    setEvent(eventRow.data
      ? { id: eventRow.data.id, name: eventRow.data.name, type: eventRow.data.event_type, eventDate: String(eventRow.data.event_date).slice(0, 10), status: eventRow.data.status, year: eventRow.data.year, celebrantPersonId: eventRow.data.celebrant_person_id ?? null }
      : null);
    const recipients = await db.from("christmas_recipients").select("id,person_id,active,budget_pennies").eq("christmas_event_id", eventId).order("created_at");
    if (recipients.error) { setError("This event's people list could not be loaded."); setLoading(false); return; }
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
    setPeople(recipients.data.flatMap((row) => { const name = names.get(row.person_id); return name ? [{ id: row.id, personId: row.person_id, name, budgetPennies: row.budget_pennies, active: row.active, spentPennies: purchaseRows.error ? null : (spentByRecipient.get(row.id) ?? 0), giftCount: purchaseRows.error ? null : (purchaseCounts.get(row.id) ?? 0), ideaCount: ideaRows.error ? null : (ideaCounts.get(row.id) ?? 0) }] : []; }));
    const metricErrors = [
      ideaRows.error ? "Gift idea counts are unavailable until the Gift Ideas migration is applied." : null,
      purchaseRows.error ? "Purchase totals are unavailable until the Purchases migration is applied." : null,
    ].filter(Boolean);
    setError(metricErrors.length ? metricErrors.join(" ") : null); setLoading(false);
  }, [authRoute, eventId, router]);

  useEffect(() => { const handle = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(handle); }, [load]);

  // The people list, their budgets, and their idea/purchase counts all come from
  // these tables. Refreshing quietly keeps the grid on screen while it updates.
  // Skipped on auth routes, where there is no session to authorize a stream.
  useRealtimeRefresh(
    eventRealtimeSources(["people", "christmas_recipients", "gift_ideas", "purchases"], eventId),
    () => load(true),
    { enabled: !authRoute },
  );

  const mutate = async (operation: PromiseLike<{ error: unknown | null }>, message: string) => { const result = await operation; if (result.error) { setError(message); throw new Error(message); } await load(); };
  const validatePersonValues = (id: string | null, name: string, budgetPennies: number) => {
    const validName = validateRequiredText(name, { field: "a name", maxLength: INPUT_LIMITS.name });
    if (!validName.ok) throw new Error(validName.error);
    if (!Number.isSafeInteger(budgetPennies) || budgetPennies < 0 || budgetPennies > MAX_PENNIES) throw new Error("Enter a valid budget.");
    if (id) {
      const validId = validateUuid(id, "Select a valid recipient.");
      if (!validId.ok) throw new Error(validId.error);
    }
    return validName.value;
  };
  /**
   * Add somebody who ALREADY EXISTS in the family directory to this event.
   *
   * THE BUG THIS REPLACES. `save_christmas_recipient_with_contributions` takes
   * a NAME, and when it is given no recipient id it runs
   * `insert into public.people (name)` unconditionally -- no lookup, no match.
   * So typing "Eden" on Christmas and "Eden" on Halloween created TWO Eden
   * rows, each with its own birthday and its own history, and the family had no
   * way to see they were the same child.
   *
   * Two calls, in order, because the existing functions divide the work that
   * way: `add_event_recipient` links an EXISTING person to the event at a zero
   * budget -- the same call Event Settings has always made -- and then the
   * budget and the contribution plan are written by the same atomic function as
   * before, this time with a recipient id so it takes its update path and
   * creates nobody.
   */
  const addExistingPerson = async ({ personId, name, budgetPennies, allocations }: {
    personId: string;
    name: string;
    budgetPennies: number;
    allocations: RecipientAllocation[];
  }) => {
    const validPerson = validateUuid(personId, "Choose who this is for.");
    if (!validPerson.ok) throw new Error(validPerson.error);
    validatePersonValues(null, name, budgetPennies);
    const validAllocations = validateRecipientAllocationSnapshot(budgetPennies, allocations);
    if (!validAllocations.ok) throw new Error(validAllocations.error);
    if (!eventId) throw new Error("Open an event before adding a person.");

    const db = createClient();
    const added = await db.rpc("add_event_recipient", {
      p_event_id: eventId,
      p_person_id: validPerson.value,
    });
    if (added.error) { setError("That person could not be added to this event."); throw new Error("add failed"); }
    const recipientId = (added.data as { id?: string } | null)?.id;
    if (!recipientId) { setError("That person could not be added to this event."); throw new Error("add failed"); }

    await mutate(db.rpc("save_christmas_recipient_with_contributions", {
      p_christmas_recipient_id: recipientId,
      p_christmas_event_id: eventId,
      p_name: name,
      p_budget_pennies: budgetPennies,
      p_allocations: validAllocations.value.map((allocation) => ({
        contributor_id: allocation.contributorId,
        planned_amount_pennies: allocation.plannedAmountPennies,
      })),
    }), "The budget could not be set for that person.");
  };

  const saveRecipient = async ({ id, name, budgetPennies, allocations }: SaveRecipientInput) => {
    const validName = validatePersonValues(id ?? null, name, budgetPennies);
    const validAllocations = validateRecipientAllocationSnapshot(budgetPennies, allocations);
    if (!validAllocations.ok) throw new Error(validAllocations.error);
    if (!eventId) throw new Error("Open an event before adding or editing a person.");
    const db = createClient();
    await mutate(db.rpc("save_christmas_recipient_with_contributions", {
      p_christmas_recipient_id: id ?? null,
      p_christmas_event_id: eventId,
      p_name: validName,
      p_budget_pennies: budgetPennies,
      p_allocations: validAllocations.value.map((allocation) => ({
        contributor_id: allocation.contributorId,
        planned_amount_pennies: allocation.plannedAmountPennies,
      })),
    }), id ? "The person could not be updated." : "The person could not be added.");
  };
  const setActive = async (id: string, active: boolean) => {
    const validId = validateUuid(id, "Select a valid recipient.");
    if (!validId.ok) throw new Error(validId.error);
    await mutate(createClient().rpc("set_christmas_recipient_active", { p_christmas_recipient_id: validId.value, p_active: active }), active ? "The person could not be restored." : "The person could not be removed.");
  };
  const archive = async (id: string) => setActive(id, false);
  const restore = async (id: string) => setActive(id, true);
  const setIdeaCount = useCallback((id: string, count: number) => setPeople((current) => current.map((person) => person.id === id ? { ...person, ideaCount: count } : person)), []);
  const setPurchaseMetrics = useCallback((id: string, spentPennies: number, count: number) => setPeople((current) => current.map((person) => person.id === id ? { ...person, spentPennies, giftCount: count } : person)), []);
  return <Context.Provider value={{ eventId, event, people, loading, error, role, isAdmin: role === "admin", saveRecipient, addExistingPerson, archive, restore, setIdeaCount, setPurchaseMetrics, refresh: load }}>{children}</Context.Provider>;
}

export function useFamily() { const value = useContext(Context); if (!value) throw new Error("FamilyProvider missing"); return value; }

/**
 * How many people the current event is for, or `null` while that is not known.
 *
 * The count of ACTIVE recipients is what decides the shape of an event's
 * navigation, and it has to mean the same thing everywhere or the tab bar and
 * the screen it opens would disagree. So it is derived once, here, from the
 * same `people` the rest of the app reads.
 *
 * `null` for "not inside an event", "still loading" and "the load failed" --
 * all three of which would otherwise look like zero recipients and hide screens
 * from an event that has plenty.
 */
export function useActiveRecipientCount(): number | null {
  const { eventId, people, loading, error } = useFamily();
  return useMemo(() => {
    if (!eventId || loading || error) return null;
    return people.filter((person) => person.active).length;
  }, [eventId, error, loading, people]);
}
export function useTotals() { const { people } = useFamily(); return useMemo(() => { const active = people.filter((person) => person.active); const budgetPennies = active.reduce((sum, person) => sum + person.budgetPennies, 0); const spentPennies = active.some((person) => person.spentPennies === null) ? null : active.reduce((sum, person) => sum + (person.spentPennies ?? 0), 0); return { active, budgetPennies, spentPennies, remainingPennies: spentPennies === null ? null : budgetPennies - spentPennies }; }, [people]); }
