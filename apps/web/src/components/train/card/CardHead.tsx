import { useCopy } from "@gerlines/i18n/react";
import { Badge, CategoryMark, cn, DelayValue } from "@gerlines/ui";
import { type ReactNode, useRef } from "react";
import { useCardHeadingFocus } from "../../../a11y/card-focus.ts";
import type { ShortRun, TrainCardModel } from "../model.ts";

export interface TitleWords {
  readonly line: (line: string) => string;
  readonly trainNumber: (number: string) => string;
}

/** The title as the card writes it: a bare number is never a title, it reads Train 541 or Line 527. */
export function trainTitle(model: TrainCardModel, words: TitleWords, fallback: string): string {
  if (model.title === null) {
    return fallback;
  }
  switch (model.titleKind) {
    case "line":
      return words.line(model.title);
    case "number":
      return words.trainNumber(model.title);
    default:
      return model.title;
  }
}

/** One long word (Lößnitzgrundbahn) must fit the title column, so the size steps down with its length. */
export function titleSizeClass(title: string): string {
  const longest = title.split(/\s+/).reduce((most, word) => Math.max(most, word.length), 0);
  if (longest >= 17) {
    return "text-[20px]";
  }
  if (longest >= 13) {
    return "text-[22px] sm:text-[24px]";
  }
  return "text-[28px] sm:text-[32px]";
}

function RealtimeCaption({ model }: { model: TrainCardModel }) {
  const copy = useCopy();
  if (!model.realtime) {
    return (
      <span className="type-caption inline-flex items-center gap-1.5 text-ink-muted">
        <span
          aria-hidden="true"
          className="size-2 rounded-full shadow-[inset_0_0_0_2px_var(--gl-ink-muted)]"
        />
        {copy.card.timetableOnly}
      </span>
    );
  }
  return (
    <span className="type-caption inline-flex items-center gap-1.5 text-ink-muted">
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full",
          model.stale ? "shadow-[inset_0_0_0_2px_var(--gl-ink-muted)]" : "bg-ink",
        )}
      />
      {model.stale ? copy.live.stale : copy.card.realtime}
    </span>
  );
}

function useBadgeText(model: TrainCardModel): string {
  const copy = useCopy();
  switch (model.badge) {
    case "named":
      return copy.categories[model.category].badge;
    case "bus":
    case "urban":
      return copy.train.badge[model.badge];
    default:
      return copy.card.train;
  }
}

export function CategoryBadge({ model }: { model: TrainCardModel }) {
  const train = useCopy().train;
  const badge = useBadgeText(model);
  return (
    <span className="type-label flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ink-muted">
      <span className="inline-flex min-w-0 items-center gap-2">
        <CategoryMark category={model.category} size={12} />
        <span className="min-w-0 whitespace-nowrap">{badge}</span>
      </span>
      {model.added ? (
        <Badge variant="outline" className="h-5 px-2 text-[11px] text-ink-muted">
          {train.added}
        </Badge>
      ) : null}
    </span>
  );
}

