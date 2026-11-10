import type { SelectedFrame } from "../motion/frame.ts";
import type { SelectionStops } from "../motion/protocol.ts";

export interface RouteSlot {
  readonly legKey: string;
  readonly path: Float32Array;
  readonly heights: Float32Array | undefined;
  readonly stops: Float32Array | undefined;
}

export interface RouteData {
  readonly path: Float32Array | undefined;
  readonly heights: Float32Array | undefined;
  readonly stops: SelectionStops | undefined;
}

/**
 * What a frame adds to the drawn route. Only a frame of the train selected now counts: a frame of the previous
 * train that was already on its way when the selection changed must not put its route or stops on the new one.
 * `report` is what the page's store should hold (null: the route has no stops), undefined when the frame carries
 * neither a route nor stops.
 */
export function acceptRoute(
  selectedId: string | null,
  selected: SelectedFrame | null,
  data: RouteData,
  previous: RouteSlot | undefined,
): { route: RouteSlot | undefined; report: SelectionStops | null | undefined } {
  if (selected === null || selectedId === null || selected.id !== selectedId) {
    return { route: previous, report: undefined };
  }
  if (data.path) {
    const route = {
      legKey: selected.legKey,
      path: data.path,
      heights: data.heights,
      stops: data.stops?.vertices,
    };
    return { route, report: data.stops ?? null };
  }
  if (data.stops && previous) {
    return { route: { ...previous, stops: data.stops.vertices }, report: data.stops };
  }
  return { route: previous, report: undefined };
}
