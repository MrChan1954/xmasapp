"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { cx } from "../cx";
import { cn } from "@/lib/cn";
import { Button as ShadcnButton, buttonVariants } from "./button";
import { Badge as ShadcnBadge } from "./badge";
import { Input as ShadcnInput, fieldClasses } from "./input";
import { Label } from "./label";
import { NativeSelect } from "./native-select";
import { Textarea as ShadcnTextarea } from "./textarea";
import { Skeleton as ShadcnSkeleton } from "./skeleton";
import { Card as ShadcnCard } from "./card";
import { Alert as ShadcnAlert } from "./alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import { Dialog, DialogOverlay, DialogPortal, DialogPrimitive, DialogTitle } from "./dialog";
import { Sheet as SheetRoot, SheetOverlay, SheetPortal, SheetPrimitive } from "./sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { Ornament, type OrnamentName } from "../festive/ornaments";
import { IconClose } from "../icons";

export { cx } from "../cx";

/* ---------------------------------- Buttons --------------------------------- */

/**
 * The product's button vocabulary, which now lives in the cva inside
 * ./button.tsx. These re-exports keep the ~50 existing call sites — and the
 * `variant="tonal"` / `size="md"` language they speak — working unchanged.
 */
export type ButtonVariant = "primary" | "secondary" | "tonal" | "ghost" | "danger" | "dangerGhost" | "gold";
export type ButtonSize = "sm" | "md" | "lg" | "icon" | "icon-sm" | "icon-lg";

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", className = "") {
  return buttonVariants({ variant, size, className });
}

export function Button({
  variant = "primary",
  size = "md",
  type = "button",
  ...rest
}: React.ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <ShadcnButton type={type} variant={variant} size={size} {...rest} />;
}

/**
 * A link that looks like a button. `asChild` hands the button's classes to the
 * Next `Link` rather than nesting an <a> inside a <button>, so it stays a real
 * anchor — right-clickable, middle-clickable, and announced as a link.
 */
export function ButtonLink({
  variant = "primary",
  size = "md",
  className = "",
  href,
  children,
  ...rest
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string; href: string; children: ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <ShadcnButton asChild variant={variant} size={size} className={className}>
      <Link href={href} {...rest}>{children}</Link>
    </ShadcnButton>
  );
}

/* ----------------------------------- Forms ----------------------------------- */

/**
 * The field look now lives in ./input.tsx as `fieldClasses` and is worn by the
 * shadcn Input, Textarea and NativeSelect alike. Re-exported under its old
 * name for the handful of places that compose a bespoke control.
 */
export const inputClasses = fieldClasses;

/**
 * A labelled form row.
 *
 * The <label> WRAPS its control, which associates the two implicitly — no
 * id/htmlFor bookkeeping, and impossible to leave dangling when a field is
 * copied. That is the reason ordinary "pick one" fields use the native
 * <select> rather than the Radix one: a Radix trigger is a <button>, and a
 * button inside a label is not a labelled control.
 *
 * `error` renders with role="alert" so a validation failure is announced
 * rather than only turning something red, and sets aria-invalid on the field.
 */
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
      <Label asChild>
        <span className="text-sm font-semibold text-ink-900">
          {label}
          {required && <span aria-hidden className="text-berry"> *</span>}
        </span>
      </Label>
      <span className="mt-2 block">{children}</span>
      {hint && <span className="mt-1.5 block text-xs leading-5 text-ink-600">{hint}</span>}
      {error && <span role="alert" className="mt-1.5 block text-xs font-semibold text-berry">{error}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <ShadcnInput {...props} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { size: _size, ...rest } = props;
  void _size;
  return <NativeSelect {...rest} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <ShadcnTextarea {...props} />;
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
          <ShadcnButton
            key={option.value}
            type="button"
            variant="ghost"
            size="sm"
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
          </ShadcnButton>
        );
      })}
    </div>
  );
}

/* ---------------------------------- Badges ----------------------------------- */

