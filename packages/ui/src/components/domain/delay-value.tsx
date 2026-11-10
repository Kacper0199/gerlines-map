import { cn } from "../../lib/cn.ts";

export interface DelayLabels {
  readonly onTime: string;
  readonly noData: string;
  readonly minutes: string;
  readonly early: string;
}

export type DelaySize = "headline" | "inline";

export interface DelayParts {
  readonly value: string;
  readonly unit: string | undefined;
  readonly numeric: boolean;
}

export function delayParts(minutes: number | null, labels: DelayLabels): DelayParts {
  if (minutes === null) {
    return { value: labels.noData, unit: undefined, numeric: false };
  }
  if (minutes === 0) {
    return { value: labels.onTime, unit: undefined, numeric: false };
  }
  return minutes > 0
    ? { value: `+${minutes}`, unit: labels.minutes, numeric: true }
    : { value: String(-minutes), unit: labels.early, numeric: true };
}

const SIZE_CLASS: Readonly<Record<DelaySize, string>> = {
  headline: "text-[28px] leading-none font-semibold max-[640px]:text-[24px]",
  inline: "type-body-strong",
};

export interface DelayValueProps {
  readonly minutes: number | null;
  readonly labels: DelayLabels;
  readonly size?: DelaySize;
  readonly className?: string;
}

export function DelayValue({ minutes, labels, size = "headline", className }: DelayValueProps) {
  const { value, unit, numeric } = delayParts(minutes, labels);
  return (
    <span className={cn("inline-block text-ink", SIZE_CLASS[size], className)}>
      <span className={numeric ? "num" : undefined}>{value}</span>
      {unit ? <span className="type-body-strong ml-1">{unit}</span> : null}
    </span>
  );
}
