import { AREA_COOKIE } from "@/lib/areas";
import { cookies } from "next/headers";
import { createClient } from "./server";

/**
 * The caller's membership -- IN THE FAMILY THEY ARE LOOKING AT.
 *
 * WHY THIS IS NO LONGER A SINGLE ROW BY DEFINITION. Before Areas, one login had
 * one membership and `maybeSingle()` said so. A login may now belong to two
 * families and hold a different membership -- a different person, a different
 * role -- in each, so asking without saying which family would either throw or
 * silently answer about the wrong one.
 *
 * So the remembered Area picks the row. With none remembered, or one that is no
 * longer theirs, the only membership they have is used; a login with two and no
 * choice made gets none, which every caller already treats as "not a member" and
 * fails closed on.
 */
export async function getCurrentMember() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { user: null, member: null };

  const { data: memberships } = await db
    .from("app_members")
    .select("id,email,person_id,contributor_id,role,active,area_id")
    .eq("user_id", user.id)
    .eq("active", true);

  const rows = memberships ?? [];
  if (rows.length === 0) return { user, member: null };
  if (rows.length === 1) return { user, member: rows[0] };

  const store = await cookies();
  const remembered = store.get(AREA_COOKIE)?.value ?? null;
  const chosen = remembered ? rows.find((row) => row.area_id === remembered) : undefined;
  return { user, member: chosen ?? null };
}
