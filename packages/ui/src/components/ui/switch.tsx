import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "../../lib/cn.ts";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "focus-ring peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill border border-passed transition-colors after:absolute after:-inset-x-[calc((var(--gl-target)-34px)/2)] after:-inset-y-[calc((var(--gl-target)-18px)/2)]",
        "data-checked:border-ink data-checked:bg-ink data-unchecked:bg-raised",
        "forced-colors:border-[ButtonText] forced-colors:data-checked:border-[Highlight] forced-colors:data-checked:bg-[Highlight] forced-colors:data-unchecked:bg-[Canvas]",
        "aria-invalid:border-error data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 rounded-full bg-ink-muted transition-transform duration-150 data-checked:translate-x-[18px] data-checked:bg-surface data-unchecked:translate-x-[2px] forced-colors:bg-[ButtonText] forced-colors:data-checked:bg-[HighlightText]"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
