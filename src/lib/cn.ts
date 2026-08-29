import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The shadcn class merger.
 *
 * Unlike `cx` (src/app/components/cx.ts) this DOES resolve Tailwind conflicts —
 * a later `bg-*` reliably beats an earlier one. That is what lets a registry
 * primitive publish a default look and still accept a `className` override, and
 * it is why every file under `src/app/components/ui/` uses `cn` rather than `cx`.
 *
 * `cx` is kept for the product layer, where the rule is the opposite: variation
 * is expressed through explicit props and a passed `className` is layout only.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
