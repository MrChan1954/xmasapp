import { redirect } from "next/navigation";
import { getCurrentMember } from "@/utils/supabase/current-member";
import { AppShell } from "../../components/app-shell";
import { FamilyAccessClient } from "./family-access-client";

/**
 * WHY THIS NO LONGER CALLS `requireFamilyAccessAdmin`.
 *
 * That helper builds a SERVICE-ROLE client as part of answering, because the
 * three actions it guards need the Supabase Admin API. Rendering a page needs
 * none of that, and asking for the most privileged client in the application in
 * order to decide whether to draw a heading is a privilege taken for no
 * capability -- it would also make this screen answer 503 on a server with no
 * secret key configured, for a screen that has stopped depending on one.
 *
 * The membership in the family on screen is the whole question, and
 * `getCurrentMember` reads it through the caller's OWN session: row level
 * security has already narrowed it to their rows, and since migration 052 that
 * policy also requires global approval, so a rejected or suspended account
 * resolves no membership and is bounced here too.
 *
 * NONE OF THIS IS THE BOUNDARY. `list_area_access()` asks
 * `is_area_admin(acting_area())` for itself and raises 42501, and the client
 * renders the "family admin only" refusal from that. This decides what is
 * rendered; the database decides what may be read.
 */
export default async function FamilyAccessPage() {
  const { user, member } = await getCurrentMember();

  if (!user) redirect("/login");

  if (!member || !member.active || member.role !== "admin") {
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
