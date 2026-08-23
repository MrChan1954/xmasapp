import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET() {
  const db = await createClient();
  const auth = await db.auth.getUser();
  if (auth.error || !auth.data.user) {
    return NextResponse.json({ error: "You must sign in to run this check." }, { status: 401, headers: noStoreHeaders });
  }
  const membership = await db.from("app_members").select("id").eq("user_id", auth.data.user.id).eq("active", true).maybeSingle();
  if (membership.error || !membership.data) {
    return NextResponse.json({ error: "Your active family membership could not be verified." }, { status: 403, headers: noStoreHeaders });
  }

  try {
    const query = await db.from("events").select("id").limit(1);
    if (query.error) {
      console.error("[supabase-health] database check failed", { code: query.error.code });
      return NextResponse.json({ configured: true, reachable: false }, { status: 502, headers: noStoreHeaders });
    }
    return NextResponse.json({ configured: true, reachable: true, hasEvent: (query.data ?? []).length > 0 }, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[supabase-health] unexpected check failure", { type: error instanceof Error ? error.name : "UnknownError" });
    return NextResponse.json({ configured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL), reachable: false }, { status: 502, headers: noStoreHeaders });
  }
}
