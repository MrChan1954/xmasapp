"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { cx } from "./cx";
import { navItems } from "./nav-items";

/** Mobile navigation: five tabs with the add-purchase action raised as a gold FAB. */
export function BottomTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ground/90 pb-[max(8px,env(safe-area-inset-bottom))] backdrop-blur-md lg:hidden"
    >
      <div className="mx-auto grid max-w-md grid-cols-5 items-end px-2 pt-2">
        {navItems.map((item) => {
          const active = item.match(pathname);
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
