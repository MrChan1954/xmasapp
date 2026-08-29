import * as React from "react"

import { cn } from "@/lib/cn"
import { fieldClasses } from "./input"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClasses, "field-sizing-content h-auto min-h-24 resize-y py-3 leading-6", className)}
      {...props}
    />
  )
}

export { Textarea }
