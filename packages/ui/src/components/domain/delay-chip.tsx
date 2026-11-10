import { cn } from "../../lib/cn.ts";

const MINUS = "−";

export function delayChipText(minutes: number | null): string | null {
  if (minutes === null) {
    return null;
  }
  return minutes < 0 ? `${MINUS}${-minutes}` : `+${minutes}`;
}

export interface DelayChipProps {
  readonly minutes: number | null;
  readonly label?: string;
  readonly className?: string;
}

export function DelayChip({ minutes, label, className }: DelayChipProps) {
  const text = delayChipText(minutes);
  if (text === null) {
    return null;
  }
  return (
    <span
      data-slot="delay-chip"
      className={cn("num type-data-small inline-block text-[13px] text-ink-muted", className)}
    >
      {label ? <span className="sr-only">{label} </span> : null}
      {text}
    </span>
  );
}
