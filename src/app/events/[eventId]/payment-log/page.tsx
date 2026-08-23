import { requireEvent } from "@/utils/supabase/events-server";
import { PaymentLogScreen } from "../../../payment-log/payment-log-screen";

export const dynamic = "force-dynamic";

export default async function EventPaymentLogPage({ params }: PageProps<"/events/[eventId]/payment-log">) {
  const { eventId } = await params;
  const event = await requireEvent(eventId);
  return <PaymentLogScreen eventId={event.id} eventName={event.name} />;
}
