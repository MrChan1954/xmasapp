import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { requireFamilyAccessAdmin } from "@/utils/supabase/family-access-admin";
import { ActivityClient } from "./activity-client";

/**
 * Same gate as Family Access: a server-side admin check that redirects rather
 * than rendering. The real protection is the RLS policy on `audit_log`, which
 * only `is_app_admin()` can read — this just avoids showing a signed-in
 * non-admin an empty page they should not have reached.
 */
export default async function ActivityPage() {
  try {
    await requireFamilyAccessAdmin();
  } catch {
    redirect("/more");
  }

  return (
    <AppShell>
      <ActivityClient />
    </AppShell>
  );
}
