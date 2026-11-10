import { useCopy, useFormatters } from "@gerlines/i18n/react";
import { BottomSheet, CategoryMark, cn, IconButton } from "@gerlines/ui";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useCardHeadingFocus } from "../../a11y/card-focus.ts";
import { returnToMap } from "../../a11y/focus.ts";
import type { DataStatus, LiveSelectionInfo } from "../../motion/protocol.ts";
import { useAppStore } from "../../state/store.ts";
import { HeadDelay } from "./card/CardHead.tsx";
import { SpeedEstimate } from "./SpeedRow.tsx";
import { frameTrainNaming } from "./train-naming.ts";

/** The sheet height before it is measured: head row, title with its line below, delay and the provenance. */
export const FRAME_SHEET_PEEK = 224;

function delayMinutes(info: LiveSelectionInfo): number | null {
  return info.delaySeconds === null ? null : Math.round(info.delaySeconds / 60);
}

function Provenance({ status, realtime }: { status: DataStatus; realtime: boolean }) {
  const copy = useCopy();
  const { clock, day } = useFormatters();
  const dataTime = status.dataTimeMs;
  if (!realtime) {
    return (
      <p className="type-caption border-t px-4 pt-3 text-ink-muted">
        {copy.train.positionHowTimetable}
        {status.state === "error" ? ` ${copy.train.refreshFailed}` : ""}
      </p>
    );
  }
  return (
    <p className="type-caption border-t px-4 pt-3 text-ink-muted">
      {copy.card.positionEstimated}
      {dataTime !== undefined ? ` ${copy.card.dataFrom(clock(dataTime), day(dataTime))}` : ""}
      {status.state === "recorded" && dataTime !== undefined ? ` ${copy.card.recordedReplay}` : ""}
      {status.state === "stale" ? ` ${copy.card.staleData}` : ""}
      {status.state === "error" ? ` ${copy.train.refreshFailed}` : ""}
    </p>
  );
}

function RealtimeCaption({ info, state }: { info: LiveSelectionInfo; state: DataStatus["state"] }) {
  const copy = useCopy();
  if (state === "error") return null;
  const filled = info.realtime && state !== "stale";
  const label = !info.realtime
    ? copy.card.timetableOnly
    : state === "stale"
      ? copy.live.stale
      : copy.card.realtime;
  return (
    <span className="type-caption inline-flex items-center gap-1.5 text-ink-muted">
      <span
        aria-hidden="true"
        className={
          filled
            ? "size-2 rounded-full bg-ink"
            : "size-2 rounded-full shadow-[inset_0_0_0_2px_var(--gl-ink-muted)]"
        }
      />
      {label}
    </span>
  );
}

function Heading({
  info,
  state,
  closeSlot,
}: {
  info: LiveSelectionInfo;
  state: DataStatus["state"];
  closeSlot: React.ReactNode;
}) {
  const copy = useCopy();
  const naming = frameTrainNaming(info, copy.train);
  const heading = useRef<HTMLHeadingElement>(null);
  useCardHeadingFocus(heading);
  return (
    <header className="grid grid-cols-[1fr_auto] gap-x-3 px-4">
      <div className="col-span-2 flex min-h-target items-center justify-between gap-2">
        <span className="type-label flex min-w-0 items-center gap-2 text-ink-muted">
          <CategoryMark category={info.category} size={12} />
          <span>{copy.categories[info.category].badge}</span>
        </span>
        {closeSlot}
      </div>
      <div className="col-start-1 flex min-w-0 flex-col self-end">
        <h2
          ref={heading}
          tabIndex={-1}
          className="type-headline min-w-0 wrap-anywhere text-[28px] outline-none sm:text-[32px]"
        >
          {naming.title ?? copy.card.train}
        </h2>
        {naming.subtitle ? (
          <span className="type-label mt-1 font-normal text-ink-muted">{naming.subtitle}</span>
        ) : null}
      </div>
      <div className="col-start-2 flex flex-col items-end gap-1 text-right">
        <HeadDelay
          minutes={delayMinutes(info)}
          now={info.realtime && (delayMinutes(info) ?? 0) !== 0}
          realtime={info.realtime}
        />
        <RealtimeCaption info={info} state={state} />
      </div>
    </header>
  );
}

function Body({
  closeSlot,
  className,
  detailUnavailable,
  playback,
}: {
  closeSlot: React.ReactNode;
  className?: string;
  detailUnavailable: boolean;
  playback: boolean;
}) {
  const copy = useCopy();
  const info = useAppStore((state) => state.liveSelection);
  const ended = useAppStore((state) => state.selectionEnded);
  const status = useAppStore((state) => state.status);
  if (!info) {
    return (
      <div className="flex items-start justify-between gap-2 px-4 pb-4">
        <p className="type-body-strong pt-2">{ended ? copy.card.ended : copy.live.loading}</p>
        {closeSlot}
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-3 pb-4", className)}>
      <Heading info={info} state={status.state} closeSlot={closeSlot} />
      {playback ? (
        <p className="type-body px-4 text-ink-muted">{copy.playback.cardNote}</p>
      ) : detailUnavailable ? (
        <p className="type-body px-4 text-ink-muted">{copy.card.detailUnavailable}</p>
      ) : null}
      <SpeedEstimate speedMps={info.speedMps} realtime={info.realtime} playback={playback} />
      <Provenance status={status} realtime={info.realtime} />
    </div>
  );
}

/**
 * The card of a train drawn from our own frames: what a frame knows (service, line, delay, whether
 * the plan comes from realtime data) and where the position comes from. It stands in for the train
 * detail card while the detail is not available (the lookup of its key failed), and says so.
 */
export function FrameTrainCard({
  phone,
  detailUnavailable = false,
  playback = false,
}: {
  phone: boolean;
  detailUnavailable?: boolean;
  /** A playback shows only what the frames of that moment knew; the detail of today would be another time. */
  playback?: boolean;
}) {
  const copy = useCopy();
  const anchor = useRef<HTMLDivElement>(null);
  const select = useAppStore((state) => state.select);
  const close = (
    <IconButton
      label={copy.card.close}
      onClick={() => {
        select(null);
        returnToMap();
      }}
    >
      <X aria-hidden="true" />
    </IconButton>
  );
  useEffect(() => {
    if (!phone) return undefined;
    const root = document.documentElement;
    root.style.setProperty("--gl-sheet-peek", `${FRAME_SHEET_PEEK}px`);
    const sheet = anchor.current?.closest('[data-slot="bottom-sheet"]');
    const observer =
      sheet && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            root.style.setProperty(
              "--gl-sheet-peek",
              `${Math.ceil(sheet.getBoundingClientRect().height)}px`,
            );
          })
        : null;
    if (sheet) observer?.observe(sheet);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--gl-sheet-peek");
    };
  }, [phone]);
  if (phone) {
    return (
      <BottomSheet
        label={copy.card.label}
        expandLabel={copy.card.expand}
        collapseLabel={copy.card.collapse}
        expandable={false}
        trailing={close}
        className="pointer-events-auto z-20"
      >
        <div ref={anchor}>
          <Body
            detailUnavailable={detailUnavailable}
            playback={playback}
            closeSlot={null}
            className="gap-0 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]"
          />
        </div>
      </BottomSheet>
    );
  }
  return (
    <article
      aria-label={copy.card.label}
      className="card-surface pointer-events-auto flex min-h-0 flex-col overflow-y-auto pt-2"
    >
      <Body
        detailUnavailable={detailUnavailable}
        playback={playback}
        closeSlot={<div className="-mr-3">{close}</div>}
      />
    </article>
  );
}
