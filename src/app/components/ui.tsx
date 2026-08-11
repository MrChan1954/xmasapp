"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { cx } from "./cx";
import { Ornament, type OrnamentName } from "./festive/ornaments";
import { IconClose } from "./icons";
import { useDialogBehaviour } from "./use-dialog";

export { cx } from "./cx";

/* ---------------------------------- Buttons --------------------------------- */

export type ButtonVariant = "primary" | "secondary" | "tonal" | "ghost" | "danger" | "dangerGhost" | "gold";
export type ButtonSize = "sm" | "md" | "lg";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-contrast shadow-card hover:bg-accent-hover active:bg-accent-active",
  secondary: "border border-line-strong bg-surface text-ink-900 shadow-card hover:border-accent/40 hover:bg-surface-2",
  tonal: "bg-accent-soft text-accent hover:brightness-95 dark:hover:brightness-125",
  ghost: "text-ink-600 hover:bg-hover-veil hover:text-ink-900",
  danger: "bg-berry-strong text-white shadow-card hover:brightness-110 active:brightness-95",
  dangerGhost: "text-berry hover:bg-berry-soft",
  gold: "bg-gold-fill text-gold-fill-contrast shadow-card hover:brightness-105 active:brightness-95",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "min-h-10 rounded-lg px-3.5 text-sm",
  md: "min-h-11 rounded-xl px-4 text-sm",
  lg: "min-h-12 rounded-xl px-5 text-sm sm:text-base",
};

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", className = "") {
  return cx(
    "inline-flex items-center justify-center gap-2 font-semibold transition active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50",
    buttonVariants[variant],
    buttonSizes[size],
    className,
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...rest} />;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className = "",
  href,
  children,
  ...rest
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string; href: string; children: ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return <Link href={href} className={buttonClasses(variant, size, className)} {...rest}>{children}</Link>;
}

/* ----------------------------------- Forms ----------------------------------- */

export const inputClasses = "h-12 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-base text-ink-900 shadow-card outline-none placeholder:text-ink-400 focus:border-accent/60 focus:ring-4 focus:ring-accent/20 disabled:bg-surface-3 disabled:text-ink-600";

export function Field({
  label,
  hint,
  required = false,
  error,
  className = "",
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  error?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="text-sm font-semibold text-ink-900">
        {label}
        {required && <span aria-hidden className="text-berry"> *</span>}
      </span>
      <span className="mt-2 block">{children}</span>
      {hint && <span className="mt-1.5 block text-xs leading-5 text-ink-600">{hint}</span>}
      {error && <span role="alert" className="mt-1.5 block text-xs font-semibold text-berry">{error}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return <input className={cx(inputClasses, className)} {...rest} />;
}

/**
 * The chevron is a real element rather than a background-image data-URI so it
 * can inherit a themed colour — `background-image` cannot reference currentColor.
 * The wrapper adds no box of its own, so a caller's margin/height classes on the
 * select still behave as before.
 */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  return (
    <span className="relative block">
      <select className={cx(inputClasses, "appearance-none pr-10", className)} {...rest} />
      <ChevronDown
        aria-hidden
        size={16}
        strokeWidth={2}
        className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-ink-600"
      />
    </span>
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return <textarea className={cx(inputClasses, "h-auto min-h-24 resize-y py-3 leading-6", className)} {...rest} />;
}

export function MoneyInput({
  value,
  onValueChange,
  className = "",
  compact = false,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className"> & {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cx(
      // `money-field` is what globals.css hangs the focus ring on — the bare
      // input inside would otherwise outline itself, starting after the £.
      "money-field flex items-center rounded-xl border border-line-strong bg-surface shadow-card focus-within:border-accent/60 focus-within:ring-4 focus-within:ring-accent/20",
      compact ? "h-11" : "h-12",
      className,
    )}>
      <span className={cx("select-none font-medium text-ink-600", compact ? "pl-3 text-sm" : "pl-3.5")}>£</span>
      <input
        inputMode="decimal"
        placeholder="0.00"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className={cx("h-full min-w-0 flex-1 rounded-xl bg-transparent px-2 text-base tabular-nums outline-none placeholder:text-ink-400", compact && "text-right")}
        {...rest}
      />
    </span>
  );
}

