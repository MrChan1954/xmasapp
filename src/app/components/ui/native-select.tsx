import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/cn"
import { fieldClasses } from "./input"

/**
 * A native `<select>`, wearing the product field look.
 *
 * This app deliberately prefers the native control over the Radix `Select` for
 * ordinary "pick one of these" fields:
 *
 *   - on a phone it opens the OS picker, which is a far better control than a
 *     portalled listbox and needs no scroll-locking or collision logic;
 *   - it is a real form control, so it works inside the `<label>` that `Field`
 *     wraps around it, and submits with the form;
 *   - it cannot be positioned off-screen.
 *
 * Radix `Select` (./select.tsx) is kept for the cases the native control cannot
 * express — rich option content, grouping with icons.
 *
 * The chevron is a real element rather than a `background-image` data-URI so it
 * can inherit a themed colour; `background-image` cannot reference currentColor.
 */
function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <div
      className="group/native-select relative block w-full has-[select:disabled]:opacity-50"
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(fieldClasses, "appearance-none pr-10 data-[size=sm]:h-11", className)}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-ink-600 select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  )
}

function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