/**
 * A status pill. The tones are domain semantics — on track, over budget,
 * settled — and live in the cva in ./badge.tsx alongside shadcn's own
 * variants. The dot is what makes the state readable without relying on
 * colour alone.
 */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "gold" | "pine";

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
    <ShadcnBadge variant={tone} className={className}>
      {dot && <span aria-hidden className={cx("h-1.5 w-1.5 shrink-0 rounded-full", badgeDots[tone])} />}
      {children}
    </ShadcnBadge>
  );
}
/* ----------------------------------- Cards ------------------------------------ */

/**
 * The app's card. Tones live in the cva in ./card.tsx; `as` keeps the element
 * semantic (a section that opens with a heading should not be a div).
 */
export function Card({
  as: Tag = "div",
  tone = "surface",
  padded = false,
  className = "",
  children,
}: {
  as?: "div" | "section" | "article";
  tone?: "surface" | "sunken" | "ink";
  padded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ShadcnCard asChild tone={tone} className={cx(padded && "p-5 sm:p-6", className)}>
      <Tag>{children}</Tag>
    </ShadcnCard>
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
    <ShadcnCard asChild tone="surface" className={cx("p-5 sm:p-6", className)}>
    <section>
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
    </ShadcnCard>
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
    <ShadcnButton
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold whitespace-nowrap transition",
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
    </ShadcnButton>
  );
}

/**
 * A person you can switch on or off — a recipient on an event, a contributor,
 * somebody granted access. Five screens had each grown their own copy of this
 * control; they now share one, so "selected" looks and reads the same
 * everywhere.
 *
 * It is a toggle, not a link or a checkbox, so it carries `aria-pressed`:
 * a screen reader announces the name AND whether it is currently on.
 */
