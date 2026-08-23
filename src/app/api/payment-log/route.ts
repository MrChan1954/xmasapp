import { NextResponse } from "next/server";
import { loadPaymentLog, PaymentLogServerError } from "@/utils/supabase/payment-log-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: Request) {
  try {
    // The event is named by the caller and validated server-side; there is no
    // default, so this route cannot quietly answer for the wrong event.
    const eventId = new URL(request.url).searchParams.get("event") ?? "";
    return NextResponse.json(await loadPaymentLog(eventId), { headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof PaymentLogServerError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    }
    console.error("[payment-log] unexpected server error", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Payment Log could not be loaded." }, { status: 500, headers: noStoreHeaders });
  }
}
