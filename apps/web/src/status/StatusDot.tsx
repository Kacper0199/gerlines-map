import type { DataSourceState } from "@gerlines/schema/status";
import { cn } from "@gerlines/ui";

/** Filled ink when fresh, hollow when stale or not recorded, the error colour when down. */
export function StatusDot({ state, className }: { state: DataSourceState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-state={state}
      className={cn(
        "size-2 shrink-0 rounded-full",
        state === "ok" && "bg-ink",
        state === "down" && "bg-error",
        (state === "stale" || state === "not_recorded") &&
          "shadow-[inset_0_0_0_2px_var(--gl-ink-muted)]",
        className,
      )}
    />
  );
}
