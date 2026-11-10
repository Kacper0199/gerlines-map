import { useCopy } from "@gerlines/i18n/react";
import { IconButton } from "@gerlines/ui";
import { ChartColumn } from "lucide-react";
import { lazy, Suspense } from "react";
import { PANEL_BUTTON_CLASS } from "../components/shell/panel-button.ts";
import { usePanelOpen, usePanelStore } from "../state/panel-store.ts";
import { usePlaceStore } from "../state/place-store.ts";
import { useAppStore } from "../state/store.ts";
import { useStatsStore } from "./store.ts";

const StatsPanel = lazy(() => import("./StatsPanel.tsx"));

/** Opens the panel; a station card that was open becomes the area, so its statistics are one press away. */
export function openStatistics(): void {
  const station = usePlaceStore.getState().station;
  useAppStore.getState().select(null);
  usePlaceStore.getState().selectStation(null);
  const stats = useStatsStore.getState();
  if (station !== null) stats.setArea({ kind: "station", id: station.id, name: station.name });
  usePanelStore.getState().open("stats");
}

/** The control in the search row, paired with Plan a journey; the panel itself loads on the first press. */
export function StatsButton() {
  const copy = useCopy();
  const open = usePanelOpen("stats");
  return (
    <IconButton
      label={copy.stats.open}
      tooltip
      tooltipSide="bottom"
      variant="secondary"
      aria-pressed={open}
      data-slot="stats-button"
      onClick={() => {
        if (open) usePanelStore.getState().close("stats");
        else openStatistics();
      }}
      className={PANEL_BUTTON_CLASS}
    >
      <ChartColumn aria-hidden="true" />
    </IconButton>
  );
}

export function useStatsOpen(): boolean {
  return usePanelOpen("stats");
}

/** The panel in the card slot of the shell, loaded on demand. */
export function StatsSlot({ phone }: { phone: boolean }) {
  return (
    <Suspense fallback={null}>
      <StatsPanel phone={phone} />
    </Suspense>
  );
}