export function Segmented<Value extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  lockActive = false,
}: {
  options: ReadonlyArray<{ value: Value; label: string }>;
  value: Value;
  onChange: (value: Value) => void;
  ariaLabel: string;
  disabled?: boolean;
  lockActive?: boolean;
}) {
  return (
    <div className="grid grid-flow-col auto-cols-fr gap-1 rounded-xl border border-line bg-surface-3 p-1" role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={disabled || (lockActive && active)}
            onClick={() => onChange(option.value)}
            className={cx(
              // Selection reads as an accent tint rather than elevation: a
              // "raised" lighter pill inverts between the two themes, a tint
              // does not.
              "min-h-11 rounded-lg px-3 text-sm font-semibold transition disabled:cursor-default",
              active ? "bg-accent-soft text-accent ring-1 ring-accent-soft-border" : "text-ink-600 hover:text-ink-900",
              disabled && !active && "opacity-50",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------- Badges ----------------------------------- */

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "gold" | "pine";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "border-line bg-surface-3 text-ink-600",
  success: "border-success-border bg-success-soft text-success",
  warning: "border-warning-border bg-warning-soft text-warning",
  danger: "border-berry-soft-border bg-berry-soft text-berry",
  gold: "border-warning-border bg-gold-soft text-gold",
  pine: "border-pine-700 bg-pine-800 text-pine-100",
};

const badgeDots: Record<BadgeTone, string> = {
  neutral: "bg-ink-400",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-berry",
  gold: "bg-gold-fill",
  pine: "bg-gold-fill",
};

export function Badge({ tone = "neutral", dot = true, className = "", children }: { tone?: BadgeTone; dot?: boolean; className?: string; children: ReactNode }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold", badgeTones[tone], className)}>
      {dot && <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", badgeDots[tone])} />}
      {children}
    </span>
  );
}

/* ----------------------------------- Cards ------------------------------------ */

const cardTones = {
  surface: "border-line bg-surface shadow-card",
  sunken: "border-line bg-ground-sunken",
  // `dark` turns the plate into a theme island so everything nested inside it
  // resolves against the evergreen ground rather than the page ground.
  ink: "dark border-pine-700 bg-linear-to-br from-pine-900 to-pine-800 text-white shadow-card",
};

export function Card({
  as: Tag = "div",
  tone = "surface",
  padded = false,
  className = "",
  children,
}: {
  as?: "div" | "section" | "article";
  tone?: keyof typeof cardTones;
  padded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={cx("rounded-2xl border", cardTones[tone], padded && "p-5 sm:p-6", className)}>
      {children}
    </Tag>
  );
}

export function SectionCard({
  eyebrow,
  title,
  description,
  action,
  className = "",
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cx("rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow && <p className="text-xs font-semibold tracking-eyebrow text-gold uppercase">{eyebrow}</p>}
          <h2 className={cx("font-display text-xl font-semibold text-ink-900", eyebrow && "mt-1")}>{title}</h2>
          {description && <p className="mt-1 max-w-xl text-sm leading-6 text-ink-600">{description}</p>}
        </div>
        {action && <div className="w-full sm:w-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/* ---------------------------- Toolbars and chips ---------------------------- */

export function Toolbar({ start, end, className = "" }: { start?: ReactNode; end?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-wrap items-center justify-between gap-x-4 gap-y-3", className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{start}</div>
      {end && <div className="flex shrink-0 items-center gap-2">{end}</div>}
    </div>
  );
}

/** Horizontal scroller for filter chips: bleeds to the screen edge on mobile. */
export function ChipRow({ label, className = "", children }: { label?: string; className?: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cx("-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0", className)}
    >
      {children}
    </div>
  );
}

export function FilterChip({
  active,
  count,
  onClick,
  className = "",
  children,
}: {
  active: boolean;
  count?: number;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold whitespace-nowrap transition",
        active
          ? "border-accent-soft-border bg-accent-soft text-accent"
          : "border-line bg-surface text-ink-600 hover:border-line-strong hover:text-ink-900",
        className,
      )}
    >
      {children}
      {count !== undefined && (
        <span className={cx("text-xs font-semibold tabular-nums", active ? "text-accent/70" : "text-ink-400")}>{count}</span>
      )}
    </button>
  );
}

/* -------------------------------- Data display ------------------------------- */

export type Column<Row> = {
  key: string;
  header: string;
  align?: "left" | "right";
  width?: string;
  sortable?: boolean;
  cell: (row: Row) => ReactNode;
};

/**
 * Desktop table. Pair with `DataCards` over the same `Column[]` so the two
 * presentations can never drift apart.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  onRowActivate,
  empty,
  maxHeight = "65vh",
  className = "",
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  sort?: { key: string; direction: "asc" | "desc" };
  onSort?: (key: string) => void;
  onRowActivate?: (row: Row, element: HTMLElement) => void;
  empty?: ReactNode;
  maxHeight?: string;
  className?: string;
}) {
  if (rows.length === 0 && empty) return <div className={cx("hidden lg:block", className)}>{empty}</div>;

  return (
    <div
      className={cx("hidden overflow-auto rounded-2xl border border-line bg-surface shadow-card lg:block", className)}
      style={{ maxHeight }}
    >
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-line">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={cx(
                  "px-4 py-3 text-xs font-semibold tracking-eyebrow text-ink-600 uppercase",
                  column.align === "right" ? "text-right" : "text-left",
                )}
                aria-sort={
                  sort?.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : undefined
                }
              >
                {column.sortable && onSort ? (
                  <button
                    type="button"
                    onClick={() => onSort(column.key)}
                    className="inline-flex items-center gap-1 hover:text-ink-900"
                  >
                    {column.header}
                    <span aria-hidden className="text-ink-400">
                      {sort?.key === column.key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              tabIndex={onRowActivate ? 0 : undefined}
              onClick={(event) => onRowActivate?.(row, event.currentTarget)}
              onKeyDown={(event) => {
                if (!onRowActivate || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                onRowActivate(row, event.currentTarget);
              }}
              className={cx(
                "border-b border-line last:border-b-0",
                onRowActivate && "cursor-pointer hover:bg-hover-veil focus-visible:bg-hover-veil",
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx("px-4 py-3.5 align-middle", column.align === "right" && "text-right tabular-nums")}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DataCards<Row>({
  rows,
  rowKey,
  renderCard,
  onRowActivate,
  empty,
  className = "",
}: {
  rows: Row[];
  rowKey: (row: Row) => string;
  renderCard: (row: Row) => ReactNode;
  onRowActivate?: (row: Row, element: HTMLElement) => void;
  empty?: ReactNode;
  className?: string;
}) {
  if (rows.length === 0 && empty) return <div className={cx("lg:hidden", className)}>{empty}</div>;

  return (
    <div className={cx("space-y-3 lg:hidden", className)}>
      {rows.map((row) => (
        <button
          key={rowKey(row)}
          type="button"
          onClick={(event) => onRowActivate?.(row, event.currentTarget)}
          className="block w-full rounded-2xl border border-line bg-surface p-4 text-left shadow-card active:scale-[0.995]"
        >
          {renderCard(row)}
        </button>
      ))}
    </div>
  );
}

export function DataList({ className = "", children }: { className?: string; children: ReactNode }) {
  return <dl className={cx("divide-y divide-line", className)}>{children}</dl>;
}

export function DataRow({ label, value, className = "" }: { label: ReactNode; value: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4 py-2.5", className)}>
      <dt className="shrink-0 text-sm text-ink-600">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-semibold tabular-nums text-ink-900">{value}</dd>
    </div>
  );
}

export function Stat({
  label,
  value,
  detail,
  tone = "default",
  className = "",
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  tone?: "default" | "primary" | "warning";
  className?: string;
}) {
  const isPrimary = tone === "primary";
  const isWarning = tone === "warning";
  return (
    <div className={cx(
      "rounded-2xl border p-5 shadow-card sm:p-6",
      // `dark` makes this an ink island: everything nested inside themes against
      // the pine plate instead of the page ground.
      isPrimary
        ? "dark border-pine-700 bg-linear-to-br from-pine-900 to-pine-800 text-white"
        : isWarning
          ? "border-berry-soft-border bg-berry-soft"
          : "border-line bg-surface",
      className,
    )}>
      <p className={cx("text-sm font-medium", isPrimary ? "text-pine-100" : isWarning ? "text-berry" : "text-ink-600")}>{label}</p>
      <p className={cx("mt-2 font-display text-3xl font-semibold tabular-nums", isWarning && "text-berry")}>{value}</p>
      {detail && <div className={cx("mt-2 text-xs leading-5", isPrimary ? "text-pine-100/90" : isWarning ? "font-medium text-berry" : "text-ink-600")}>{detail}</div>}
    </div>
  );
}

/* -------------------------------- Empty states -------------------------------- */

export function EmptyState({
  icon,
  illustration,
  title,
  body,
  action,
  className = "",
}: {
  icon?: ReactNode;
  /** Preferred over `icon`: draws the festive line art at display size. */
  illustration?: OrnamentName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const hasArt = Boolean(illustration || icon);
  return (
    <div className={cx("rounded-2xl border border-dashed border-line-strong bg-surface-2 px-5 py-12 text-center", className)}>
      {illustration ? (
        <Ornament aria-hidden name={illustration} size={92} className="mx-auto text-ink-400" />
      ) : icon ? (
        <span aria-hidden className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">{icon}</span>
      ) : null}
      <p className={cx("font-display text-xl font-semibold text-ink-900", hasArt && "mt-4")}>{title}</p>
      {body && <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink-600">{body}</p>}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded-xl bg-surface-3/70", className)} />;
}

/* ------------------------------- Notices / alerts ------------------------------ */

export function Notice({
  tone = "info",
  onDismiss,
  className = "",
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  onDismiss?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const tones = {
    info: "border-accent-soft-border bg-accent-soft text-accent",
    success: "border-success-border bg-success-soft text-success",
    warning: "border-warning-border bg-warning-soft text-warning",
    danger: "border-berry-soft-border bg-berry-soft text-berry",
  };
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex items-start justify-between gap-4 rounded-xl border p-4 text-sm font-medium leading-6", tones[tone], className)}>
      <div className="min-w-0">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss message" className="shrink-0 rounded-md p-1 hover:bg-hover-veil">
          <IconClose size={16} />
        </button>
      )}
    </div>
  );
}

/* ----------------------------------- Modal ------------------------------------ */

export function Modal({
  labelledBy,
  onClose,
  size = "md",
  dismissible = true,
  surface = "cream",
  className = "",
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  size?: "sm" | "md" | "lg" | "xl";
  dismissible?: boolean;
  /** "cream"/"white" are the original names; "ground"/"surface" are their honest aliases. */
  surface?: "cream" | "white" | "ground" | "surface";
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogBehaviour(panel, { onClose, dismissible });

  const sizes = {
    sm: "sm:max-w-md",
    md: "sm:max-w-lg",
    lg: "sm:max-w-3xl",
    xl: "sm:max-w-5xl",
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim backdrop-blur-[3px] sm:items-center sm:p-6"
      onMouseDown={(event) => { if (event.target === event.currentTarget && dismissible) onClose(); }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        // The radius and the scrolling live on different elements on purpose.
        // With both on one element the native scrollbar is painted inside the
        // corner radius, squaring off the rounded corner and running past the
        // panel edge. Clipping here and scrolling on the child makes the bar
        // follow the curve.
        className={cx(
          "relative flex w-full max-h-[94dvh] flex-col overflow-hidden rounded-t-3xl shadow-modal outline-none sm:rounded-3xl",
          surface === "cream" || surface === "ground" ? "bg-ground" : "bg-surface",
          sizes[size],
          className,
        )}
      >
        <div className="dialog-scroll relative min-h-0 overflow-y-auto overscroll-contain">
          <span aria-hidden className="garland-hairline sticky top-0 z-30 block h-px w-full" />
          <div aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong sm:hidden" />
          {children}
        </div>
      </div>
    </div>
  );
}

export function ModalHeader({
  id,
  eyebrow,
  title,
  description,
  onClose,
  closeLabel = "Close",
  sticky = false,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  sticky?: boolean;
}) {
  return (
    // `top-0`, not `top-1`: a 4px offset left a window between the panel's top
    // edge and the header through which scrolling content stayed visible. The
    // garland hairline still reads above it — it sticks at the same offset with
    // a higher z-index.
    <header className={cx(
      "flex items-start justify-between gap-4 px-5 pt-4 pb-4 sm:px-7 sm:pt-6",
      sticky && "sticky top-0 z-20 border-b border-line bg-ground backdrop-blur",
    )}>
      <div className="min-w-0">
        {eyebrow && <p className="text-xs font-semibold tracking-eyebrow text-gold uppercase">{eyebrow}</p>}
        <h2 id={id} className={cx("break-words font-display text-2xl font-semibold text-ink-900 sm:text-3xl", eyebrow && "mt-1")}>{title}</h2>
        {description && <p className="mt-1.5 text-sm leading-6 text-ink-600">{description}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-600 shadow-sm hover:border-line-strong hover:text-ink-900"
      >
        <IconClose size={18} />
      </button>
    </header>
  );
}

export function ModalFooter({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx(
      "sticky bottom-0 z-20 mt-2 grid grid-cols-2 gap-3 border-t border-line bg-ground/95 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur sm:px-7",
      className,
    )}>
      {children}
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busyLabel,
  busy = false,
  danger = true,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal labelledBy="confirm-dialog-title" onClose={onCancel} size="sm" surface="white" dismissible={!busy}>
      <div className="p-5 sm:p-7">
        <h2 id="confirm-dialog-title" className="font-display text-xl font-semibold text-ink-900">{title}</h2>
        <div className="mt-2 text-sm leading-6 text-ink-600">{body}</div>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <Button variant="secondary" size="lg" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} size="lg" disabled={busy} onClick={onConfirm}>
            {busy ? (busyLabel ?? "Working...") : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------ Sheet ----------------------------------- */

const sheetSizes = { sm: "sm:max-w-sm", md: "sm:max-w-md", lg: "sm:max-w-lg" };

/**
 * Edge-anchored panel for secondary controls — filters, pickers — that would
 * over-weight a centred `Modal`. Shares `Modal`'s focus trap, Esc handling and
 * scroll lock via `useDialogBehaviour`.
 */
export function Sheet({
  labelledBy,
  onClose,
  side = "bottom",
  size = "md",
  dismissible = true,
  className = "",
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  side?: "bottom" | "right";
  size?: keyof typeof sheetSizes;
  dismissible?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogBehaviour(panel, { onClose, dismissible });

  return (
    <div
      className={cx(
        "fixed inset-0 z-50 flex bg-scrim backdrop-blur-[3px]",
        side === "bottom" ? "items-end justify-center" : "items-stretch justify-end",
      )}
      onMouseDown={(event) => { if (event.target === event.currentTarget && dismissible) onClose(); }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        // Same split as `Modal`: this element owns the radius and clips, the
        // child scrolls, so the scrollbar cannot square off a rounded corner.
        className={cx(
          "relative flex w-full flex-col overflow-hidden bg-ground shadow-modal outline-none",
          side === "bottom"
            ? cx("max-h-[88dvh] rounded-t-3xl sm:mb-6 sm:rounded-3xl", sheetSizes[size])
            : cx("h-full max-w-[92vw]", sheetSizes[size]),
          className,
        )}
      >
        {side === "bottom" && (
          <span aria-hidden className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-strong sm:hidden" />
        )}
        {/* Stays a flex column so `SheetFooter`'s `mt-auto` still pins to the
            bottom; `flex-1` only on the full-height side panel, so a bottom
            sheet still sizes to its content. */}
        <div className={cx(
          "dialog-scroll flex min-h-0 flex-col overflow-y-auto overscroll-contain",
          side === "right" && "flex-1",
        )}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function SheetHeader({
  id,
  title,
  description,
  onClose,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  onClose: () => void;
}) {
  return (
    <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-4 sm:px-6">
      <div className="min-w-0">
        <h2 id={id} className="font-display text-xl font-semibold text-ink-900">{title}</h2>
        {description && <p className="mt-1 text-sm leading-6 text-ink-600">{description}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-600 hover:border-line-strong hover:text-ink-900"
      >
        <IconClose size={18} />
      </button>
    </header>
  );
}

export function SheetFooter({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        "sticky bottom-0 z-10 mt-auto grid grid-cols-2 gap-3 border-t border-line bg-ground/95 px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-6",
        className,
      )}
    >
      {children}
    </div>
  );
}
