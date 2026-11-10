import { PlannerButton } from "../../journeys/PlannerButton.tsx";
import { StatsButton } from "../../stats/StatsEntry.tsx";

/** Plan a journey and Statistics in the search row: one slot, so at most one is pressed. */
export function PanelButtons() {
  return (
    <>
      <PlannerButton />
      <StatsButton />
    </>
  );
}
