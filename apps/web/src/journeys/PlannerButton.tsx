import { useCopy } from "@gerlines/i18n/react";
import { IconButton } from "@gerlines/ui";
import { Route } from "lucide-react";
import { PANEL_BUTTON_CLASS } from "../components/shell/panel-button.ts";
import { usePanelOpen } from "../state/panel-store.ts";
import { usePlaceStore } from "../state/place-store.ts";
import { useAppStore } from "../state/store.ts";
import { usePlannerStore } from "./planner-store.ts";

/** The entry point in the search row, paired with Statistics: opens the planner, or closes it when it is open. */
export function PlannerButton() {
  const copy = useCopy();
  const open = usePanelOpen("journeys");
  const openPlanner = usePlannerStore((state) => state.openPlanner);
  const closePlanner = usePlannerStore((state) => state.closePlanner);
  return (
    <IconButton
      label={copy.journeys.open}
      tooltip
      tooltipSide="bottom"
      variant="secondary"
      aria-pressed={open}
      data-slot="planner-button"
      onClick={() => {
        if (open) {
          closePlanner();
          return;
        }
        useAppStore.getState().select(null);
        usePlaceStore.getState().selectStation(null);
        openPlanner();
      }}
      className={PANEL_BUTTON_CLASS}
    >
      <Route aria-hidden="true" />
    </IconButton>
  );
}
