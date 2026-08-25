import { loadAreaContext } from "@/utils/supabase/areas-server";
import { CreateAreaForm } from "./create-area-form";

export const dynamic = "force-dynamic";

/**
 * Starting a family. Reached automatically by an account that has none, and
 * deliberately by one that wants a second.
 */
export default async function NewAreaPage() {
  const { needsSetup } = await loadAreaContext();
  return <CreateAreaForm first={needsSetup} />;
}
