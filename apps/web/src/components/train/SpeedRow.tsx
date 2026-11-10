import type { Copy } from "@gerlines/i18n";
import { useCopy, useFormatters } from "@gerlines/i18n/react";
import { liveKeyOf } from "../../live/train-ids.ts";
import type { LiveSelectionInfo } from "../../motion/protocol.ts";
import { useAppStore } from "../../state/store.ts";

const KMH_PER_MPS = 3.6;
const STEP_KMH = 5;

/** The speed in km/h rounded to the nearest 5, the precision a plan evaluated on timetable times can claim. */
export function roundedSpeedKmh(speedMps: number): number {
  return Math.round((speedMps * KMH_PER_MPS) / STEP_KMH) * STEP_KMH;
}

function basisOf(speed: Copy["speed"], realtime: boolean, playback: boolean): string {
  if (!realtime) return speed.basisTimetable;
  return playback ? speed.basisPlayback : speed.basisRealtime;
}

/** A train that moves never reads as standing: only a speed of exactly 0 (a dwell) is 0, anything else shows at least one step. */
export function shownSpeedKmh(speedMps: number): number {
  return speedMps > 0 ? Math.max(STEP_KMH, roundedSpeedKmh(speedMps)) : 0;
}

/**
 * One row of the train card: the speed of the motion the map shows, with its basis. A train
 * without a plan to evaluate (the plan has ended) has no row.
 */
export function SpeedEstimate({
  speedMps,
  realtime,
  playback = false,
}: Pick<LiveSelectionInfo, "speedMps" | "realtime"> & { playback?: boolean }) {
  const copy = useCopy();
  const { speed } = useFormatters();
  if (speedMps === null || !Number.isFinite(speedMps)) return null;
  const kmh = shownSpeedKmh(speedMps);
  return (
    <section aria-label={copy.speed.label} className="flex flex-col gap-0.5 border-t px-4 pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="type-label text-ink-muted">{copy.speed.label}</h3>
        {kmh === 0 ? (
          <span className="type-body-strong text-right">{copy.speed.standing}</span>
        ) : (
          <span className="num type-data-small text-right">{speed(kmh)}</span>
        )}
      </div>
      <p className="type-caption text-ink-muted">{basisOf(copy.speed, realtime, playback)}</p>
    </section>
  );
}

/** The speed row of the selected train, read from the worker's selection updates (at most once a second). */
export function SelectedSpeed() {
  const info = useAppStore((state) => state.liveSelection);
  const selectedKey = useAppStore((state) => liveKeyOf(state.selectedId));
  if (info === null || selectedKey === null || info.key !== selectedKey) return null;
  return <SpeedEstimate speedMps={info.speedMps} realtime={info.realtime} />;
}
