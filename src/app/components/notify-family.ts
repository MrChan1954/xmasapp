"use client";

/**
 * Tell the server that a completed action is worth notifying the family about.
 *
 * Call this AFTER the Supabase write has succeeded, never instead of it. The
 * database remains the source of truth and Realtime still updates every open
 * screen; this only adds an alert for the people who do not have the app open.
 *
 * Deliberately fire-and-forget:
 *
 *  - It never blocks the UI. The purchase is saved; making someone wait on a
 *    push fan-out to see that would be strictly worse.
 *  - It never surfaces an error. "Your purchase saved but we could not notify
 *    anyone" is noise the user cannot act on, and the failure is already
 *    visible where it matters — nobody's phone buzzed.
 *  - It is safe to call twice. The server records each event once, so a retry
 *    or a double-tapped Save cannot produce a second notification.
 *
 * The body carries only a kind and the id of the row just written. It cannot
 * name recipients or supply text: the server derives both, having first checked
 * that this member really is the one who made the change.
 */
export type NotifiableEvent = "purchase" | "payment" | "gift_idea" | "gift_status";

export function notifyFamily(kind: NotifiableEvent, id: string): void {
  void fetch("/api/notifications/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    // `keepalive` so the request survives the navigation that often follows a
    // save — the purchase form returns to the person's page immediately.
    keepalive: true,
    body: JSON.stringify({ kind, id }),
  }).catch(() => {});
}
