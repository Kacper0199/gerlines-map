import { useCopy, useFormatters } from "@gerlines/i18n/react";
import {
  cn,
  DelayChip,
  RailSegment,
  StopMarker,
  type StopMarkerKind,
  TimePair,
  type TimeSize,
} from "@gerlines/ui";
import { minutesUntil } from "../../../minutes.ts";
import { type Platform, type StopRow, type TrainCardModel, timeOf } from "../model.ts";
import {
  type HeadlineLabel,
  type StripMode,
  type StripRow,
  stripRows,
  type Tone,
} from "../strip-rows.ts";

export type StopSelectHandler = (stop: StopRow) => void;

function Rails({ upper, lower }: { upper: Tone; lower: Tone }) {
  return (
    <>
      {upper === "none" ? null : <RailSegment tone={upper} span="upper" draw={upper === "ahead"} />}
      {lower === "none" ? null : <RailSegment tone={lower} span="lower" draw={lower === "ahead"} />}
    </>
  );
}

const TRACK = "\uE000";
const WAS = "\uE001";

export function PlatformText({ platform }: { platform: Platform }) {
  const copy = useCopy();
  const text =
    platform.was === null ? copy.card.platform(TRACK) : copy.card.platformChanged(TRACK, WAS);
  return (
    <>
      {text.split(/(\uE000|\uE001)/).map((part, i) => {
        const key = `${i}-${part}`;
        if (part === TRACK) {
          return (
            <span key={key} className="num">
              {platform.track}
            </span>
          );
        }
        if (part === WAS && platform.was !== null) {
          return (
            <span key={key} className="num">
              {platform.was}
            </span>
          );
        }
        return part;
      })}
    </>
  );
}

const ROW_BUTTON =
  "cursor-pointer text-left decoration-1 underline-offset-[3px] outline-none hover:underline after:absolute after:inset-x-[-4px] after:inset-y-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-focus";

function StopName({
  stop,
  onSelect,
  className,
}: {
  stop: StopRow;
  onSelect: StopSelectHandler | undefined;
  className: string;
}) {
  if (!onSelect) {
    return <span className={cn("block wrap-break-word", className)}>{stop.name}</span>;
  }
  return (
    <button
      type="button"
      data-stop-index={stop.index}
      onClick={() => onSelect(stop)}
      className={cn("block max-w-full wrap-break-word", ROW_BUTTON, className)}
    >
      {stop.name}
    </button>
  );
}

function DayMarker({ offset }: { offset: number }) {
  const train = useCopy().train;
  if (offset <= 0) {
    return null;
  }
  return (
    <span className="num type-data-small ml-0.5 self-start text-[11px] text-ink-muted">
      <span aria-hidden="true">+{offset}</span>
      <span className="sr-only">{train.dayLater(offset)}</span>
    </span>
  );
}

function StopTime({ stop, size }: { stop: StopRow; size: TimeSize }) {
  const { clock } = useFormatters();
  const train = useCopy().train;
  const shown = timeOf(stop.main);
  if (shown === null) {
    return null;
  }
  const { predictedMs, scheduledMs } = stop.main;
  return (
    <span className="inline-flex items-start justify-end">
      <TimePair
        size={size}
        predicted={clock(shown)}
        scheduled={predictedMs !== null && scheduledMs !== null ? clock(scheduledMs) : undefined}
        predictedLabel={predictedMs !== null ? train.expected : train.scheduled}
        scheduledLabel={train.scheduled}
      />
      <DayMarker offset={stop.dayOffset} />
    </span>
  );
}

function CancelledTag() {
  const train = useCopy().train;
  return (
    <span className="type-caption inline-flex items-center gap-1.5 text-ink">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-error" />
      {train.stopCancelled}
    </span>
  );
}

interface RowProps {
  readonly row: StripRow & { readonly stop: StopRow };
  readonly onSelect: StopSelectHandler | undefined;
}

