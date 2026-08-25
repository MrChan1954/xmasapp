/*
 * NO "use client" DIRECTIVE, deliberately, and for the same reason
 * `utils/supabase/client.ts` has none: a module marked "use client" turns every
 * one of its exports into a client reference, and a server module that CALLS
 * one throws at render. This is browser code by virtue of reading
 * `document.cookie`, and it guards that read rather than announcing itself.
 */
import { AREA_COOKIE } from "@/lib/areas";
import { createClient } from "./client";

/**
 * THE CALLER'S MEMBERSHIP IN THE FAMILY ON SCREEN -- IN THE BROWSER.
 *
 * The mirror of `current-member.ts`, which does the same thing on the server and
 * cannot be imported here: it reads `next/headers`.
 *
 * WHY THIS IS NOT `.maybeSingle()`. Before Areas one login meant one membership
 * and `maybeSingle()` said so. A login may now hold one in each family, with a
 * different person, contributor and role in each, so that query returns two rows
 * and `maybeSingle()` turns a perfectly ordinary account into an ERROR -- which
 * every caller reads as "not a member" and fails closed on. A member of two
 * families would silently lose the purchase form, their notification
 * preferences and their admin controls.
 *
 * NOTHING HERE IS A PERMISSION. The list is read through the caller's own
 * session, so row level security has already narrowed it to their own rows; the
 * cookie only chooses among them. A cookie naming a family they are not in
 * matches nothing and they get none, which is what every caller already treats
 * as "not permitted".
 */
export type ClientMember = {
  id: string;
  person_id: string | null;
  contributor_id: string | null;
  role: string;
  active: boolean;
  area_id: string | null;
};

/** The Area the browser last chose, straight from the cookie it is kept in. */
export function rememberedAreaId(): string | null {
  if (typeof document === "undefined") return null;
  const found = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${AREA_COOKIE}=`));
  return found ? decodeURIComponent(found.slice(AREA_COOKIE.length + 1)) : null;
}

export async function getCurrentMemberClient(): Promise<ClientMember | null> {
  const db = createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;

  const { data } = await db
    .from("app_members")
    .select("id,person_id,contributor_id,role,active,area_id")
    .eq("user_id", auth.user.id)
    .eq("active", true);

  const rows = (data ?? []) as ClientMember[];
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  const remembered = rememberedAreaId();
  const chosen = remembered ? rows.find((row) => row.area_id === remembered) : undefined;
  return chosen ?? null;
}
