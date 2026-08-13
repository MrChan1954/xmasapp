import { NextResponse } from "next/server";
import { describePushStatus } from "@/lib/notification-log";
import { NotificationError, sendTestNotification } from "@/utils/supabase/notifications-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * Send a real Web Push notification to the signed-in member's own devices.
 *
 * This is NOT a general-purpose send endpoint, and deliberately takes no body
 * at all. The recipient is the authenticated member; the text is fixed on the
 * server. There is no parameter through which a caller could name someone else
 * or supply their own wording, which is what keeps "let me check this works"
 * from also being "let me push whatever I like to the family".
 *
 * It exists because every other notification excludes the person who triggered
 * it. That is correct, but it means a single person testing alone can never
 * make one appear — which is exactly how a working transport looked broken.
 */
export async function POST() {
  try {
    const result = await sendTestNotification();

    // The push service's real HTTP status decides the message. Reporting
    // success regardless is what hid the original problem.
    const accepted = result.delivered > 0;
    return NextResponse.json({
      ...result,
      ok: accepted,
      message: accepted
        ? result.delivered === 1
          ? "Sent. It should appear on this device within a few seconds."
          : `Sent to ${result.delivered} of your devices.`
        : describePushStatus(result.statuses[0] ?? 0),
    }, { headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof NotificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    }
    console.error("[notifications] test send failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "The test notification could not be sent." },
      { status: 500, headers: noStoreHeaders },
    );
  }
}
