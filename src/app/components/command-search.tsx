"use client";

import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatPennies } from "@/lib/currency";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath } from "@/lib/events.ts";
import { useFamily } from "../family-context";
import { cx } from "./cx";
import { navItemsFor } from "./nav-items";
import { Button, Modal, ModalTitle } from "./ui";

type Result = { key: string; label: string; hint?: string; href: string; group: "People" | "Go to" };

/** Compact affordance in the top bar. Widens to a full field where there is room. */
export function SearchTrigger({ className = "", onOpen }: { className?: string; onOpen: () => void }) {
  return (
    <Button
      variant="secondary"
      onClick={onOpen}
      className={cx(
        "border-line bg-surface-2 px-3 font-normal text-ink-400 shadow-none hover:text-ink-600",
        className,
      )}
    >
      <Search aria-hidden size={16} strokeWidth={1.8} className="shrink-0" />
      <span className="hidden sm:inline">Search</span>
      <kbd className="ml-6 hidden rounded-md border border-line px-1.5 py-0.5 font-sans text-[11px] font-semibold text-ink-400 lg:inline">
        Ctrl K
      </kbd>
    </Button>
  );
}

/**
 * Ctrl/Cmd-K palette over the people list and the app's routes. Reuses `Modal`
 * so focus trapping, Esc and scroll locking behave exactly like every other
 * dialog in the app.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounting only while open means the query resets naturally, with no effect
  // reaching in to clear it.
  return open ? <CommandPalettePanel onClose={onClose} /> : null;
}

function CommandPalettePanel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { people, eventId } = useFamily();
  const [query, setQuery] = useState("");

  const results = useMemo<Result[]>(() => {
    const needle = query.trim().toLowerCase();
    const matchedPeople = people
      .filter((person) => person.active && (!needle || person.name.toLowerCase().includes(needle)))
      .slice(0, 6)
      .map<Result>((person) => ({
        key: `person-${person.id}`,
        label: person.name,
        hint: `${formatPennies(person.budgetPennies)} budget`,
        href: `${eventPath(eventId ?? "", "people") ?? "/"}?person=${encodeURIComponent(person.id)}`,
        group: "People",
      }));

    // Event-scoped destinations only exist while the reader is inside an event;
    // on the dashboard the palette offers people and nothing to jump to.
    const matchedRoutes = navItemsFor(eventId)
      .filter((item) => !needle || item.label.toLowerCase().includes(needle))
      .map<Result>((item) => ({ key: `route-${item.href}`, label: item.label, href: item.href, group: "Go to" }));

    return [...matchedPeople, ...matchedRoutes];
  }, [eventId, people, query]);

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  return (
    <Modal labelledBy="command-palette-title" onClose={onClose} size="md" surface="surface" className="sm:mt-0">
      <ModalTitle id="command-palette-title" className="sr-only">Search</ModalTitle>
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <Search aria-hidden size={18} strokeWidth={1.8} className="shrink-0 text-ink-400" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results[0]) go(results[0].href);
          }}
          placeholder="Search people and pages"
          aria-label="Search people and pages"
          className="h-8 min-w-0 flex-1 bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
        />
      </div>

      <div className="max-h-[55dvh] overflow-y-auto p-2">
        {results.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-ink-600">Nothing matches “{query}”.</p>
        )}
        {(["People", "Go to"] as const).map((group) => {
          const items = results.filter((result) => result.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="pb-1">
              <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-eyebrow text-ink-400 uppercase">{group}</p>
              {items.map((result) => (
                <Button
                  key={result.key}
                  variant="ghost"
                  onClick={() => go(result.href)}
                  className="flex w-full items-center justify-between gap-3 px-3 text-left text-ink-700 hover:text-ink-900"
                >
                  <span className="truncate">{result.label}</span>
                  {result.hint && <span className="shrink-0 text-xs font-medium tabular-nums text-ink-400">{result.hint}</span>}
                </Button>
              ))}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/** Owns the open state plus the keyboard shortcut, so `TopBar` stays declarative. */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return { open, setOpen };
}
