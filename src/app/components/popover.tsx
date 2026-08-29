"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { cx } from "./cx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Popover as ShadcnPopover,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover";

/*
 * This file used to export one hand-rolled anchored panel used for two
 * different jobs, and the second job was the tell: the payment log's filter
 * form was rendered inside something announcing `role="menu"`. A menu's
 * contract is that arrow keys move between items and Tab leaves — which is
 * exactly wrong for a panel of text fields and selects.
 *
 * So there are two primitives now, both from the registry:
 *
 *   Menu     a real menu (account menu). Radix gives it roving tabindex,
 *            typeahead, Home/End, and the right ARIA.
 *   Popover  an anchored panel of ARBITRARY content (the filter disclosure).
 *            Focus moves into it normally and Tab walks its fields.
 *
 * Both are collision-aware, which the hand-rolled version was not: an
 * end-aligned panel could previously run off the side of a phone screen.
 */

const triggerClasses = "group/trigger flex items-center rounded-xl outline-none";

/** An anchored panel of arbitrary content — forms, filters, rich detail. */
export function Popover({
  trigger,
  label,
  align = "end",
  panelClassName = "",
  className = "",
  children,
}: {
  trigger: (props: { open: boolean }) => ReactNode;
  label: string;
  align?: "start" | "end";
  panelClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ShadcnPopover>
      <PopoverTrigger aria-label={label} className={cx(triggerClasses, className)}>
        {/*
          The trigger restyles itself while the panel is open. Radix writes
          `data-state` onto the trigger, so that is read straight off the DOM
          with `group-data-[state=open]/trigger:` rather than being mirrored in
          React state. `open: false` is passed for the callback's shape only.
        */}
        {trigger({ open: false })}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={8}
        aria-label={label}
        className={cx(
          "z-50 w-auto min-w-56 overflow-hidden rounded-2xl border-line bg-surface p-1.5 shadow-modal",
          panelClassName,
        )}
      >
        {children}
      </PopoverContent>
    </ShadcnPopover>
  );
}

/** A real menu of commands. */
export function Menu({
  trigger,
  label,
  align = "end",
  panelClassName = "",
  className = "",
  children,
}: {
  trigger: (props: { open: boolean }) => ReactNode;
  label: string;
  align?: "start" | "end";
  panelClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={label} className={cx(triggerClasses, className)}>
        {trigger({ open: false })}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        sideOffset={8}
        aria-label={label}
        className={cx(
          "min-w-56 overflow-hidden rounded-2xl border-line bg-surface p-1.5 shadow-modal",
          panelClassName,
        )}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const itemClasses = (tone: "default" | "danger") =>
  cx(
    "flex w-full min-h-11 items-center gap-2.5 rounded-xl px-3 text-left text-sm font-semibold",
    tone === "danger"
      ? "text-berry focus:bg-berry-soft focus:text-berry data-[highlighted]:bg-berry-soft data-[highlighted]:text-berry"
      : "text-ink-700 focus:bg-hover-veil focus:text-ink-900 data-[highlighted]:bg-hover-veil data-[highlighted]:text-ink-900",
  );

export function MenuItem({
  onClick,
  href,
  tone = "default",
  icon,
  children,
}: {
  onClick?: () => void;
  href?: string;
  tone?: "default" | "danger";
  icon?: ReactNode;
  children: ReactNode;
}) {
  if (href) {
    // `asChild` keeps this a real anchor — right-clickable, middle-clickable,
    // announced as a link — while Radix still treats it as a menu item.
    return (
      <DropdownMenuItem asChild className={itemClasses(tone)}>
        <Link href={href}>
          {icon}
          {children}
        </Link>
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem onSelect={() => onClick?.()} className={itemClasses(tone)}>
      {icon}
      {children}
    </DropdownMenuItem>
  );
}

/** One-of-many, e.g. which family is active. */
export function MenuRadioGroup({ value, children }: { value: string; children: ReactNode }) {
  return <DropdownMenuRadioGroup value={value}>{children}</DropdownMenuRadioGroup>;
}

export function MenuRadioItem({
  value,
  onSelect,
  icon,
  children,
}: {
  value: string;
  onSelect: () => void;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DropdownMenuRadioItem
      value={value}
      onSelect={onSelect}
      // This menu has always drawn its tick on the right, next to the family
      // name; the primitive's own left-hand indicator slot is hidden so there
      // is exactly one.
      className={cx(itemClasses("default"), "pr-3 pl-3 [&>span:first-child]:hidden")}
    >
      {icon}
      {children}
    </DropdownMenuRadioItem>
  );
}

/** An on/off choice that keeps the menu open, e.g. falling snow. */
export function MenuCheckboxItem({
  checked,
  disabled,
  onCheckedChange,
  icon,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      // Toggling appearance should not dismiss the menu it lives in.
      onSelect={(event) => event.preventDefault()}
      className={cx(itemClasses("default"), "pr-3 pl-3 [&>span:first-child]:hidden")}
    >
      {icon}
      {children}
    </DropdownMenuCheckboxItem>
  );
}

export function MenuSection({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <DropdownMenuGroup className="border-t border-line px-1.5 pt-2 pb-1 first:border-t-0 first:pt-1">
      {label && (
        <DropdownMenuLabel className="px-1.5 pb-1.5 text-[11px] font-semibold tracking-eyebrow text-ink-400 uppercase">
          {label}
        </DropdownMenuLabel>
      )}
      {children}
    </DropdownMenuGroup>
  );
}
