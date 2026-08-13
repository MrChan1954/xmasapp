import { NextResponse } from "next/server";
import {
  NotificationError,
  readDeviceStatus,
  registerDevice,
  removeDevice,
} from "@/utils/supabase/notifications-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One browser's push registration.
 *
 * POST   register or refresh this device
 * DELETE forget this device
 * PUT    report whether this device is currently registered
 *
 * The membership every operation applies to comes from the signed-in session,
 * never from the body, so none of these can act on another member's devices.
 *
 * The status check is a PUT rather than a GET because it carries the push
 * endpoint, which identifies a specific browser install. A GET would put that
 * in a URL, where it reaches server logs and browser history; a body does not.
 */
const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return NextResponse.json(
      await registerDevice({
        endpoint: String(body.endpoint ?? ""),
        p256dh: String(body.p256dh ?? ""),
        auth: String(body.auth ?? ""),
        platform: typeof body.platform === "string" ? body.platform : undefined,
      }),
      { headers: noStoreHeaders },
    );
  });
}

export async function DELETE(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return NextResponse.json(
      await removeDevice(String(body.endpoint ?? "")),
      { headers: noStoreHeaders },
    );
  });
}

export async function PUT(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return NextResponse.json(
      await readDeviceStatus(typeof body.endpoint === "string" ? body.endpoint : null),
      { headers: noStoreHeaders },
    );
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function handle(run: () => Promise<NextResponse>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    }
    // Only the error's class name is logged. A push endpoint, a device key or a
    // VAPID key must never reach a log line, and a raw message could carry one.
    console.error("[notifications] unexpected server error", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Notification settings could not be updated." },
      { status: 500, headers: noStoreHeaders },
    );
  }
}
