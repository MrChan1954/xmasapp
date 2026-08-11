"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";

/**
 * Small anchored menu: click-outside and Esc close it, focus returns to the
 * trigger. `children` may be a function so a menu item can close the panel
 * after acting.
 */
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
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Focus returns to the trigger whenever the panel closes, wherever the close
  // came from. Doing it here rather than inside `close` keeps `close` free of
  // ref reads, so it is safe to hand to `children` during render.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  return (
    <div ref={root} className={cx("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center rounded-xl outline-none"
      >
        {trigger({ open })}
      </button>

      {open && (
        <div
          id={panelId}
          role="menu"
          aria-label={label}
          className={cx(
            "absolute top-[calc(100%+0.5rem)] z-50 min-w-56 overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-modal",
            align === "end" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function PopoverItem({
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
  const className = cx(
    "flex w-full min-h-10 items-center gap-2.5 rounded-xl px-3 text-left text-sm font-semibold",
    tone === "danger" ? "text-berry hover:bg-berry-soft" : "text-ink-700 hover:bg-hover-veil hover:text-ink-900",
  );

  if (href) {
    return (
      <a role="menuitem" href={href} className={className}>
        {icon}
        {children}
      </a>
    );
  }

  return (
    <button role="menuitem" type="button" onClick={onClick} className={className}>
      {icon}
      {children}
    </button>
  );
}

export function PopoverSection({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="border-t border-line px-1.5 pt-2 pb-1 first:border-t-0 first:pt-1">
      {label && <p className="px-1.5 pb-1.5 text-[11px] font-semibold tracking-eyebrow text-ink-400 uppercase">{label}</p>}
      {children}
    </div>
  );
}
