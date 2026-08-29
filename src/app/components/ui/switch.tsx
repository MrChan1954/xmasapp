"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/cn"

/**
 * THE TRACK IS 32x18. THE THING YOU TAP IS 44x44.
 *
 * Stock shadcn draws this switch at `h-[1.15rem] w-8` — 18 CSS pixels tall,
 * measured on the deployed site — and that is the right SIZE for a control
 * sitting beside a line of text. It is the wrong TARGET: 18px is below the
 * 24x24 minimum in WCAG 2.2 Target Size (AA) and less than half the 44px a
 * thumb actually needs. Both places this component is used are places a phone
 * goes — Falling snow in Your settings, and every notification category — so
 * the two people most likely to miss it are the two who use the app on a phone.
 *
 * The fix is a hit area, NOT a bigger switch: an absolutely-positioned
 * pseudo-element centred on the track, 44x44, invisible. It is out of flow, so
 * nothing around it moves and the control looks exactly as it did. Clicks on it
 * land on the button because it IS the button. The rows these sit in are taller
 * than 44px (`py-4` plus two lines of text on the notifications screen), so two
 * neighbouring targets cannot overlap.
 */
const HIT_AREA =
  "relative before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        HIT_AREA,
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
