import { Suspense } from "react";
import { requireEvent } from "@/utils/supabase/events-server";
import { AppShell } from "../../../components/app-shell";
import { PurchaseForm } from "../../../add-purchase/purchase-form";

export const dynamic = "force-dynamic";

export default async function EventAddPurchasePage({ params }: PageProps<"/events/[eventId]/add-purchase">) {
  const { eventId } = await params;
  const event = await requireEvent(eventId);
  return (
    <AppShell>
      <Suspense fallback={<p className="py-6 text-sm font-medium text-ink-600">Loading purchase form...</p>}>
        <PurchaseForm eventId={event.id} />
      </Suspense>
    </AppShell>
  );
}
