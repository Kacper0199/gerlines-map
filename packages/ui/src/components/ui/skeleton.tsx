import type * as React from "react";
import { cn } from "../../lib/cn.ts";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-raised", className)}
      {...props}
    />
  );
}

export { Skeleton };
