// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { areaLabel } from "@/lib/areas.ts";
import { loadAreaContext } from "@/utils/supabase/areas-server";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { FamilySettingsScreen } from "./family-settings-screen";

export const dynamic = "force-dynamic";

/**
 * The AREA scope. `isAdmin` is read from the membership in THIS family, not
 * from any global role -- somebody can administer one family and be an ordinary
 * member of another, and this screen has to say so correctly in each.
 */
export default async function FamilySettingsPage() {
  const [{ active }, { member }] = await Promise.all([loadAreaContext(), getCurrentMember()]);
  return (
    <FamilySettingsScreen
      areaId={active?.id ?? null}
      areaName={areaLabel(active)}
      isAdmin={member?.role === "admin" && member?.area_id === active?.id}
    />
  );
}
