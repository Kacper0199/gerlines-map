import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon } from "lucide-react";
import { cn } from "../../lib/cn.ts";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "focus-ring peer relative flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border border-passed bg-raised transition-colors after:absolute after:-inset-[calc((var(--gl-target)-16px)/2)]",
        "data-checked:border-ink data-checked:bg-ink data-checked:text-surface forced-colors:data-checked:border-[Highlight] forced-colors:data-checked:bg-[Highlight] forced-colors:data-checked:text-[HighlightText]",
        "aria-invalid:border-error disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current [&>svg]:size-3.5"
      >
        <CheckIcon strokeWidth={3} aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
