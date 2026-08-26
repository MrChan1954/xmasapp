import { NextResponse } from "next/server";
import { validateAreaName } from "@/lib/areas";
import { rememberArea } from "@/utils/area-cookie";
import { isSameOrigin } from "@/utils/request-origin";
import { createClient } from "@/utils/supabase/server";

/**
 * Choosing a family, and creating one.
 *
 * NEITHER OF THESE IS THE PERMISSION CHECK. Switching writes a cookie, and a
 * cookie naming a family you are not in is ignored by the database on the next
 * request -- `claim_active_area` checks the membership table before it believes
 * the header the cookie becomes. Creating calls `create_area`, which makes the
 * Area, the person and the administrator in one transaction and cannot reach any
 * existing family.
 *
 * The route exists because a Server Component cannot write a cookie. The work is
 * trivial and the authority is entirely in Postgres.
 */

export async function PUT(request: Request) {
  // Switching grants nothing, but it does change what the person sees next, and
  // creating makes a real family. Neither should be startable from a page that
  // is not ours.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "This request origin is not allowed." }, { status: 403 });
  }

  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { areaId?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }
  const areaId = typeof body.areaId === "string" ? body.areaId : null;
  if (!areaId) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  // Confirmed against the caller's OWN readable list, so the cookie is never
  // left pointing at a family they cannot see. The database would ignore it
  // either way; this keeps the answer honest about what happened.
  const { data } = await db.from("areas").select("id").eq("id", areaId).maybeSingle();
  if (!data) return NextResponse.json({ error: "That family is not yours" }, { status: 403 });

  return rememberArea(NextResponse.json({ ok: true }), areaId);
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "This request origin is not allowed." }, { status: 403 });
  }

  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { name?: unknown; personName?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }

  const name = validateAreaName(typeof body.name === "string" ? body.name : "");
  if (!name.ok) return NextResponse.json({ error: name.reason }, { status: 400 });
  const personName = validateAreaName(typeof body.personName === "string" ? body.personName : "");
  if (!personName.ok) {
    return NextResponse.json({ error: "Tell us your name so the family knows who you are." }, { status: 400 });
  }

  const { data, error } = await db.rpc("create_area", {
    p_name: name.value,
    p_person_name: personName.value,
  });
  if (error || !data) return NextResponse.json({ error: "We could not create that family." }, { status: 400 });

  return rememberArea(NextResponse.json({ ok: true, areaId: String(data) }), String(data));
}
