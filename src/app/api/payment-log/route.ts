import { NextResponse } from "next/server";
import { loadPaymentLog, PaymentLogServerError } from "@/utils/supabase/payment-log-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET() {
  try {
    return NextResponse.json(await loadPaymentLog(), { headers: noStoreHeaders });
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
