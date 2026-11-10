import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { cn } from "../../lib/cn.ts";

const buttonVariants = cva(
  "type-label focus-ring group/button inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-transparent px-3 transition-colors duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-loading:cursor-progress data-loading:[&>svg:not([data-spinner])]:hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[18px]",
  {
    variants: {
      variant: {
        selection:
          "bg-primary text-primary-foreground hover:bg-selection-hover active:bg-selection-active",
        solid: "bg-ink text-surface hover:bg-ink/85 active:bg-ink/75",
        secondary: "bg-raised text-ink hover:bg-raised-hover",
        quiet:
          "text-ink-muted hover:bg-raised hover:text-ink aria-expanded:bg-raised aria-expanded:text-ink",
      },
      size: {
        default: "h-target",
        icon: "size-target px-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  },
);

export interface ButtonProps extends ButtonPrimitive.Props, VariantProps<typeof buttonVariants> {
  readonly loading?: boolean;
}

function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading ? (
        <LoaderCircle aria-hidden="true" data-spinner="" className="animate-spin" />
      ) : null}
      {children}
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };
