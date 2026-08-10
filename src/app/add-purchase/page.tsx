"use client";

import { Suspense } from "react";
import { AppNav } from "../components/app-nav";
import { PurchaseForm } from "./purchase-form";

export default function AddPurchasePage() {
  return (
    <main className="flex min-h-screen bg-[#f7f6f1] text-[#1d2926]">
      <AppNav />
      <div className="min-w-0 flex-1 pb-28 lg:pb-10">
        <Suspense fallback={<div className="mx-auto max-w-6xl px-5 py-10 text-sm font-semibold text-[#7b8581]">Loading purchase form...</div>}>
          <PurchaseForm />
        </Suspense>
      </div>
    </main>
  );
}
