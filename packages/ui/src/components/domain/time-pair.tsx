import { cn } from "../../lib/cn.ts";

const CLOCK = /^(\d{1,2}):(\d{2})$/;

export function ClockText({ text, className }: { text: string; className?: string }) {
  const match = CLOCK.exec(text);
  if (!match) {
    return <span className={cn("num", className)}>{text}</span>;
  }
  return (
    <span className={cn("num", className)}>
      {match[1]}
      <span className="punct">:</span>
      {match[2]}
    </span>
  );
}

export type TimeSize = "headline" | "row" | "passed";

const PREDICTED_CLASS: Readonly<Record<TimeSize, string>> = {
  headline: "type-display max-[640px]:text-[34px]",
  row: "type-data",
  passed: "type-data-small text-[13px] text-ink-muted",
};

const SCHEDULED_CLASS: Readonly<Record<TimeSize, string>> = {
  headline: "type-data-small text-[14px]",
  row: "type-data-small",
  passed: "type-data-small",
};

export interface TimePairProps {
  readonly predicted: string;
  readonly scheduled?: string | undefined;
  readonly size?: TimeSize;
  readonly predictedLabel?: string;
  readonly scheduledLabel?: string;
  readonly className?: string;
}

export function TimePair({
  predicted,
  scheduled,
  size = "row",
  predictedLabel,
  scheduledLabel,
  className,
}: TimePairProps) {
  const showScheduled = scheduled !== undefined && scheduled !== predicted;
  return (
    <span className={cn("inline-flex flex-col items-end", className)}>
      <span className={PREDICTED_CLASS[size]}>
        {predictedLabel ? <span className="sr-only">{predictedLabel} </span> : null}
        <ClockText text={predicted} />
      </span>
      {showScheduled ? (
        <s className={cn("mt-1 text-ink-muted decoration-1", SCHEDULED_CLASS[size])}>
          {scheduledLabel ? <span className="sr-only">{scheduledLabel} </span> : null}
          <ClockText text={scheduled} />
        </s>
      ) : null}
    </span>
  );
}
