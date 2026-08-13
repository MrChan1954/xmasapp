import { NextResponse } from "next/server";
import {
  NotificationError,
  readVapidPublicKey,
  requireNotificationMember,
} from "@/utils/supabase/notifications-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * The VAPID public key, which `PushManager.subscribe` needs.
 *
 * This key is public by design — it is what a push service uses to verify that
 * a message really came from this server, and it is transmitted in the clear on
 * every send. Serving it from a route rather than baking it in as a
 * `NEXT_PUBLIC_` build variable keeps it a runtime value, so rotating the pair
 * is a secret update rather than a rebuild and redeploy.
 *
 * Behind an authentication check anyway: only signed-in family members ever
 * need it, and there is no reason to publish this app's key to crawlers. The
 * private half is never read here and never leaves the server.
 */
export async function GET() {
  try {
    await requireNotificationMember();
    return NextResponse.json({ publicKey: readVapidPublicKey() }, { headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof NotificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    }
    console.error("[notifications] key lookup failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Notifications are not available right now." },
      { status: 500, headers: noStoreHeaders },
    );
  }
}
