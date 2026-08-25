import { NextResponse } from "next/server";
import { validateAreaName } from "@/lib/areas";
import { isSameOrigin } from "@/utils/request-origin";
import { createClient } from "@/utils/supabase/server";

/**
 * Renaming one family.
 *
 * THE AUTHORISATION IS `set_area_name` ITSELF, which refuses anyone who is not
 * that Area's administrator. This route validates the shape of the name so the
 * person typing gets a sentence rather than a database error, and does nothing
 * else -- there is no check here that the RPC does not repeat.
 */
export async function PUT(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "This request origin is not allowed." }, { status: 403 });
  }

  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { areaId?: unknown; name?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }

  const areaId = typeof body.areaId === "string" ? body.areaId : null;
  if (!areaId) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const name = validateAreaName(typeof body.name === "string" ? body.name : "");
  if (!name.ok) return NextResponse.json({ error: name.reason }, { status: 400 });

  const { error } = await db.rpc("set_area_name", { p_area_id: areaId, p_name: name.value });
  if (error) {
    return NextResponse.json(
      { error: "Only this family's administrator can rename it." },
      { status: 403 },
    );
  }
  return NextResponse.json({ ok: true });
}
