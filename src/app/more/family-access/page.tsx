import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { requireFamilyAccessAdmin } from "@/utils/supabase/family-access-admin";
import { FamilyAccessClient } from "./family-access-client";

export default async function FamilyAccessPage() {
  try {
    await requireFamilyAccessAdmin();
  } catch {
    redirect("/more");
  }

  return (
    <AppShell>
      <FamilyAccessClient />
    </AppShell>
  );
}
