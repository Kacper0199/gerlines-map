import type { StatsTrainSegments } from "@gerlines/schema/stats";
import { useMemo } from "react";
import type { SelectionStops } from "../motion/protocol.ts";
import { type BuiltProfile, buildProfileLegs } from "./model.ts";
import { placeStops } from "./placement.ts";
import type { ProfileCardSubject } from "./subject.ts";

/**
 * The legs of the profile over the train's stops, placed on the drawn route only while the worker's stops fit the
 * detail. The legs are rebuilt when the answer, the stop places or the placement change, not on each refresh of the
 * detail, whose new array of the same stops would otherwise rebuild the map's layers.
 */
export function useProfileLegs(
  subject: ProfileCardSubject,
  answer: StatsTrainSegments | null,
  selection: SelectionStops | null,
): BuiltProfile | null {
  const placed = placeStops(subject.stops, selection ?? undefined);
  const places = subject.stops.map((stop) => stop.stopPlaceId).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stops are keyed by their place ids, the placement by its vertices
  return useMemo(
    () => (answer === null ? null : buildProfileLegs(subject.stops, answer, placed)),
    [answer, places, placed],
  );
}
