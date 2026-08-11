"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { AccountMenu } from "./account-menu";
import { CommandPalette, SearchTrigger, useCommandPalette } from "./command-search";
import { Ornament } from "./festive/ornaments";

/**
 * Sticky page chrome. Carries the breadcrumb and title, the search affordance
 * and the account menu, on every width. Sits at z-30: above page content, below
 * `Modal` (z-50) and the rail's expanded panel.
 */
export function TopBar({
  title,
  parent,
  actions,
}: {
  title: string;
  parent?: { href: string; label: string };
  actions?: ReactNode;
}) {
  const palette = useCommandPalette();

  return (
    <>
      {/* The top inset matters only in an installed app: with `viewport-fit:
          cover`, the web view extends under the status bar and Dynamic Island,
          and without this the title row sits beneath them. Padding rather than
          an offset, so the bar's own background fills that strip. Resolves to
          0 in a browser and on desktop. */}
      <header className="sticky top-0 z-30 border-b border-line bg-ground/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:h-[72px] lg:px-8">
          <Link href="/" className="flex shrink-0 items-center gap-2.5 lg:hidden" aria-label="Christmas Budget home">
            {/* Matches the desktop rail mark in `icon-rail.tsx`: glyph only, no
                filled tile, so the logo is the same at every breakpoint. */}
            <span aria-hidden className="flex h-9 w-9 items-center justify-center text-accent">
              <Ornament name="tree" size={26} strokeWidth={1.6} />
            </span>
          </Link>

          <div className="min-w-0 flex-1">
            {parent && (
              <Link
                href={parent.href}
                className="-ml-1 inline-flex items-center gap-0.5 text-xs font-semibold text-ink-600 hover:text-ink-900"
              >
                <ChevronLeft aria-hidden size={14} strokeWidth={2} />
                {parent.label}
              </Link>
            )}
            <p className={parent ? "truncate text-sm font-semibold text-ink-900" : "truncate font-display text-lg font-semibold text-ink-900"}>
              {title}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {actions}
            <SearchTrigger onOpen={() => palette.setOpen(true)} className="lg:w-56 lg:justify-start" />
            <AccountMenu />
          </div>
        </div>
      </header>

      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
    </>
  );
}