function TitleBlock({
  model,
  peek,
  headingId,
}: {
  model: TrainCardModel;
  peek: boolean;
  headingId: string | undefined;
}) {
  const copy = useCopy();
  const train = useCopy().train;
  const { subtitle } = model;
  const subtitleText = subtitle
    ? subtitle.kind === "line"
      ? train.line(subtitle.value)
      : train.trainNumber(subtitle.value)
    : null;
  const title = trainTitle(model, train, copy.card.train);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useCardHeadingFocus(headingRef);
  const heading = (
    <h2
      id={headingId}
      ref={headingRef}
      tabIndex={-1}
      className={cn("type-headline min-w-0 wrap-anywhere outline-none", titleSizeClass(title))}
    >
      {title}
    </h2>
  );
  if (peek) {
    return (
      <div className="col-start-1 flex min-w-0 flex-wrap items-baseline gap-x-2 self-start">
        {heading}
        {subtitle?.kind === "number" ? (
          <span className="type-label font-normal text-ink-muted">{subtitleText}</span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="col-start-1 flex min-w-0 flex-col self-start">
      {heading}
      {subtitleText ? (
        <span className="type-label mt-1 font-normal text-ink-muted">{subtitleText}</span>
      ) : null}
    </div>
  );
}

/**
 * The delay in a card head; `now` writes the muted word Now before a delay that is the live tick's
 * current one rather than a stop's.
 */
export function HeadDelay({
  minutes,
  now,
  realtime,
}: {
  minutes: number | null;
  now: boolean;
  realtime: boolean;
}) {
  const copy = useCopy();
  return (
    <span className="inline-flex items-baseline gap-2">
      {now ? (
        <>
          <span className="type-label font-normal text-ink-muted">{copy.card.now}</span>{" "}
        </>
      ) : null}
      <DelayValue
        minutes={minutes}
        labels={copy.delay}
        className={realtime ? "" : "text-ink-muted"}
      />
    </span>
  );
}

function DelaySlot({ model, peek, row }: { model: TrainCardModel; peek: boolean; row: string }) {
  const train = useCopy().train;
  if (model.cancelled) {
    return (
      <div className={cn("col-start-2 flex flex-col items-end self-start pt-1", row)}>
        <Badge variant="error" className="h-7 px-3">
          {train.cancelled}
        </Badge>
      </div>
    );
  }
  const showCaption = !peek || !model.realtime || model.stale;
  return (
    <div
      className={cn(
        "col-start-2 flex flex-col items-end justify-end gap-1 self-end text-right",
        row,
      )}
    >
      <HeadDelay minutes={model.delayMinutes} now={model.delayNow} realtime={model.realtime} />
      {showCaption ? <RealtimeCaption model={model} /> : null}
    </div>
  );
}

export function ShortRunNote({ shortRun }: { shortRun: ShortRun }) {
  const train = useCopy().train;
  return (
    <p className="type-label flex items-baseline gap-2 text-ink">
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 translate-y-[-2px] rounded-full bg-error"
      />
      <span className="min-w-0 wrap-break-word">
        {shortRun.kind === "ends-early"
          ? train.endsEarly(shortRun.cancelled, shortRun.stop.name)
          : train.stopsCancelled(shortRun.cancelled)}
      </span>
    </p>
  );
}

export function CardHead({
  model,
  peek,
  closeSlot,
  showBadge = true,
  headingId,
}: {
  model: TrainCardModel;
  peek: boolean;
  closeSlot: ReactNode;
  showBadge?: boolean;
  headingId?: string;
}) {
  const copy = useCopy();
  const train = useCopy().train;
  return (
    <header className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4">
      {showBadge ? (
        <div
          className={cn(
            "col-span-2 flex items-center justify-between gap-2",
            closeSlot ? "min-h-target" : "pb-1",
          )}
        >
          <CategoryBadge model={model} />
          {closeSlot}
        </div>
      ) : null}
      <TitleBlock model={model} peek={peek} headingId={headingId} />
      <DelaySlot model={model} peek={peek} row={showBadge ? "row-start-2" : "row-start-1"} />
      <p className={cn("type-body-strong col-span-2 wrap-break-word", peek ? "mt-1" : "mt-2")}>
        {train.to(model.destination)}
        {model.destinationNote ? ` (${model.destinationNote})` : ""}
      </p>
      {model.shortRun ? (
        <div className="col-span-2 mt-1">
          <ShortRunNote shortRun={model.shortRun} />
        </div>
      ) : null}
      {model.notDrawn ? (
        <p className="type-body col-span-2 mt-1 text-ink">{copy.card.notDrawn}</p>
      ) : null}
      {peek ? null : (
        <p className="type-body col-span-2 text-ink-muted">
          {model.operator ?? `${copy.card.operator}: ${copy.card.operatorMissing}`}
        </p>
      )}
    </header>
  );
}
