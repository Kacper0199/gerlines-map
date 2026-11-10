import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const FIELD_BASE =
  "focus-ring h-target w-full min-w-0 rounded-lg border border-hairline bg-raised px-3 text-base text-ink transition-colors placeholder:text-ink-muted hover:border-passed disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-error max-[640px]:text-base min-[641px]:text-[14px]";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(FIELD_BASE, className)}
      {...props}
    />
  );
}

export { FIELD_BASE, Input };
