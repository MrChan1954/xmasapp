"use client";

import { ThemeProvider as NextThemeProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * Single place the theme configuration lives. The app follows the operating
 * system and offers no manual override.
 *
 * next-themes still does the work rather than a bare `prefers-color-scheme`
 * media query, for two reasons: the `dark:` variant is bound to the `.dark`
 * class (`@custom-variant dark` in globals.css), and its pre-paint script sets
 * that class before first paint, so there is no flash of the wrong theme.
 *
 * The storage key is deliberately new. Nothing writes it now that the picker is
 * gone, but the previous key may still hold an explicit "light"/"dark" from
 * before this change — reusing it would let that stale choice keep overriding
 * the system setting forever. Reading a key nobody writes always resolves to
 * `defaultTheme`, i.e. system.
 *
 * `disableTransitionOnChange` is not cosmetic here: globals.css puts a 150ms
 * transition on every button/link/input, so without it a system theme flip
 * animates several hundred elements at once.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="xmas-theme-system"
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}
