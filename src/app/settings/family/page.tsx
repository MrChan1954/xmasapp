// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { areaLabel } from "@/lib/areas.ts";
import { loadAreaContext } from "@/utils/supabase/areas-server";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { createClient } from "@/utils/supabase/server";
import { FamilySettingsScreen, type Successor } from "./family-settings-screen";

export const dynamic = "force-dynamic";

/**
 * The AREA scope. `isAdmin` is read from the membership in THIS family, not
 * from any global role -- somebody can administer one family and be an ordinary
 * member of another, and this screen has to say so correctly in each.
 */
export default async function FamilySettingsPage() {
  const [{ active, areas }, { member }] = await Promise.all([loadAreaContext(), getCurrentMember()]);

  const areaId = active?.id ?? null;
  const isAdmin = member?.role === "admin" && member?.area_id === areaId;

  return (
    <FamilySettingsScreen
      areaId={areaId}
      areaName={areaLabel(active)}
      isAdmin={isAdmin}
      archived={active?.archivedAt !== null && active?.archivedAt !== undefined}
      /**
       * Leaving is for people who are not running the place. The administrator
       * is shown the instruction instead, because migration 042 refuses them
       * and an offer that is going to be refused is worse than no offer.
       */
      canLeave={Boolean(member) && !isAdmin}
      /** True when there is somewhere else to go afterwards. */
      hasAnotherArea={areas.length > 1}
      successors={isAdmin && areaId ? await loadSuccessors(areaId, member?.id as string) : []}
    />
  );
}

/**
 * WHO COULD TAKE THIS FAMILY OVER.
 *
 * An ordinary read through the caller's own session: an administrator may read
 * their Area's memberships (migration 036's "admins read all memberships"
 * policy) and its people. There is no service role here and nothing to bypass --
 * if this reader were not the administrator, the membership query would come
 * back with only their own row and the list would be empty.
 *
 * Scoped to the Area on screen by hand as well, because an administrator of two
 * families would otherwise be offered the wrong family's members.
 *
 * ONLY ACTIVE MEMBERSHIPS WITH A PERSON. `transfer_area_admin` refuses anybody
 * else, so offering them would be offering a button that fails.
 */
async function loadSuccessors(areaId: string, currentMemberId: string): Promise<Successor[]> {
  const db = await createClient();

  const { data: memberships } = await db
    .from("app_members")
    .select("id,person_id,role,active,area_id")
    .eq("area_id", areaId)
    .eq("active", true);

  const eligible = (memberships ?? []).filter((row) =>
    row.id !== currentMemberId && row.person_id !== null);
  if (eligible.length === 0) return [];

  const { data: people } = await db
    .from("people")
    .select("id,name")
    .eq("area_id", areaId)
    .in("id", eligible.map((row) => row.person_id as string));

  const nameByPerson = new Map((people ?? []).map((row) => [row.id as string, row.name as string]));

  return eligible
    .flatMap((row) => {
      const name = nameByPerson.get(row.person_id as string);
      return name ? [{ memberId: row.id as string, name }] : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en-GB", { sensitivity: "base" }));
}