export function ToggleChip({
  on,
  onClick,
  disabled = false,
  className = "",
  children,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ShadcnButton
      type="button"
      variant="ghost"
      size="md"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "border",
        on ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink-600 hover:bg-hover-veil",
        className,
      )}
    >
      {children}
    </ShadcnButton>
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
      <Table className="border-collapse text-sm">
        <TableHeader className="sticky top-0 z-10 bg-surface">
          <TableRow className="border-b border-line hover:bg-transparent">
            {columns.map((column) => (
              <TableHead
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
                  <ShadcnButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onSort(column.key)}
                    className="-mx-2 inline-flex min-h-0 items-center gap-1 px-2 py-1 text-xs font-semibold tracking-eyebrow uppercase hover:text-ink-900"
                  >
                    {column.header}
                    <span aria-hidden className="text-ink-400">
                      {sort?.key === column.key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </ShadcnButton>
                ) : (
                  column.header
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={rowKey(row)}
              // An activatable row is announced as the button it behaves like,
              // and is reachable and operable from the keyboard.
              role={onRowActivate ? "button" : undefined}
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
                <TableCell
                  key={column.key}
                  className={cx("px-4 py-3.5 align-middle", column.align === "right" && "text-right tabular-nums")}
                >
                  {column.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
        <ShadcnButton
          key={rowKey(row)}
          type="button"
          variant="secondary"
          size="md"
          onClick={(event) => onRowActivate?.(row, event.currentTarget)}
          className="block h-auto w-full rounded-2xl border-line bg-surface p-4 text-left whitespace-normal shadow-card"
        >
          {renderCard(row)}
        </ShadcnButton>
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
  return <ShadcnSkeleton className={cn("bg-surface-3", className)} />;
}
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
  return (
    <ShadcnAlert
      variant={tone}
      // A failure interrupts; anything else is announced politely when the
      // reader next pauses.
      role={tone === "danger" ? "alert" : "status"}
      className={cx("flex items-start justify-between gap-4", className)}
    >
      <div className="min-w-0">{children}</div>
      {onDismiss && (
        <ShadcnButton
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          aria-label="Dismiss message"
          className="shrink-0 rounded-md"
        >
          <IconClose size={16} />
        </ShadcnButton>
      )}
    </ShadcnAlert>
  );
}

/**
 * Return focus to whatever opened the dialog.
 *
 * Radix does this itself — but it learns what to go back to from its own
 * `DialogTrigger`, and this app has none: every dialog is rendered
 * CONDITIONALLY (`{open && <Modal … />}`) and opened by an ordinary button
 * somewhere else on the page. With no trigger to remember, Radix drops focus on
 * <body> when the panel unmounts, which live QA caught on the Add recipient
 * dialog — close it and the keyboard is back at the top of the document.
 *
 * The hand-rolled dialog this replaced restored focus on unmount, so this is
 * that behaviour kept rather than a new idea.
 *
 * Three details are load-bearing:
 *
 * - the opener is captured in a `useState` initialiser, which runs during
 *   RENDER. An effect would be too late: child effects run before the parent's,
 *   so Radix's content has already moved focus into the panel by then and we
 *   would capture the panel itself;
 *
 * - Radix is told to stand down, rather than raced. Its focus scope restores on
 *   its own timer as the panel unmounts, and with no trigger to go back to it
 *   restores to `document.body` — actively undoing this. Every panel below
 *   therefore passes `onCloseAutoFocus={preventDefault}`, which is the event
 *   Radix's `onUnmountAutoFocus` is wired to and the supported way to say
 *   "focus is being handled here";
 *
 * - the restore is a `setTimeout`, NOT `requestAnimationFrame`. Chrome does
 *   not run animation frames in a background tab, so a rAF-based restore
 *   silently never happens there — which is exactly how this fix first appeared
 *   to work in tests and not in the browser. Timers still fire when hidden.
 *   The delay also puts it after the commit that removes the panel, so the
 *   browser has already reset `activeElement` by the time this reads it.
 */
const preventDefault = (event: Event) => event.preventDefault();

function useReturnFocus() {
  const [opener] = useState(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );

  useEffect(() => () => {
    if (!opener) return;
    setTimeout(() => {
      // Gone from the page — a dialog that saved and navigated, say. Focusing a
      // detached node would silently move focus to <body>, the very thing this
      // exists to prevent.
      if (opener.isConnected) opener.focus();
    }, 0);
  }, [opener]);
}

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
  useReturnFocus();

  const sizes = {
    sm: "sm:max-w-md",
    md: "sm:max-w-lg",
    lg: "sm:max-w-3xl",
    xl: "sm:max-w-5xl",
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-describedby={undefined}
          onCloseAutoFocus={preventDefault}
          onEscapeKeyDown={(event) => { if (!dismissible) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (!dismissible) event.preventDefault(); }}
          onInteractOutside={(event) => { if (!dismissible) event.preventDefault(); }}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-3xl pb-[env(safe-area-inset-bottom)] shadow-modal outline-none",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
            "sm:inset-0 sm:m-auto sm:h-fit sm:rounded-3xl sm:pb-0",
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
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

/**
 * The dialog's accessible name.
 *
 * Radix insists a dialog has a Title, and screen readers announce it on open.
 * Modals that use `ModalHeader` get one for free; the few that draw their own
 * heading (command search, the photo viewer) wrap it in this, so the heading
 * they already render becomes the real title rather than a second one.
 */
export function ModalTitle({ id, className = "", children }: { id: string; className?: string; children: ReactNode }) {
  return <DialogTitle asChild><h2 id={id} className={className}>{children}</h2></DialogTitle>;
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
        <ModalTitle id={id} className={cx("break-words font-display text-2xl font-semibold text-ink-900 sm:text-3xl", eyebrow && "mt-1")}>{title}</ModalTitle>
        {description && <p className="mt-1.5 text-sm leading-6 text-ink-600">{description}</p>}
      </div>
      <Button
        variant="secondary"
        size="icon"
        onClick={onClose}
        aria-label={closeLabel}
        className="shrink-0 rounded-full border-line bg-surface text-ink-600 shadow-sm hover:border-line-strong hover:text-ink-900"
      >
        <IconClose size={18} />
      </Button>
    </header>
  );
}

export function ModalFooter({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx(
      // Plain padding: the safe-area inset is reserved by the `Modal` panel now,
      // so repeating it here would double it.
      "sticky bottom-0 z-20 mt-2 grid grid-cols-2 gap-3 border-t border-line bg-ground/95 px-5 pt-4 pb-4 backdrop-blur sm:px-7",
      className,
    )}>
      {children}
    </div>
  );
}

/**
 * A destructive confirmation.
 *
 * This is an AlertDialog rather than a Dialog: it is announced as
 * role="alertdialog", and — the reason it matters here — it cannot be dismissed
 * by clicking the backdrop, so a stray click outside can never be the thing
 * that deletes an event. Escape still cancels, unless work is already in flight.
 */
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
  useReturnFocus();

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <AlertDialogContent
        aria-modal="true"
        onCloseAutoFocus={preventDefault}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        className="max-w-[calc(100%-2rem)] gap-0 rounded-3xl border-line bg-surface p-5 shadow-modal sm:max-w-md sm:p-7"
      >
        <AlertDialogHeader className="gap-0 text-left sm:text-left">
          <AlertDialogTitle className="font-display text-xl font-semibold text-ink-900">{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="mt-2 text-sm leading-6 text-ink-600">{body}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <AlertDialogCancel variant="secondary" size="lg" disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={danger ? "danger" : "primary"}
            size="lg"
            disabled={busy}
            onClick={(event) => { event.preventDefault(); onConfirm(); }}
          >
            {busy ? (busyLabel ?? "Working...") : confirmLabel}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ------------------------------------ Sheet ----------------------------------- */

const sheetSizes = { sm: "sm:max-w-sm", md: "sm:max-w-md", lg: "sm:max-w-lg" };

/**
 * Edge-anchored panel for secondary controls — filters, pickers — that would
 * over-weight a centred `Modal`. Same Radix behaviour as `Modal`; the geometry
 * differs, and the same radius/scroll split applies.
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
  useReturnFocus();

  return (
    <SheetRoot open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetPortal>
        <SheetOverlay />
        <SheetPrimitive.Content
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-describedby={undefined}
          onCloseAutoFocus={preventDefault}
          onEscapeKeyDown={(event) => { if (!dismissible) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (!dismissible) event.preventDefault(); }}
          onInteractOutside={(event) => { if (!dismissible) event.preventDefault(); }}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden bg-ground shadow-modal outline-none",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
            side === "bottom"
              ? cx("inset-x-0 bottom-0 mx-auto max-h-[88dvh] w-full rounded-t-3xl pb-[env(safe-area-inset-bottom)] sm:bottom-6 sm:rounded-3xl sm:pb-0", sheetSizes[size])
              : cx("inset-y-0 right-0 h-full w-full max-w-[92vw] pb-[env(safe-area-inset-bottom)]", sheetSizes[size]),
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
        </SheetPrimitive.Content>
      </SheetPortal>
    </SheetRoot>
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
        <ModalTitle id={id} className="font-display text-xl font-semibold text-ink-900">{title}</ModalTitle>
        {description && <p className="mt-1 text-sm leading-6 text-ink-600">{description}</p>}
      </div>
      <Button
        variant="secondary"
        size="icon"
        onClick={onClose}
        aria-label="Close"
        className="shrink-0 rounded-full border-line bg-surface text-ink-600 hover:border-line-strong hover:text-ink-900"
      >
        <IconClose size={18} />
      </Button>
    </header>
  );
}

export function SheetFooter({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        // Plain padding: the `Sheet` panel reserves the safe-area inset.
        "sticky bottom-0 z-10 mt-auto grid grid-cols-2 gap-3 border-t border-line bg-ground/95 px-5 pt-4 pb-4 backdrop-blur sm:px-6",
        className,
      )}
    >
      {children}
    </div>
  );
}
