"use client";

/**
 * Tell the server that a completed action is worth notifying the family about.
 *
 * Call this AFTER the Supabase write has succeeded, never instead of it. The
 * database remains the source of truth and Realtime still updates every open
 * screen; this only adds an alert for the people who do not have the app open.
 *
 * THIS IS AN OPTIMISATION, NOT THE MECHANISM.
 *
 * A database trigger writes the same event into `notification_outbox` inside
 * the very transaction that saved the purchase, gift idea or payment, so the
 * family gets told whether or not this request is ever made, ever arrives, or
 * ever completes. What this call buys is latency: it delivers immediately
 * instead of waiting for the next time anybody's app asks for their inbox.
 *
 * That is why it can still be fire-and-forget:
 *
 *  - It never blocks the UI. The purchase is saved; making someone wait on a
 *    push fan-out to see that would be strictly worse.
 *  - It never surfaces an error. "Your purchase saved but we could not notify
 *    anyone" is noise the user cannot act on.
 *  - Losing it costs nothing but a few seconds, because the outbox is the
 *    thing that guarantees delivery.
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
  })
    .then(async (response) => {
      // Still never surfaced to the user — the save already succeeded and a
      // notification failure is not theirs to act on. But it is no longer
      // thrown away: swallowing this completely is precisely why a pipeline
      // that reached nobody looked identical to one that was working, for as
      // long as it did. A developer with the console open can now see the
      // whole fan-out in one line.
      if (!response.ok) {
        console.warn("[notifications] dispatch rejected", { kind, status: response.status });
        return;
      }
      const report = await response.json().catch(() => ({}));
      console.info("[notifications] dispatch", {
        kind,
        outcome: report.outcome ?? null,
        audience: report.audience ?? 0,
        preferencesAllowed: report.preferencesAllowed ?? 0,
        subscribedRecipients: report.subscribedRecipients ?? 0,
        inAppCreated: report.inAppCreated ?? 0,
        delivered: report.delivered ?? 0,
        failed: report.failed ?? 0,
      });
    })
    .catch((error: unknown) => {
      // The outbox still has this event, so a failure here delays delivery
      // rather than losing it.
      console.warn("[notifications] dispatch failed", {
        kind,
        type: error instanceof Error ? error.name : "UnknownError",
      });
    });
}
