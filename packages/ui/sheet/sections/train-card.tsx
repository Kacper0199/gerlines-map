import { LocateFixed, Route, Share2, X } from "lucide-react";
import {
  Button,
  CategoryMark,
  ClockText,
  cn,
  DelayValue,
  IconButton,
  SheetMore,
  TimePair,
  useSheetState,
} from "../../src/index.ts";
import { SAMPLE, type SheetStrings } from "../strings.ts";

function RouteStrip({ strings, compact }: { strings: SheetStrings; compact: boolean }) {
  return (
    <ol className={cn("px-4", compact ? "pb-0" : "pb-2")}>
      {compact ? null : (
        <li className="relative grid min-h-8 grid-cols-[28px_1fr_auto] items-center gap-x-2 py-1 text-ink-muted">
          <span className="absolute top-1/2 bottom-0 left-[13px] w-0.5 bg-passed" />
          <span className="relative z-10 size-2.5 justify-self-center rounded-full bg-passed" />
          <span className="type-body">{SAMPLE.passedStop}</span>
          <ClockText text={SAMPLE.passedTime} className="type-data-small text-[13px]" />
        </li>
      )}
      <li
        className="relative grid grid-cols-[28px_1fr] items-center gap-x-2"
        style={{ height: compact ? 68 : 84, ["--p" as string]: compact ? "52%" : "78%" }}
      >
        <span className="absolute top-0 left-[13px] h-(--p) w-0.5 bg-passed" />
        <span className="absolute top-(--p) bottom-0 left-[13px] w-0.5 bg-selection-text" />
        <span className="absolute top-(--p) left-[7px] z-10 size-3.5 -translate-y-1/2 rounded-full bg-selection-text shadow-[0_0_0_3px_var(--gl-surface)] transition-[top] duration-(--gl-duration-glide) ease-(--gl-ease-out)" />
        <span className="type-label absolute top-(--p) left-9 -translate-y-1/2">
          {strings.nowLabel}
          <small className="type-caption block font-normal text-ink-muted">
            {strings.toNextStop}
          </small>
        </span>
      </li>
      <li
        className="relative grid grid-cols-[28px_1fr_auto] items-center gap-x-2"
        style={{ minHeight: compact ? 60 : 88 }}
      >
        <span className="absolute top-0 left-[13px] h-1/2 w-0.5 bg-selection-text" />
        <span className="relative z-10 size-5 justify-self-center rounded-full bg-surface shadow-[inset_0_0_0_4px_var(--gl-primary-text)]" />
        <div className="flex min-w-0 flex-col">
          <span className="type-caption text-ink-muted">{strings.nextStop}</span>
          <span className="type-title">{SAMPLE.stop}</span>
          <span className="type-body-strong">{strings.platformChanged}</span>
        </div>
        <TimePair
          size="headline"
          predicted={SAMPLE.predicted}
          scheduled={SAMPLE.scheduled}
          predictedLabel={strings.predicted}
          scheduledLabel={strings.scheduled}
        />
      </li>
    </ol>
  );
}

export function CategoryLabel({ strings }: { strings: SheetStrings }) {
  return (
    <span className="type-label flex items-center gap-2 text-ink-muted">
      <CategoryMark category="hsr" size={12} />
      <span>{strings.categoryBadge}</span>
    </span>
  );
}

export function CloseButton({ strings }: { strings: SheetStrings }) {
  return (
    <IconButton label={strings.close}>
      <X aria-hidden="true" />
    </IconButton>
  );
}

export function TrainCardSpecimen({
  strings,
  compact = false,
  inSheet = false,
}: {
  strings: SheetStrings;
  compact?: boolean;
  inSheet?: boolean;
}) {
  return (
    <article
      aria-label={strings.trainTitle}
      className={cn("relative flex min-w-0 flex-col", compact ? "gap-0 pb-1" : "gap-3 pb-4")}
    >
      <header className="grid grid-cols-[1fr_auto] gap-x-3 px-4">
        {inSheet ? (
          <div className={cn("col-span-2", compact ? "pt-0" : "pt-1")}>
            <CategoryLabel strings={strings} />
          </div>
        ) : (
          <div className="col-span-2 flex items-center justify-between">
            <CategoryLabel strings={strings} />
            <div className="-mr-3">
              <CloseButton strings={strings} />
            </div>
          </div>
        )}
        <h3 className="type-headline col-start-1 self-end text-[28px] sm:text-[32px]">
          {SAMPLE.line}
        </h3>
        <div className="col-start-2 flex flex-col items-end gap-1 text-right">
          <DelayValue minutes={SAMPLE.delayMinutes} labels={strings.delay} />
          {compact ? null : (
            <span className="type-caption inline-flex items-center gap-1.5 text-ink-muted">
              <span aria-hidden="true" className="size-2 rounded-full bg-ink" />
              {strings.realtimeState}
            </span>
          )}
        </div>
        <p className={cn("type-body-strong col-span-2", compact ? "mt-0" : "mt-2")}>
          {SAMPLE.destination}
        </p>
        {compact ? null : <p className="type-body col-span-2 text-ink-muted">{SAMPLE.operator}</p>}
      </header>
      <RouteStrip strings={strings} compact={compact} />
      <div className={cn("flex gap-2 px-4", compact ? "mt-3" : "mt-auto")}>
        <Button variant="selection" className="flex-1">
          <LocateFixed aria-hidden="true" />
          {strings.follow}
        </Button>
        <Button variant="secondary" className="flex-1">
          <Route aria-hidden="true" />
          {strings.route}
        </Button>
        <Button variant="secondary" className="flex-1">
          <Share2 aria-hidden="true" />
          {strings.share}
        </Button>
      </div>
    </article>
  );
}

export function SheetBody({ strings }: { strings: SheetStrings }) {
  const peek = useSheetState() === "peek";
  return (
    <>
      <TrainCardSpecimen strings={strings} compact={peek} inSheet />
      <SheetMore>
        <p className="type-caption border-t px-4 py-3 text-ink-muted">
          {strings.positionEstimated}
        </p>
      </SheetMore>
    </>
  );
}
