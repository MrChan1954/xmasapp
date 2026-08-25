import { cookies } from "next/headers";
import { AREA_COOKIE, areaFromRow, needsFirstArea, resolveActiveArea, type Area } from "@/lib/areas";
import { createClient } from "./server";

export type AreaContext = {
  /** Every family this account belongs to. Empty for somebody brand new. */
  areas: Area[];
  /** The one being looked at, or null when there is nothing to look at. */
  active: Area | null;
  /** True when this account has no family yet and should be offered one. */
  needsSetup: boolean;
};

/**
 * WHICH FAMILIES THIS ACCOUNT BELONGS TO, AND WHICH ONE IT IS LOOKING AT.
 *
 * An ORDINARY read. `areas` is behind row level security with one policy --
 * `is_area_member(id)` -- so this query returns the caller's own families and
 * cannot be made to return anyone else's. There is no service-role client here
 * and no bypass: the list a person sees is the list the database says is theirs.
 *
 * A SIGNED-OUT CALLER GETS AN EMPTY CONTEXT, not an error. Callers render the
 * signed-out experience from that rather than from a thrown exception.
 */
export async function loadAreaContext(): Promise<AreaContext> {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { areas: [], active: null, needsSetup: false };

  const { data, error } = await db.from("areas").select("id,name,archived_at");
  if (error || !data) return { areas: [], active: null, needsSetup: false };

  const areas = data.map(areaFromRow);
  const store = await cookies();
  const remembered = store.get(AREA_COOKIE)?.value ?? null;

  return {
    areas,
    active: resolveActiveArea(areas, remembered),
    needsSetup: needsFirstArea(areas),
  };
}

/**
 * The Area the browser last chose, straight from the cookie.
 *
 * DELIBERATELY UNVALIDATED, and safe because of where it goes: it is sent to
 * PostgREST as `x-area-id`, and `claim_active_area` ignores any Area the caller
 * is not really a member of. Validating it here as well would mean a second
 * round trip on every request to re-learn what the database checks anyway.
 */
export async function rememberedAreaId(): Promise<string | null> {
  const store = await cookies();
  return store.get(AREA_COOKIE)?.value ?? null;
}
