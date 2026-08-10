import { redirect } from "next/navigation";
import { AppNav } from "../../components/app-nav";
import { requireFamilyAccessAdmin } from "@/utils/supabase/family-access-admin";
import { FamilyAccessClient } from "./family-access-client";

export default async function FamilyAccessPage() {
  try {
    await requireFamilyAccessAdmin();
  } catch {
    redirect("/more");
  }

  return (
    <main className="flex min-h-screen bg-[#f8f8f6] text-[#1d2926]">
      <AppNav />
      <div className="min-w-0 flex-1 pb-24 lg:pb-0">
        <FamilyAccessClient />
      </div>
    </main>
  );
}
