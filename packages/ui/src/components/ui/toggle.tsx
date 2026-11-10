import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

const toggleVariants = cva(
  "type-label focus-ring inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-ink-muted transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-ink aria-pressed:text-surface forced-colors:aria-pressed:underline forced-colors:aria-pressed:decoration-2 forced-colors:aria-pressed:underline-offset-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[18px]",
  {
    variants: {
      size: {
        default: "h-target min-w-target px-2",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Toggle({
  className,
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ size }), className)}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
