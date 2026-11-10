import { useCopy } from "@gerlines/i18n/react";
import { Button, cn } from "@gerlines/ui";
import { History, Radio } from "lucide-react";
import { usePlaybackStore } from "./store.ts";

export const PLAYBACK_PANEL_ID = "playback-panel";

/**
 * The live bar's two controls for the past: History opens or closes the timeline, and while a
 * playback runs Back to live ends it. Both are rows of the bar itself (the wrapper has no box), so
 * Back to live moves to a row of its own when the bar is too narrow for both. Nothing shows where
 * no live map can play a past hour.
 */
export function HistoryControl({ stacked = false }: { stacked?: boolean }) {
  const copy = useCopy();
  const available = usePlaybackStore((state) => state.send !== null);
  const playing = usePlaybackStore((state) => state.state !== null);
  const open = usePlaybackStore((state) => state.panelOpen);
  const openPanel = usePlaybackStore((state) => state.openPanel);
  const closePanel = usePlaybackStore((state) => state.closePanel);
  const stop = usePlaybackStore((state) => state.stop);
  if (!available) return null;
  return (
    <div className="contents">
      <div className={cn("flex items-center", !stacked && "border-l pl-3")}>
        <Button
          variant="quiet"
          data-slot="history-button"
          aria-pressed={open}
          aria-controls={open ? PLAYBACK_PANEL_ID : undefined}
          className="aria-pressed:bg-raised aria-pressed:text-ink"
          onClick={() => (open ? closePanel() : openPanel())}
        >
          <History aria-hidden="true" />
          {copy.playback.open}
        </Button>
      </div>
      {playing ? (
        <Button variant="solid" data-slot="back-to-live" onClick={stop}>
          <Radio aria-hidden="true" />
          {copy.playback.backToLive}
        </Button>
      ) : null}
    </div>
  );
}
