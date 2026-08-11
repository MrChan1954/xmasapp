import { AppShell } from "../../components/app-shell";
import { ActivityClient } from "./activity-client";

/**
 * Open to every signed-in family member. There is no server-side role gate: the
 * RLS policy on `audit_log` admits any active member and nobody else, so the
 * database is the enforcement rather than this page.
 */
export default function ActivityPage() {
  return (
    <AppShell>
      <ActivityClient />
    </AppShell>
  );
}
