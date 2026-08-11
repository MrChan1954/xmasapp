"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { GarlandRule } from "./festive/garland";
import { Snowfall } from "./festive/snowfall";
import { pageTitleFor } from "./nav-items";
import { TopBar } from "./top-bar";

const widths = {
  narrow: "max-w-[1080px]",
  default: "max-w-[1240px]",
  wide: "max-w-[1480px]",
};

/**
 * The per-page content column: a sticky top bar and one consistent content
 * width. The surrounding navigation chrome comes from `AppFrame` on the root
 * layout, so it is not rebuilt when the route changes.
 *
 * Every prop beyond `children` is optional so existing call sites keep working;
 * `title`/`parent` default to the route's entry in `pageTitleFor`.
 */
export function AppShell({
  width = "default",
  title,
  parent,
  topBarActions,
  snow = false,
  children,
}: {
  width?: keyof typeof widths;
  title?: string;
  parent?: { href: string; label: string };
  topBarActions?: ReactNode;
  snow?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const fallback = pageTitleFor(pathname);

  // The rail and tab bar are NOT rendered here: they live in `AppFrame` on the
  // root layout so they survive navigation. This component is the per-page
  // content column that sits between them.
  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      {snow && <Snowfall />}
      <TopBar title={title ?? fallback.title} parent={parent ?? fallback.parent} actions={topBarActions} />
      {/* `pb` clears the fixed tab bar, which itself grows by the bottom inset
          on a device with a home indicator — so the clearance has to grow with
          it or the last row hides behind the bar. The side insets only bite in
          landscape on a notched phone. All resolve to 0 on desktop, where `lg:`
          drops the tab-bar clearance anyway. */}
      <main
        className={cx(
          "relative mx-auto w-full pt-6 pb-[calc(7rem+env(safe-area-inset-bottom))] sm:pt-8 lg:pb-16",
          "pl-[calc(1rem+env(safe-area-inset-left))] sm:pl-[calc(1.5rem+env(safe-area-inset-left))] lg:pl-[calc(2rem+env(safe-area-inset-left))]",
          "pr-[calc(1rem+env(safe-area-inset-right))] sm:pr-[calc(1.5rem+env(safe-area-inset-right))] lg:pr-[calc(2rem+env(safe-area-inset-right))]",
          widths[width],
        )}
      >
        {children}
      </main>
    </div>
  );
}

/**
 * The editorial page masthead: gold eyebrow, serif title, optional dek and
 * actions, closed by a gold hairline.
 */
export function PageHeader({
  eyebrow = "Christmas 2026",
  title,
  description,
  actions,
  className = "",
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("relative", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          {eyebrow && <p className="text-xs font-semibold tracking-eyebrow text-gold uppercase">{eyebrow}</p>}
          <h1 className="mt-2 font-display text-[clamp(2rem,5vw,2.75rem)] leading-[1.08] font-semibold tracking-tight text-balance text-ink-900">
            {title}
          </h1>
          {description && <p className="mt-3 max-w-2xl text-sm leading-6 text-ink-600">{description}</p>}
        </div>
        {actions && <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">{actions}</div>}
      </div>
      <GarlandRule className="mt-6" />
    </header>
  );
}
