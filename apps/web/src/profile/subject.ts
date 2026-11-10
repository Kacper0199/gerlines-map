import type { TrainDetail } from "@gerlines/schema";
import type { StopRef } from "./model.ts";
import type { ProfileSubject } from "./profile-client.ts";

/** What the card hands the profile block: whose profile to ask for and the stops to lay its legs over. */
export interface ProfileCardSubject extends ProfileSubject {
  readonly stops: readonly StopRef[];
}

/** Null where there is nothing to draw on: the map does not draw the train, or it has no train number. */
export function profileSubjectOf(detail: TrainDetail, onMap: boolean): ProfileCardSubject | null {
  if (!onMap || detail.trainNumber === null) return null;
  return {
    number: detail.trainNumber,
    category: detail.category,
    operatorId: detail.operator?.id ?? null,
    stops: detail.stops.map((stop) => ({
      stopPlaceId: stop.stopPlaceId,
      name: stop.name,
      times: timesOf(stop),
      cancelled: stop.cancelled,
    })),
  };
}

function timesOf(stop: TrainDetail["stops"][number]): number[] {
  const instants = [
    stop.scheduledArrival,
    stop.scheduledDeparture,
    stop.predictedArrival,
    stop.predictedDeparture,
  ];
  const seconds = instants.flatMap((instant) =>
    instant === null ? [] : [Date.parse(instant) / 1000],
  );
  return [...new Set(seconds)].sort((a, b) => a - b);
}
