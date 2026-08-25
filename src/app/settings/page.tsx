// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { areaLabel } from "@/lib/areas.ts";
import { loadAreaContext } from "@/utils/supabase/areas-server";
import { GlobalSettingsScreen } from "./settings-screen";

export const dynamic = "force-dynamic";

/** The GLOBAL scope. See `src/lib/settings-scopes.ts` for why there are three. */
export default async function SettingsPage() {
  const { active } = await loadAreaContext();
  return <GlobalSettingsScreen areaName={areaLabel(active)} />;
}
