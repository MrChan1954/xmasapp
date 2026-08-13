import { NextResponse } from "next/server";
import {
  markNotificationsRead,
  NotificationError,
  readInbox,
} from "@/utils/supabase/notifications-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * The Notification Centre.
 *
 * GET   the signed-in member's recent notifications and unread count
 * POST  mark one read (`{ id }`), or all of them (`{ all: true }`)
 *
 * Both are scoped by the caller's own session, and the table's RLS policies do
 * the actual restricting — there is no member id in either request, so there is
 * nothing to tamper with. Marking read is further narrowed by a trigger that
 * permits only `read_at` to change.
 */
export async function GET() {
  return handle(async () => NextResponse.json(await readInbox(), { headers: noStoreHeaders }));
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await request.json().catch(() => ({}));
    const all = (body as { all?: unknown }).all === true;
    const id = (body as { id?: unknown }).id;

    if (!all && typeof id !== "string") {
      return NextResponse.json(
        { error: "A notification is required." },
        { status: 400, headers: noStoreHeaders },
      );
    }

    return NextResponse.json(
      await markNotificationsRead(all ? null : (id as string)),
      { headers: noStoreHeaders },
    );
  });
}

async function handle(run: () => Promise<NextResponse>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    }
    console.error("[notifications] inbox request failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Your notifications could not be loaded." },
      { status: 500, headers: noStoreHeaders },
    );
  }
}
