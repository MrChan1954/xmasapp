"use client";

import { Suspense } from "react";
import { AppShell } from "../components/app-shell";
import { PurchaseForm } from "./purchase-form";

export default function AddPurchasePage() {
  return (
    <AppShell>
      <Suspense fallback={<p className="py-6 text-sm font-medium text-ink-600">Loading purchase form...</p>}>
        <PurchaseForm />
      </Suspense>
    </AppShell>
  );
}
