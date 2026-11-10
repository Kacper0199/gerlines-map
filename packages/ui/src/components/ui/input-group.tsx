import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Button } from "./button.tsx";
import { FIELD_BASE, Input } from "./input.tsx";

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        FIELD_BASE,
        "group/input-group relative flex items-center gap-2 px-0 has-[[data-slot=input-group-control]:focus-visible]:outline-2 has-[[data-slot=input-group-control]:focus-visible]:outline-offset-2 has-[[data-slot=input-group-control]:focus-visible]:outline-focus data-invalid:border-error has-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-full select-none items-center justify-center gap-2 text-ink-muted [&>svg:not([class*='size-'])]:size-[18px]",
  {
    variants: {
      align: {
        "inline-start": "pointer-events-none absolute inset-y-0 left-3",
        "inline-end": "order-last pr-1",
      },
    },
    defaultVariants: { align: "inline-start" },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      {...props}
    />
  );
}

function InputGroupButton({
  className,
  type = "button",
  variant = "quiet",
  size = "icon",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      type={type}
      variant={variant}
      size={size}
      className={cn("-my-px -mr-px rounded-md", className)}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "h-full flex-1 rounded-none border-0 bg-transparent px-0 hover:border-0 focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput };
