import "server-only";

import type { NextResponse } from "next/server";
import { AREA_COOKIE } from "@/lib/areas";

/**
 * WRITING DOWN WHICH FAMILY THE BROWSER IS LOOKING AT -- in one place.
 *
 * Two routes remember an Area: `/api/areas` on switching and on creating, and
 * `/api/areas/membership` on leaving one, which has to MOVE the choice to a
 * family the person still belongs to rather than delete it. Written twice, the
 * two copies would drift -- and a `maxAge` or a `path` that disagreed between
 * them would expire somebody's choice early and sign a multi-family login out,
 * which is the exact failure this checkpoint exists to remove.
 *
 * NOT `httpOnly`, on purpose: the switcher reads it in the browser to show
 * which family is selected, and it grants nothing. `claim_active_area`
 * (migration 038) checks the membership table before it believes the header
 * this cookie becomes, so a forged or stale value is IGNORED, never obeyed.
 */
const YEAR = 60 * 60 * 24 * 365;

export function rememberArea(response: NextResponse, areaId: string) {
  response.cookies.set(AREA_COOKIE, areaId, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: YEAR,
  });
  return response;
}

/**
 * Forget it entirely. ONE CALLER, ONE CASE: somebody who has just left their
 * last family and belongs to none. Any other use is the bug from Q2 -- a
 * cleared cookie is indistinguishable from "never chose", and an account in
 * two families that has not chosen cannot resolve a membership at all.
 */
export function forgetArea(response: NextResponse) {
  response.cookies.delete(AREA_COOKIE);
  return response;
}
