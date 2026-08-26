import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { requireFamilyAccessAdmin } from "@/utils/supabase/family-access-admin";
import { FamilyAccessClient } from "./family-access-client";

export default async function FamilyAccessPage() {
  try {
    await requireFamilyAccessAdmin();
  } catch {
    /*
     * NOT "/more". That is a legacy redirect INTO an event, so somebody who is
     * not this family's admin was bounced off a family screen and into
     * Christmas. Family Access is a FAMILY setting; the way back from it is
     * that family's settings.
     */
    redirect("/settings/family");
  }

  return (
    <AppShell>
      <FamilyAccessClient />
    </AppShell>
  );
}
