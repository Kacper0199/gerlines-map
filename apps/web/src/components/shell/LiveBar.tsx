import type { Copy, Formatters } from "@gerlines/i18n";
import { useCopy, useFormatters } from "@gerlines/i18n/react";
import { ClockText, cn } from "@gerlines/ui";
import type { Ref } from "react";
import type { DataState, DataStatus } from "../../motion/protocol.ts";
import { HistoryControl } from "../../playback/HistoryControl.tsx";
import { usePlaybackStore } from "../../playback/store.ts";
import { useAppStore } from "../../state/store.ts";
import { StatusTrigger } from "../../status/StatusTrigger.tsx";

const NATIONAL_STAGE_ZOOM = 8;
const REGION_STAGE_ZOOM = 10;

export function liveLabel(copy: Copy, status: DataStatus): string {
  const labels: Record<DataState, string> = {
    loading: copy.live.loading,
    live: copy.live.live,
    recorded: copy.live.recorded,
    stale: copy.live.stale,
    error: status.error ? copy.live.errors[status.error] : copy.live.error,
  };
  return labels[status.state];
}

export function stageLabel(copy: Copy, zoom: number): string {
  if (zoom < NATIONAL_STAGE_ZOOM) {
    return copy.stage.national;
  }
  return zoom < REGION_STAGE_ZOOM ? copy.stage.region : copy.stage.city;
}

function DataTime({ ms, format }: { ms: number; format: Formatters }) {
  return (
    <>
      <ClockText text={format.clock(ms)} className="type-data" />
      <span className="text-ink-muted">{format.day(ms)}</span>
    </>
  );
}

function BarTail({ stage, stacked }: { stage: string | null; stacked: boolean }) {
  if (stage === null) return null;
  return stacked ? (
    <span className="type-caption text-ink-muted">{stage}</span>
  ) : (
    <span className="border-l pl-3 font-normal text-ink-muted">{stage}</span>
  );
}

/**
 * Stacked (phone), the second row is as high as the History button from the first paint, so the bar
 * and the colour key above it keep their place when the map arrives and the button appears.
 */
export function LiveBar({
  showStage = true,
  stacked = false,
  className,
  ref,
}: {
  showStage?: boolean;
  stacked?: boolean;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const copy = useCopy();
  const format = useFormatters();
  const status = useAppStore((state) => state.status);
  const zoom = useAppStore((state) => state.zoom);
  const playback = usePlaybackStore((store) => store.state !== null);
  const healthy = status.state === "live" || status.state === "recorded";
  const stage = showStage ? stageLabel(copy, zoom) : null;
  const tail = <BarTail stage={stacked && playback ? null : stage} stacked={stacked} />;
  return (
    <div
      ref={ref}
      data-slot="live-bar"
      className={cn(
        "card-surface type-label pointer-events-auto flex min-h-target max-w-full whitespace-nowrap px-4",
        stacked
          ? "flex-col justify-center gap-0.5 py-1.5"
          : "flex-wrap items-center gap-x-3 gap-y-1",
        playback && !stacked && "py-1 min-[1040px]:py-0",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <StatusTrigger
          label={playback ? copy.playback.label : liveLabel(copy, status)}
          healthy={healthy}
        />
        {status.dataTimeMs !== undefined ? (
          <DataTime ms={status.dataTimeMs} format={format} />
        ) : null}
      </div>
      {stacked ? (
        <div
          data-slot="live-bar-tail"
          className="flex min-h-target flex-wrap items-center gap-x-3 gap-y-1.5"
        >
          {tail}
          <HistoryControl stacked />
        </div>
      ) : (
        <>
          {tail}
          <HistoryControl />
        </>
      )}
    </div>
  );
}
