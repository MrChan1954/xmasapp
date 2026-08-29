import * as React from "react"

import { cn } from "@/lib/cn"

/**
 * The product field look, on shadcn's Input.
 *
 * `text-base` (16px) is deliberate and must not be reduced on small screens:
 * iOS Safari zooms the viewport when a focused input's text is under 16px, and
 * the page never zooms back out. shadcn's stock `md:text-sm` is dropped for
 * that reason.
 *
 * The focus treatment is the app's — a soft 4px accent halo rather than
 * shadcn's 3px ring — so a field matches the buttons beside it.
 */
export const fieldClasses =
  "h-12 w-full min-w-0 rounded-xl border border-line-strong bg-surface px-3.5 text-base text-ink-900 shadow-card outline-none transition-[color,box-shadow,border-color] selection:bg-accent selection:text-accent-contrast placeholder:text-ink-400 focus:border-accent/60 focus:ring-4 focus:ring-accent/20 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-600 aria-invalid:border-berry aria-invalid:ring-berry/20"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        fieldClasses,
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink-900",
        className
      )}
      {...props}
    />
  )
}

export { Input }
