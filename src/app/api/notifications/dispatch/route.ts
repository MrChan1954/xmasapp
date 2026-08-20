import { NextResponse } from "next/server";
import {
  dispatchNotificationEvent,
  NotificationError,
  type NotificationEventKind,
} from "@/utils/supabase/notifications-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const KINDS: NotificationEventKind[] = ["purchase", "payment", "gift_idea", "gift_status", "payment_review"];

/**
 * "Something I just did is worth telling the family about."
 *
 * The body is deliberately as small as it can be: a kind, and the id of the row
 * that was written. It carries no recipients, no message text and no amounts,
 * because a caller must not be able to choose any of those. The server re-reads
 * the row through the caller's own session, confirms the caller is the person
 * recorded as having acted on it, confirms it happened moments ago, and only
 * then works out an audience and wording from authoritative data.
 *
 * So the worst a signed-in member can do with this endpoint is ask for the
 * notification their own action had already earned — which is idempotent, since
 * `notification_events` lets each event send exactly once.
 *
 * Called after the write succeeds, never instead of it. Supabase remains the
 * source of truth and Realtime still drives every open screen; this only adds
 * the alert for people who do not have the app open.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const kind = (body as { kind?: unknown }).kind;
    const id = (body as { id?: unknown }).id;

    if (typeof kind !== "string" || !KINDS.includes(kind as NotificationEventKind)) {
      return NextResponse.json({ error: "Unknown notification type." }, { status: 400, headers: noStoreHeaders });
    }
    if (typeof id !== "string") {
      return NextResponse.json({ error: "A valid record is required." }, { status: 400, headers: noStoreHeaders });
    }

    const report = await dispatchNotificationEvent(kind as NotificationEventKind, id);

    // The report is the whole point of this response. A dispatch that reached
    // nobody used to be indistinguishable from one that reached everybody —
    // both returned 200 and a number nothing read. Every field here is a count
    // or a first name: no endpoint, no key, no notification text, no row id.
    return NextResponse.json({
      ...report,
      // Kept for callers written against the previous shape.
      sent: report.delivered,
      ok: report.delivered > 0 || report.inAppCreated > 0 || report.outcome === "already-delivered",
    }, { headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof NotificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    }
    console.error("[notifications] dispatch failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "The family could not be notified." },
      { status: 500, headers: noStoreHeaders },
    );
  }
}
