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
    ? "bg-berry"
    : progress.state === "budget_reached"
      ? "bg-success"
      : "bg-gold-fill";
  const labelStyle = progress.state === "over_budget" ? "text-berry" : "text-ink-600";

  return (
    <div className="mt-3">
      <div className={`flex items-center justify-between gap-3 text-xs font-medium ${labelStyle}`}>
        <span className="tabular-nums">{percentageLabel}</span>
        {showDifference && <span className="tabular-nums">{differenceLabel}</span>}
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-3"
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
