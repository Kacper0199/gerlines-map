import { cn } from "@gerlines/ui";
import { useRef } from "react";
import { InViewSlot, useInViewOpen } from "../../inview/InViewEntry.tsx";
import { JourneyPlannerPanel, usePlannerShown } from "../../journeys/JourneyPlanner.tsx";
import { PlaybackSlot, usePlaybackActive } from "../../playback/PlaybackSlot.tsx";
import { usePanelCardSwitch } from "../../state/panel-cards.ts";
import { usePlaceStore } from "../../state/place-store.ts";
import { useAppStore } from "../../state/store.ts";
import { StatsSlot, useStatsOpen } from "../../stats/StatsEntry.tsx";
import { StationPanel } from "../station/StationPanel.tsx";
import { SelectedTrain, selectedCardKey } from "../train/SelectedTrain.tsx";
import { Attribution } from "./Attribution.tsx";
import { ColourKey } from "./ColourKey.tsx";
import { LandChip } from "./LandChip.tsx";
import { LayersPopover } from "./LayersPopover.tsx";
import { LiveBar } from "./LiveBar.tsx";
import { PanelButtons } from "./PanelButtons.tsx";
import { SearchCard } from "./SearchCard.tsx";
import { useSheetInset } from "./use-sheet-inset.ts";

function PhoneCard({
  selectedId,
  stationCard,
  statsOpen,
  inViewOpen,
}: {
  selectedId: string | null;
  stationCard: string | null;
  statsOpen: boolean;
  inViewOpen: boolean;
}) {
  if (selectedId !== null) return <SelectedTrain key={selectedCardKey(selectedId)} phone />;
  if (stationCard !== null) return <StationPanel key={stationCard} phone />;
  if (statsOpen) return <StatsSlot phone />;
  if (inViewOpen) return <InViewSlot phone />;
  return <JourneyPlannerPanel phone />;
}

export function PhoneShell() {
  const selectedId = useAppStore((state) => state.selectedId);
  const stationCard = usePlaceStore(
    (state) => state.station?.id ?? state.missingStation?.id ?? null,
  );
  const statsOpen = useStatsOpen();
  const inViewOpen = useInViewOpen();
  const planner = usePlannerShown();
  usePanelCardSwitch();
  const top = useRef<HTMLDivElement>(null);
  useSheetInset(top);
  const sheet = selectedId !== null || stationCard !== null || statsOpen || inViewOpen || planner;
  const playing = usePlaybackActive();
  return (
    <div className="group/shell pointer-events-none fixed inset-0 flex flex-col justify-between p-3">
      <div ref={top} className="flex flex-col gap-2">
        <SearchCard
          compact
          endSlot={
            <>
              <PanelButtons />
              <LayersPopover />
            </>
          }
        />
        <LandChip />
      </div>
      <div className="flex flex-col items-end gap-2">
        <Attribution
          collapsible
          className={cn(
            sheet && "mb-(--gl-sheet-peek)",
            "group-has-[[data-slot=bottom-sheet][data-state=expanded]]/shell:hidden",
          )}
        />
        <PlaybackSlot
          className={cn(
            "w-full",
            sheet && "mb-(--gl-sheet-peek)",
            "group-has-[[data-slot=bottom-sheet][data-state=expanded]]/shell:hidden",
          )}
        />
        {sheet && !playing ? null : (
          <>
            {sheet ? null : <ColourKey className="self-start" />}
            <LiveBar
              stacked
              className={cn(
                "self-start",
                sheet && "mb-(--gl-sheet-peek)",
                "group-has-[[data-slot=bottom-sheet][data-state=expanded]]/shell:hidden",
              )}
            />
          </>
        )}
      </div>
      <PhoneCard
        selectedId={selectedId}
        stationCard={stationCard}
        statsOpen={statsOpen}
        inViewOpen={inViewOpen}
      />
    </div>
  );
}
