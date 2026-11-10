import type { SearchStation } from "@gerlines/schema/search";
import { useEffect } from "react";
import { type FetchLike, fetchStation } from "../search/search-client.ts";
import { type PlannerStation, usePlannerStore } from "./planner-store.ts";
import { startPlannerSync } from "./planner-sync.ts";

const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** The stop id journeys take; an answer of an older API names only the DHID. */
export function journeyStopIdOf(station: Pick<SearchStation, "dhid" | "stopId">): string | null {
  return station.stopId ?? station.dhid;
}

export function plannerStationOf(station: Omit<SearchStation, "kind">): PlannerStation {
  return {
    id: station.id,
    name: station.name,
    stopId: journeyStopIdOf(station),
    lon: station.lon,
    lat: station.lat,
  };
}

/** Keeps the planner in the address from the first load on, also while the planner is closed. */
export function usePlannerAddress(): void {
  useEffect(
    () =>
      startPlannerSync(
        {
          location: window.location,
          history: window.history,
          addPopListener: (listener) => {
            window.addEventListener("popstate", listener);
            return () => window.removeEventListener("popstate", listener);
          },
          loadStation: async (id) => {
            const answer = await fetchStation(id, { fetch: browserFetch });
            return answer.kind === "ok" ? plannerStationOf(answer.station) : null;
          },
        },
        usePlannerStore,
      ),
    [],
  );
}
