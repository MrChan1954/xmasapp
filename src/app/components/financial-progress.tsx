import { formatPennies } from "@/lib/currency";
import { calculateFinancialProgress } from "@/lib/purchases";

export function FinancialProgressBar({
  actualPennies,
  plannedPennies,
  mode,
  showDifference = true,
}: {
  actualPennies: number;
  plannedPennies: number;
  mode: "budget" | "plan";
  showDifference?: boolean;
}) {
  const progress = calculateFinancialProgress(actualPennies, plannedPennies);
  const displayedPercentage = progress.percentage === null
    ? null
    : new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(progress.percentage);
  const percentageLabel = displayedPercentage === null
    ? mode === "budget" ? "Over budget" : "Over plan"
    : mode === "budget" ? `${displayedPercentage}% spent` : `${displayedPercentage}% of plan`;
  const differenceLabel = progress.state === "over_budget"
    ? `${formatPennies(progress.overPennies)} over ${mode}`
    : progress.state === "budget_reached"
      ? mode === "budget" ? "Budget reached" : "Plan reached"
      : `${formatPennies(progress.remainingPennies)} remaining${mode === "plan" ? " to plan" : ""}`;
  const fillStyle = progress.state === "over_budget"
    ? "bg-[#c74f43]"
    : progress.state === "budget_reached"
      ? "bg-[#2f8069]"
      : "bg-[#d5a72c]";

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-3 text-xs font-semibold">
        <span className={progress.state === "over_budget" ? "text-[#a63f33]" : "text-[#5f6d68]"}>{percentageLabel}</span>
        {showDifference && <span className={progress.state === "over_budget" ? "text-[#a63f33]" : "text-[#5f6d68]"}>{differenceLabel}</span>}
      </div>
      <div
        className="mt-2 h-2.5 overflow-hidden rounded-full bg-[#ecece5]"
        role="progressbar"
        aria-label={`${percentageLabel}; ${differenceLabel}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, progress.percentage ?? 100)}
        aria-valuetext={`${percentageLabel}; ${differenceLabel}`}
      >
        <div className={`h-full rounded-full transition-all ${fillStyle}`} style={{ width: `${progress.fillPercentage}%` }} />
      </div>
    </div>
  );
}