function marker(stop: StopRow, fallback: StopMarkerKind): StopMarkerKind {
  return stop.cancelled ? "cancelled" : fallback;
}

function PassedRow({ row, onSelect }: RowProps) {
  const { stop } = row;
  const { platform } = stop;
  const train = useCopy().train;
  return (
    <li
      data-role="passed"
      className="relative grid min-h-target grid-cols-[28px_minmax(0,1fr)_auto_2.5rem] items-center gap-x-2 py-[3px] text-ink-muted"
    >
      <Rails upper={row.upper} lower={row.lower} />
      <StopMarker kind={marker(stop, "passed")} />
      <div className="min-w-0">
        <StopName stop={stop} onSelect={onSelect} className="type-body" />
        {stop.cancelled ? <CancelledTag /> : null}
        {platform && !stop.cancelled ? (
          <span className="type-caption block">
            <PlatformText platform={platform} />
          </span>
        ) : null}
      </div>
      <StopTime stop={stop} size="passed" />
      <span className="text-right">
        {stop.cancelled ? null : (
          <DelayChip minutes={stop.delayMinutes || null} label={train.delay} />
        )}
      </span>
    </li>
  );
}

function UpcomingRow({ row, onSelect }: RowProps) {
  const { stop } = row;
  const { platform } = stop;
  const train = useCopy().train;
  return (
    <li
      data-role="ahead"
      className="relative grid min-h-11 grid-cols-[28px_minmax(0,1fr)_auto_2.5rem] items-center gap-x-2 py-[5px]"
    >
      <Rails upper={row.upper} lower={row.lower} />
      <StopMarker kind={marker(stop, "ahead")} />
      <div className="min-w-0">
        <StopName
          stop={stop}
          onSelect={onSelect}
          className={stop.cancelled ? "type-body text-ink-muted" : "type-body-strong"}
        />
        {stop.cancelled ? <CancelledTag /> : null}
        {platform && !stop.cancelled ? (
          <span
            className={cn(
              "type-caption block",
              platform.was ? "font-semibold text-ink" : "text-ink-muted",
            )}
          >
            <PlatformText platform={platform} />
          </span>
        ) : null}
      </div>
      <StopTime stop={stop} size={stop.cancelled ? "passed" : "row"} />
      <span className="text-right">
        {stop.cancelled ? null : (
          <DelayChip minutes={stop.delayMinutes || null} label={train.delay} />
        )}
      </span>
    </li>
  );
}

function PlainRow({ row, onSelect }: RowProps) {
  return (
    <li className="relative grid min-h-11 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-2 py-[5px] text-ink-muted">
      <Rails upper={row.upper} lower={row.lower} />
      <StopMarker kind="plain" />
      <StopName stop={row.stop} onSelect={onSelect} className="type-body" />
      <StopTime stop={row.stop} size="passed" />
    </li>
  );
}

function NowRow({
  progress,
  arrivalMs,
  nowMs,
  compact,
  showPassed,
}: {
  progress: number;
  arrivalMs: number;
  nowMs: number;
  compact: boolean;
  showPassed: boolean;
}) {
  const copy = useCopy();
  const percent = `${Math.round(progress * 1000) / 10}%`;
  return (
    <li
      className={cn(
        "relative grid grid-cols-[28px_1fr] items-center gap-x-2",
        compact ? "h-[68px]" : "h-[84px]",
      )}
      data-slot="between"
      style={{ ["--p" as string]: percent }}
    >
      {showPassed ? (
        <span
          aria-hidden="true"
          className="absolute -top-px left-[13px] h-[calc(var(--p)+1px)] w-0.5 bg-passed"
        />
      ) : null}
      <span
        aria-hidden="true"
        className="rail-draw absolute top-(--p) -bottom-px left-[13px] w-0.5 origin-top bg-selection-text"
      />
      <span
        aria-hidden="true"
        data-slot="progress-dot"
        className="absolute top-[clamp(9px,var(--p),calc(100%-9px))] left-[7px] z-10 size-3.5 -translate-y-1/2 rounded-full bg-selection-text shadow-[0_0_0_3px_var(--gl-surface)] transition-[top] duration-(--gl-duration-glide) ease-(--gl-ease-out)"
      />
      <span className="type-label absolute top-[clamp(24px,var(--p),calc(100%-24px))] left-9 -translate-y-1/2 transition-[top] duration-(--gl-duration-glide) ease-(--gl-ease-out)">
        {copy.card.now}
        <small className="type-caption block font-normal text-ink-muted">
          {copy.card.toNextStop(minutesUntil(arrivalMs, nowMs))}
        </small>
      </span>
    </li>
  );
}

