import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/cn"

/**
 * `default` is stock shadcn, kept for CardHeader/CardContent compositions.
 *
 * The three product tones below are flat containers — no row gap, no vertical
 * padding — because this app's cards lay their own contents out and a forced
 * 24px gap would re-space every screen. `ink` is the evergreen plate: it also
 * carries `dark`, which turns it into a theme island so everything nested
 * inside resolves against the plate rather than the page.
 */
const cardVariants = cva("rounded-2xl border", {
  variants: {
    tone: {
      default:
        "flex flex-col gap-6 rounded-xl bg-card py-6 text-card-foreground shadow-sm",
      surface: "border-line bg-surface shadow-card",
      sunken: "border-line bg-ground-sunken",
      ink: "dark border-pine-700 bg-linear-to-br from-pine-900 to-pine-800 text-white shadow-card",
    },
  },
  defaultVariants: { tone: "default" },
})

function Card({
  className,
  tone,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof cardVariants> & { asChild?: boolean }) {
  // `asChild` lets a card BE the <section> or <article> it semantically is,
  // rather than wrapping one in a decorative div.
  const Comp = asChild ? Slot.Root : "div"

  return (
    <Comp
      data-slot="card"
      data-tone={tone ?? "default"}
      className={cn(cardVariants({ tone }), className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  cardVariants,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
