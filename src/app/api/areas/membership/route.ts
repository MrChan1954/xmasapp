import { NextResponse } from "next/server";
import { AREA_COOKIE } from "@/lib/areas";
import { isSameOrigin } from "@/utils/request-origin";
import { createClient } from "@/utils/supabase/server";

/**
 * The three things somebody can do to their own place in a family.
 *
 * HAND OVER  give administration to another of this family's members
 * LEAVE      give up your own access to this family
 * ARCHIVE    put this family away
 *
 * NO SERVICE ROLE ANYWHERE IN HERE, deliberately.
 *
 * Every other privileged route in this application has to borrow the service
 * role, because creating an Auth account is something only the service role can
 * do. None of these three needs that: each is a database routine that
 * authorises the caller from the membership table itself. So this route holds
 * the caller's own session, and the answer to "may they?" is given by Postgres,
 * to a caller Postgres can see. There is no bypass here to get wrong.
 *
 * WHAT THIS ROUTE IS THEREFORE RESPONSIBLE FOR: almost nothing. It checks the
 * request came from this origin, forwards one of three named actions, and turns
 * a Postgres error code into a sentence. It cannot widen anything, because it
 * has nothing to widen with.
 */

type Action = "transfer-admin" | "leave" | "archive" | "unarchive";

const ACTIONS: readonly Action[] = ["transfer-admin", "leave", "archive", "unarchive"];

/** A refusal from the database, said the way a person would say it. */
function refusal(code: string | undefined, message: string | undefined): { status: number; error: string } {
  // 42501 is every authorization refusal these routines raise, and each one
  // already carries a sentence written for the person reading it.
  if (code === "42501") return { status: 403, error: message ?? "You cannot do that." };
  if (code === "23505") return { status: 409, error: message ?? "That has already happened." };
  if (code === "23514") return { status: 409, error: message ?? "That would leave the family in a state it cannot be in." };
  return { status: 502, error: "That could not be completed just now." };
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "This request origin is not allowed." }, { status: 403 });
  }

  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "You must sign in to continue." }, { status: 401 });

  let body: { action?: unknown; areaId?: unknown; memberId?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }

  const action = ACTIONS.find((candidate) => candidate === body.action);
  const areaId = typeof body.areaId === "string" ? body.areaId : null;
  if (!action || !areaId) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  if (action === "transfer-admin") {
    const memberId = typeof body.memberId === "string" ? body.memberId : null;
    if (!memberId) return NextResponse.json({ error: "Choose who takes over." }, { status: 400 });

    const { error } = await db.rpc("transfer_area_admin", {
      p_area_id: areaId,
      p_new_admin_member_id: memberId,
    });
    if (error) {
      const said = refusal(error.code, error.message);
      return NextResponse.json({ error: said.error }, { status: said.status });
    }
    return NextResponse.json({ ok: true, message: "They run this family now. You are still a member of it." });
  }

  if (action === "leave") {
    const { error } = await db.rpc("leave_area", { p_area_id: areaId });
    if (error) {
      const said = refusal(error.code, error.message);
      return NextResponse.json({ error: said.error }, { status: said.status });
    }

    /**
     * The cookie is cleared because it now names a family this login can no
     * longer read, and a remembered choice that resolves to nothing produces an
     * empty screen with no explanation. It is a preference, not a permission --
     * the database had already stopped answering for that Area before this line
     * ran.
     */
    const response = NextResponse.json({ ok: true, message: "You have left that family." });
    response.cookies.delete(AREA_COOKIE);
    return response;
  }

  const { error } = await db.rpc("set_area_archived", {
    p_area_id: areaId,
    p_archived: action === "archive",
  });
  if (error) {
    const said = refusal(error.code, error.message);
    return NextResponse.json({ error: said.error }, { status: said.status });
  }
  return NextResponse.json({
    ok: true,
    message: action === "archive"
      ? "That family has been put away. Nothing in it was deleted."
      : "That family is active again.",
  });
}
