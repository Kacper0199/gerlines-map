import { lazy, type RefObject, Suspense } from "react";
import type { TrainMap } from "../map/train-map.ts";
import { usePanelOpen } from "../state/panel-store.ts";
import { usePlannerAddress } from "./planner-address.ts";
import { usePlannerStore } from "./planner-store.ts";

const LazyPanel = lazy(() =>
  import("./PlannerPanel.tsx").then((module) => ({ default: module.PlannerPanel })),
);
const LazyMap = lazy(() =>
  import("./JourneyMap.tsx").then((module) => ({ default: module.JourneyMap })),
);

/** The planner card or sheet, loaded the first time the planner opens. */
export function JourneyPlannerPanel({ phone }: { phone: boolean }) {
  const open = usePanelOpen("journeys");
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LazyPanel phone={phone} />
    </Suspense>
  );
}

/** Whether the planner card or sheet is in the shared slot. */
export function usePlannerShown(): boolean {
  return usePanelOpen("journeys");
}

/** The planner in the address, and its journey on the map while it is open or waits behind a card. */
export function JourneyPlannerMap({ handle }: { handle: RefObject<TrainMap | null> }) {
  usePlannerAddress();
  const open = usePlannerStore((state) => state.open);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LazyMap handle={handle} />
    </Suspense>
  );
}

export { PlannerButton } from "./PlannerButton.tsx";
