import { cn } from "@gerlines/ui";
import { useRef } from "react";
import { COMPACT_QUERY, NARROW_DESKTOP_QUERY, useMediaQuery } from "../../hooks/use-media-query.ts";
import { InViewSlot, useInViewOpen } from "../../inview/InViewEntry.tsx";
import { JourneyPlannerPanel } from "../../journeys/JourneyPlanner.tsx";
import { PlaybackSlot } from "../../playback/PlaybackSlot.tsx";
import { usePlaybackStore } from "../../playback/store.ts";
import { usePanelCardSwitch } from "../../state/panel-cards.ts";
import { usePlaceStore } from "../../state/place-store.ts";
import { useAppStore } from "../../state/store.ts";
import { StatsSlot, useStatsOpen } from "../../stats/StatsEntry.tsx";
import { StationPanel } from "../station/StationPanel.tsx";
import { SelectedTrain, selectedCardKey } from "../train/SelectedTrain.tsx";
import { Attribution } from "./Attribution.tsx";
import { LandChip } from "./LandChip.tsx";
import { LiveBar } from "./LiveBar.tsx";
import { PanelButtons } from "./PanelButtons.tsx";
import { RightColumn } from "./RightColumn.tsx";
import { SearchCard } from "./SearchCard.tsx";
import { useLiveBarHeight } from "./use-live-bar-height.ts";
import { ZoomControls } from "./ZoomControls.tsx";

/** The viewport less the page margin, the zoom column and the gaps either side of it (16 px each). */
export const BESIDE_ZOOM_COLUMN = "max-w-[calc(100vw-3rem-var(--gl-target))]";

/** Above compact sizes the corner holds the attribution card (330 px), the zoom column and their gaps: 382 px, 12 px of air and the page padding. */
const BESIDE_ATTRIBUTION = "max-w-[calc(100vw-426px)]";
const ROW_COLUMNS = {
  attribution: "min-[1280px]:grid-cols-[minmax(0,1fr)_auto_minmax(24.625rem,1fr)]",
  zoom: "min-[1280px]:grid-cols-[minmax(0,1fr)_auto_minmax(3.5rem,1fr)]",
} as const;

/**
 * The left column ends one gap above the live bar as measured, so a bar that wraps never covers it.
 * With the timeline open it runs beside the timeline from 1040 to 1279 px (the timeline sits right of the
 * card slot) and from 1650 px (the centred timeline clears it even beside the widest bar), and between them,
 * where the centred timeline lies under its lower right, it ends above the whole bottom stack.
 * Every class is written out whole: Tailwind finds classes by scanning the source for literal strings.
 */
const CLEARS_LIVE_BAR = "row-end-3 pb-[calc(var(--gl-live-bar-h,var(--gl-target))+var(--gl-s3))]";
const ENDS_ABOVE_PLAYBACK = [
  "row-end-2 pb-0",
  "min-[1040px]:max-[1279px]:row-end-3",
  "min-[1040px]:max-[1279px]:pb-[calc(var(--gl-live-bar-h,var(--gl-target))+var(--gl-s3))]",
  "min-[1650px]:row-end-3",
  "min-[1650px]:pb-[calc(var(--gl-live-bar-h,var(--gl-target))+var(--gl-s3))]",
].join(" ");

function SlotCard() {
  const selectedId = useAppStore((state) => state.selectedId);
  const stationCard = usePlaceStore(
    (state) => state.station?.id ?? state.missingStation?.id ?? null,
  );
  const statsOpen = useStatsOpen();
  const inViewOpen = useInViewOpen();
  if (selectedId !== null) {
    return <SelectedTrain key={selectedCardKey(selectedId)} phone={false} />;
  }
  if (stationCard !== null) {
    return <StationPanel key={stationCard} phone={false} />;
  }
  if (statsOpen) {
    return <StatsSlot phone={false} />;
  }
  if (inViewOpen) {
    return <InViewSlot phone={false} />;
  }
  return <JourneyPlannerPanel phone={false} />;
}

export function DesktopShell({ onZoom }: { onZoom: (delta: number) => void }) {
  const compact = useMediaQuery(COMPACT_QUERY);
  const belowCentred = useMediaQuery(NARROW_DESKTOP_QUERY);
  const playbackOpen = usePlaybackStore((state) => state.panelOpen);
  const playing = usePlaybackStore((state) => state.state !== null);
  const root = useRef<HTMLDivElement>(null);
  const barRef = useLiveBarHeight(root);
  usePanelCardSwitch();
  return (
    <div
      ref={root}
      className="pointer-events-none fixed inset-0 grid grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 p-4"
    >
      <div
        className={cn(
          "col-start-1 row-start-1 flex min-h-0 w-[380px] flex-col gap-3 max-[1200px]:w-[360px]",
          playbackOpen || playing ? ENDS_ABOVE_PLAYBACK : CLEARS_LIVE_BAR,
        )}
      >
        <div className="shrink-0">
          <SearchCard endSlot={<PanelButtons />} />
        </div>
        <LandChip className="shrink-0" />
        <SlotCard />
      </div>
      <RightColumn compact={compact} />
      <div
        data-slot="bottom-row"
        className={cn(
          "pointer-events-none col-span-3 col-start-1 row-start-2 grid grid-cols-1 self-end",
          compact ? ROW_COLUMNS.zoom : ROW_COLUMNS.attribution,
        )}
      >
        <div className="pointer-events-none flex min-w-0 flex-col items-start gap-2 min-[1280px]:col-start-2 min-[1280px]:items-center">
          <PlaybackSlot className="w-[min(560px,100vw-2rem)] min-[1040px]:max-[1279px]:ml-[calc(380px+0.75rem)]" />
          <LiveBar
            showStage
            ref={barRef}
            className={compact ? BESIDE_ZOOM_COLUMN : BESIDE_ATTRIBUTION}
          />
        </div>
      </div>
      <div
        className={cn(
          "col-start-3 row-start-2 flex items-end gap-3 self-end justify-self-end",
          compact && "flex-col",
        )}
      >
        <Attribution collapsible={compact} fold={playbackOpen && belowCentred} />
        <ZoomControls onZoom={onZoom} />
      </div>
    </div>
  );
}
