"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { useActiveRecipientCount, useFamily } from "../family-context";
import { cx } from "./cx";
import { activeNavSection, navItemsFor } from "./nav-items";

/**
 * Mobile navigation: five tabs with the add-purchase action raised as a gold
 * FAB.
 *
 * Every href carries the event the reader is currently in, built from the URL
 * by `navItemsFor`. Tapping Owed inside Paige's Birthday cannot reach Christmas
 * Owed, because there is no bare "/owed" anywhere in this component to reach.
 * Outside an event there is nothing to navigate within, so the bar renders
 * nothing rather than offering tabs that would have to guess an event.
 */
export function BottomTabs() {
  const pathname = usePathname();
  const { eventId } = useFamily();
  const items = navItemsFor(eventId, useActiveRecipientCount());
  const activeSection = activeNavSection(pathname);

  if (!items.length) return null;

  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ground/90 pb-[max(8px,env(safe-area-inset-bottom))] backdrop-blur-md lg:hidden"
    >
      {/* Written out rather than composed: Tailwind scans source text, so a
          `grid-cols-${n}` would never be generated. An event with nobody in it
          yet has four tabs, not five. */}
      <div className={cx(
        "mx-auto grid max-w-md items-end px-2 pt-2",
        items.length === 4 ? "grid-cols-4" : "grid-cols-5",
      )}>
        {items.map((item) => {
          const active = item.section === activeSection;
          const Glyph = item.icon;

          if (item.primary) {
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-label="Add purchase"
                aria-current={active ? "page" : undefined}
                className="flex flex-col items-center gap-1"
              >
                <span
                  className={cx(
                    "-mt-7 flex h-14 w-14 items-center justify-center rounded-full border-4 border-ground bg-gold-fill text-gold-fill-contrast shadow-lift transition active:scale-95",
                    active && "ring-2 ring-accent/40",
                  )}
                >
                  <Plus aria-hidden size={24} strokeWidth={2.2} />
                </span>
                <span className={cx("text-[11px] font-semibold", active ? "text-accent" : "text-ink-600")}>
                  {item.label}
                </span>
              </Link>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className="flex min-h-12 flex-col items-center justify-end gap-1 rounded-lg py-1"
            >
              <Glyph aria-hidden size={22} strokeWidth={active ? 2 : 1.7} className={active ? "text-accent" : "text-ink-400"} />
              <span className={cx("text-[11px] font-semibold", active ? "text-accent" : "text-ink-600")}>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
