import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

const badgeVariants = cva(
  "type-label inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-pill border px-2.5 [&>svg]:pointer-events-none [&>svg]:size-3.5",
  {
    variants: {
      variant: {
        default: "border-transparent bg-raised text-ink",
        outline: "border-hairline text-ink",
        muted: "border-transparent bg-raised text-ink-muted",
        error: "border-error text-ink before:size-2 before:rounded-full before:bg-error",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">({ className: cn(badgeVariants({ variant }), className) }, props),
    render,
    state: { slot: "badge", variant },
  });
}

export { Badge, Badge as StatusChip, badgeVariants };