function useHeadlineText(): (
  label: HeadlineLabel,
  stop: StopRow,
) => { label: string; detail?: string } {
  const copy = useCopy();
  const { clock } = useFormatters();
  return (label, stop) => {
    const departure = timeOf(stop.departure);
    const detail = departure === null ? undefined : copy.card.departsAt(clock(departure));
    switch (label) {
      case "next":
        return { label: copy.card.nextStop };
      case "arrived":
        return { label: copy.card.arrived };
      case "at":
        return detail ? { label: copy.card.atStop, detail } : { label: copy.card.atStop };
      default:
        return detail ? { label: copy.card.notDeparted, detail } : { label: copy.card.notDeparted };
    }
  };
}

function HeadlineRow({
  row,
  onSelect,
  compact,
  label,
}: RowProps & { compact: boolean; label: HeadlineLabel }) {
  const { stop } = row;
  const { platform } = stop;
  const text = useHeadlineText()(label, stop);
  return (
    <li
      data-role="headline"
      className={cn(
        "relative grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-2",
        compact ? "min-h-[60px] py-1" : "min-h-[88px] py-3",
      )}
    >
      <Rails upper={row.upper} lower={row.lower} />
      <StopMarker kind="next" />
      <div className="flex min-w-0 flex-col">
        <span className="type-caption text-ink-muted">{text.label}</span>
        <StopName stop={stop} onSelect={onSelect} className="type-title" />
        {platform ? (
          <span className="type-body-strong">
            <PlatformText platform={platform} />
          </span>
        ) : null}
        {text.detail ? <span className="type-caption text-ink-muted">{text.detail}</span> : null}
      </div>
      <StopTime stop={stop} size="headline" />
    </li>
  );
}

function Row({
  row,
  nowMs,
  compact,
  onSelect,
}: {
  row: StripRow;
  nowMs: number;
  compact: boolean;
  onSelect: StopSelectHandler | undefined;
}) {
  switch (row.kind) {
    case "now":
      return (
        <NowRow
          progress={row.progress}
          arrivalMs={row.arrivalMs}
          nowMs={nowMs}
          compact={compact}
          showPassed={row.upper !== "none"}
        />
      );
    case "headline":
      return <HeadlineRow row={row} onSelect={onSelect} compact={compact} label={row.label} />;
    case "passed":
      return <PassedRow row={row} onSelect={onSelect} />;
    case "upcoming":
      return <UpcomingRow row={row} onSelect={onSelect} />;
    default:
      return <PlainRow row={row} onSelect={onSelect} />;
  }
}

export function StopStrip({
  model,
  nowMs,
  mode,
  compact,
  onStopSelect,
  id,
}: {
  model: TrainCardModel;
  nowMs: number;
  mode: StripMode;
  compact: boolean;
  onStopSelect?: StopSelectHandler;
  id?: string;
}) {
  const train = useCopy().train;
  const rows = stripRows(model, mode, compact);
  return (
    <ol id={id} aria-label={train.stopList} className="px-4">
      {rows.map((row) => (
        <Row
          key={row.kind === "now" ? "now" : row.stop.index}
          row={row}
          nowMs={nowMs}
          compact={compact}
          onSelect={onStopSelect}
        />
      ))}
    </ol>
  );
}
