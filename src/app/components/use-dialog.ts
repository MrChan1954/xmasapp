"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Modal behaviour shared by `Modal` and `Sheet`: focus the panel, trap Tab
 * inside it, close on Escape, lock body scroll, and return focus to whatever
 * was focused before.
 */
export function useDialogBehaviour(
  panel: RefObject<HTMLElement | null>,
  { onClose, dismissible }: { onClose: () => void; dismissible: boolean },
) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    panel.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) onClose();
      if (event.key === "Tab" && panel.current) {
        const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
          .filter((element) => element.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === panel.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [dismissible, onClose, panel]);
}
