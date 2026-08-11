"use client";

import { Suspense } from "react";
<<<<<<< HEAD
import { AppNav } from "../components/app-nav";
=======
import { AppShell } from "../components/app-shell";
>>>>>>> 7534a2d (redesign and realtime)
import { PurchaseForm } from "./purchase-form";

export default function AddPurchasePage() {
  return (
<<<<<<< HEAD
    <main className="flex min-h-screen bg-[#f7f6f1] text-[#1d2926]">
      <AppNav />
      <div className="min-w-0 flex-1 pb-28 lg:pb-10">
        <Suspense fallback={<div className="mx-auto max-w-6xl px-5 py-10 text-sm font-semibold text-[#7b8581]">Loading purchase form...</div>}>
          <PurchaseForm />
        </Suspense>
      </div>
    </main>
=======
    <AppShell>
      <Suspense fallback={<p className="py-6 text-sm font-medium text-ink-600">Loading purchase form...</p>}>
        <PurchaseForm />
      </Suspense>
    </AppShell>
>>>>>>> 7534a2d (redesign and realtime)
  );
}
