import { cn } from "../../lib/cn.ts";

export type StopMarkerKind = "passed" | "next" | "ahead" | "cancelled" | "plain";

const MARKER_CLASS: Readonly<Record<StopMarkerKind, string>> = {
  passed: "size-2.5 bg-passed",
  next: "size-5 bg-surface shadow-[inset_0_0_0_4px_var(--gl-primary-text)]",
  ahead: "size-2.5 bg-surface shadow-[inset_0_0_0_2px_var(--gl-primary-text)]",
  cancelled: "size-2.5 bg-surface shadow-[inset_0_0_0_2px_var(--gl-error)]",
  plain: "size-2.5 bg-surface shadow-[inset_0_0_0_2px_var(--gl-ink-muted)]",
};

export interface StopMarkerProps {
  readonly kind: StopMarkerKind;
  readonly className?: string;
}

export function StopMarker({ kind, className }: StopMarkerProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="stop-marker"
      data-kind={kind}
      className={cn(
        "relative z-10 block justify-self-center rounded-full",
        MARKER_CLASS[kind],
        className,
      )}
    />
  );
}

export type RailTone = "passed" | "ahead" | "plain";
export type RailSpan = "upper" | "lower" | "full";

const TONE_CLASS: Readonly<Record<RailTone, string>> = {
  passed: "bg-passed",
  ahead: "bg-selection-text",
  plain: "bg-hairline",
};

const SPAN_CLASS: Readonly<Record<RailSpan, string>> = {
  upper: "-top-px h-[calc(50%+2px)]",
  lower: "top-[calc(50%-1px)] -bottom-px",
  full: "-top-px -bottom-px",
};

export interface RailSegmentProps {
  readonly tone: RailTone;
  readonly span: RailSpan;
  readonly draw?: boolean;
  readonly className?: string;
}

export function RailSegment({ tone, span, draw = false, className }: RailSegmentProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="rail"
      data-tone={tone}
      className={cn(
        "absolute left-[13px] w-0.5 origin-top",
        SPAN_CLASS[span],
        TONE_CLASS[tone],
        draw && "rail-draw",
        className,
      )}
    />
  );
}
