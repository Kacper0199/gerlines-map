import { JOURNEY_SORTS, type JourneySort } from "@gerlines/schema/journeys";

export interface Rankable {
  readonly id: string;
  readonly departure: string;
  readonly arrival: string;
  readonly durationS: number;
  readonly transfers: number;
}

type Compare = (a: Rankable, b: Rankable) => number;

const byDuration: Compare = (a, b) => a.durationS - b.durationS;
const byTransfers: Compare = (a, b) => a.transfers - b.transfers;
const byArrival: Compare = (a, b) => Date.parse(a.arrival) - Date.parse(b.arrival);
const byLateDeparture: Compare = (a, b) => Date.parse(b.departure) - Date.parse(a.departure);
const byDeparture: Compare = (a, b) => Date.parse(a.departure) - Date.parse(b.departure);
const byId: Compare = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function chain(...compares: Compare[]): Compare {
  return (a, b) => {
    for (const compare of compares) {
      const order = compare(a, b);
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  };
}

/** Each order breaks its ties by the other criteria, then by departure and id, so it is total. */
export const RANKINGS: Readonly<Record<JourneySort, Compare>> = {
  fastest: chain(byDuration, byTransfers, byArrival, byDeparture, byId),
  fewestChanges: chain(byTransfers, byDuration, byArrival, byDeparture, byId),
  earliestArrival: chain(byArrival, byLateDeparture, byTransfers, byId),
  latestDeparture: chain(byLateDeparture, byArrival, byTransfers, byId),
};

export function defaultSort(arriveBy: boolean): JourneySort {
  return arriveBy ? "latestDeparture" : "earliestArrival";
}

/** The journeys in the chosen order, each tagged with the criteria on which it ranks first. */
export function rankJourneys<T extends Rankable>(
  journeys: readonly T[],
  sort: JourneySort,
): (T & { readonly tags: JourneySort[] })[] {
  const tags = new Map<string, JourneySort[]>();
  for (const criterion of JOURNEY_SORTS) {
    const best = [...journeys].sort(RANKINGS[criterion])[0];
    if (best) {
      tags.set(best.id, [...(tags.get(best.id) ?? []), criterion]);
    }
  }
  return [...journeys]
    .sort(RANKINGS[sort])
    .map((journey) => ({ ...journey, tags: tags.get(journey.id) ?? [] }));
}
