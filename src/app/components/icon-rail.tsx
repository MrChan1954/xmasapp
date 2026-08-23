"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, ShieldCheck } from "lucide-react";
import { useFamily } from "../family-context";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventTypeMeta } from "@/lib/events.ts";
import { cx } from "./cx";
import { EVENTS_HOME, activeNavSection, navItemsFor } from "./nav-items";
import { Ornament } from "./festive/ornaments";

/**
 * Desktop navigation: a slim icon rail that expands on hover or keyboard focus.
 *
 * The <aside> keeps its collapsed width in the layout while the panel inside it
 * is absolutely positioned, so expanding overlays the page instead of pushing
 * the content column sideways.
 */
export function IconRail() {
  const pathname = usePathname();
  const { isAdmin, event, eventId } = useFamily();
  const items = navItemsFor(eventId);
  const activeSection = activeNavSection(pathname);

  return (
    <aside className="relative hidden w-[76px] shrink-0 lg:block">
      {/* Class names are written out in full: Tailwind scans source text, so a
          composed `hover:${…}` would never be generated.

          Keyboard focus expands the rail, pointer focus does not — hence
          `has-[:focus-visible]` rather than `focus-within`. Clicking a nav link
          leaves that link focused, and because the rail now survives navigation
          (it lives in `AppFrame`) plain `focus-within` kept it wedged open after
          the pointer had left. `:focus-visible` is exactly the "focus the user
          needs to see" signal, so keyboard navigation still works. */}
      <div className="group/rail fixed inset-y-0 left-0 z-40 flex w-[76px] flex-col overflow-hidden border-r border-line bg-surface transition-[width] duration-200 ease-out hover:w-64 hover:shadow-lift has-focus-visible:w-64 has-focus-visible:shadow-lift">
        <Link href="/" className="flex h-[72px] shrink-0 items-center gap-3 px-[18px]">
          {/* Glyph only, no filled tile: at 40px the tile read as a flat amber
              block and sat directly above the gold active-nav marker. */}
          <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center text-accent">
            <Ornament name="tree" size={28} strokeWidth={1.6} />
          </span>
          <span className="min-w-0 opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100 group-has-focus-visible/rail:opacity-100">
            <span className="block truncate font-display text-base font-semibold text-ink-900">Family Budget</span>
            {/* Which event the reader is inside, so a Christmas gift cannot be
                added to a birthday by accident. Blank on the dashboard, where
                there is no active event to name. */}
            <span className="block truncate text-[11px] font-semibold tracking-eyebrow text-gold uppercase">
              {event ? `${eventTypeMeta(event.type).icon} ${event.name}` : "Events"}
            </span>
          </span>
        </Link>

        <nav aria-label="Main navigation" className="mt-2 flex flex-col gap-1 px-3.5">
          {/* Always first, and always present: the way back out to the
              dashboard without reaching for the browser's Back button. */}
          <Link
            href={EVENTS_HOME.href}
            aria-current={activeSection === null && pathname === "/" ? "page" : undefined}
            className={cx(
              "relative flex h-12 shrink-0 items-center gap-3.5 rounded-xl pl-[11px] text-sm font-semibold whitespace-nowrap",
              pathname === "/" ? "bg-accent-soft text-accent" : "text-ink-600 hover:bg-hover-veil hover:text-ink-900",
            )}
          >
            <CalendarDays aria-hidden size={21} strokeWidth={pathname === "/" ? 2 : 1.7} className="shrink-0" />
            <span className="opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100 group-has-focus-visible/rail:opacity-100">
              {EVENTS_HOME.label}
            </span>
          </Link>

          {items.map((item) => {
            const active = item.section === activeSection;
            const Glyph = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "relative flex h-12 shrink-0 items-center gap-3.5 rounded-xl pl-[11px] text-sm font-semibold whitespace-nowrap",
                  active ? "bg-accent-soft text-accent" : "text-ink-600 hover:bg-hover-veil hover:text-ink-900",
                )}
              >
                <Glyph aria-hidden size={21} strokeWidth={active ? 2 : 1.7} className="shrink-0" />
                <span className="opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100 group-has-focus-visible/rail:opacity-100">
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        {isAdmin && (
          <p className="mt-auto mb-5 flex h-10 shrink-0 items-center gap-3.5 px-[25px] text-xs font-semibold whitespace-nowrap text-gold">
            <ShieldCheck aria-hidden size={18} strokeWidth={1.8} className="shrink-0" />
            <span className="opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100 group-has-focus-visible/rail:opacity-100">
              Global Admin
            </span>
          </p>
        )}
      </div>
    </aside>
  );
}
