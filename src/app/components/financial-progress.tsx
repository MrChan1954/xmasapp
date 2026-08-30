import { formatPennies } from "@/lib/currency";
import { calculateFinancialProgress, type PurchaseProgressStatus } from "@/lib/purchases";
import type { BadgeTone } from "./ui";

/**
 * How a budget position reads on a person: the badge word and the badge colour.
 *
 * The people screen and the person modal each carried their own copy of this,
 * character for character, so Q18 gave it the one home that already owns how
 * budget progress is presented -- the same module as the bar those badges sit
 * beside, whose "Budget reached" wording this matches on purpose.
 *
 * `events-dashboard.tsx` deliberately does NOT use this. An event card is
 * summarising a whole occasion rather than one person, so it says "Complete"
 * where this says "Budget reached", and it tones an overspend `warning` rather
 * than `danger` because one recipient over budget is not a failed Christmas.
 * Two of its four states differ from these, in the word AND in the colour, so
 * it is a second presentation of the same status -- not a second copy of this.
 */
export function progressPresentation(status: PurchaseProgressStatus): { label: string; tone: BadgeTone } {
  if (status === "not_started") return { label: "Not started", tone: "neutral" };
  if (status === "in_progress") return { label: "In progress", tone: "warning" };
  if (status === "over_budget") return { label: "Over budget", tone: "danger" };
  return { label: "Budget reached", tone: "success" };
}

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
