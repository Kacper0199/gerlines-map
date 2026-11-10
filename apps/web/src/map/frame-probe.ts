import { type FrameGroup, POSITION_STRIDE } from "../motion/frame.ts";

/** Longitude counts less than latitude at Germany's latitudes: 1 over cos 50 degrees. */
const LATITUDE_WEIGHT = 1.6;

export interface ProbedTrain {
  readonly id: string;
  readonly lon: number;
  readonly lat: number;
}

/**
 * The trains of a frame by id and position, the ones nearest to `near` (lon, lat) first. A frame
 * carries a group's ids only when they changed, so `ids` gives the last ones sent per group.
 */
export function nearestTrains(
  groups: readonly FrameGroup[],
  ids: ReadonlyArray<readonly string[] | undefined>,
  near: readonly [number, number],
  limit: number,
): ProbedTrain[] {
  const found: Array<ProbedTrain & { distance: number }> = [];
  for (const [groupIndex, group] of groups.entries()) {
    for (let index = 0; index < group.count; index++) {
      const id = ids[groupIndex]?.[index];
      const lon = group.positions[index * POSITION_STRIDE];
      const lat = group.positions[index * POSITION_STRIDE + 1];
      if (id === undefined || lon === undefined || lat === undefined) continue;
      const distance = (lon - near[0]) ** 2 + ((lat - near[1]) * LATITUDE_WEIGHT) ** 2;
      found.push({ id, lon, lat, distance });
    }
  }
  return found
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ id, lon, lat }) => ({ id, lon, lat }));
}
