import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/cn"

/**
 * shadcn's Button, speaking this app's design language.
 *
 * The structure — cva, `data-slot`, `asChild` via Radix `Slot`, the
 * focus-visible ring, the `aria-invalid` handling, the `[&_svg]` sizing rules —
 * is registry source and should stay that way; it is what the other registry
 * components (alert-dialog, dialog) rely on.
 *
 * What has been replaced is the *palette*, because a stock shadcn button on a
 * warm-paper editorial page looks like a demo dropped into someone else's app.
 * The seven product variants below are the ones the application already had;
 * shadcn's own names are kept as aliases onto the nearest product equivalent so
 * vendored components keep rendering correctly:
 *
 *   default     -> primary        destructive -> danger
 *   outline     -> secondary      link        -> unchanged
 *
 * Sizes are the product's: a 44px minimum target, because this app is used on
 * phones and every control has to be thumb-safe.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 active:scale-[0.99] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-contrast shadow-card hover:bg-accent-hover active:bg-accent-active",
        secondary:
          "border border-line-strong bg-surface text-ink-900 shadow-card hover:border-accent/40 hover:bg-surface-2",
        tonal:
          "bg-accent-soft text-accent hover:brightness-95 dark:hover:brightness-125",
        ghost: "text-ink-600 hover:bg-hover-veil hover:text-ink-900",
        danger:
          "bg-berry-strong text-white shadow-card hover:brightness-110 active:brightness-95",
        dangerGhost: "text-berry hover:bg-berry-soft",
        gold:
          "bg-gold-fill text-gold-fill-contrast shadow-card hover:brightness-105 active:brightness-95",

        // shadcn aliases, so vendored registry components stay on-brand.
        default:
          "bg-accent text-accent-contrast shadow-card hover:bg-accent-hover active:bg-accent-active",
        destructive:
          "bg-berry-strong text-white shadow-card hover:brightness-110 active:brightness-95",
        outline:
          "border border-line-strong bg-surface text-ink-900 shadow-card hover:border-accent/40 hover:bg-surface-2",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "min-h-11 rounded-lg px-3.5 text-sm font-semibold",
        md: "min-h-11 rounded-xl px-4 text-sm font-semibold",
        lg: "min-h-12 rounded-xl px-5 text-sm font-semibold sm:text-base",

        // shadcn aliases.
        default: "min-h-11 rounded-xl px-4 text-sm font-semibold",

        // Icon-only. `size-11` keeps the 44px thumb target the product uses.
        icon: "size-11 rounded-xl font-semibold",
        "icon-sm": "size-9 rounded-lg font-semibold",
        "icon-lg": "size-12 rounded-xl font-semibold",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
)

function Button({
  className,
  variant = "primary",
  size = "md",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
