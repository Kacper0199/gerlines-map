import type { SearchStation } from "@gerlines/schema/search";
import { create } from "zustand";

export type StationSelection = Omit<SearchStation, "kind">;

/** A station the address names that did not load: unknown to the API, or not reachable right now. */
export interface MissingStation {
  readonly id: string;
  readonly reason: "not-found" | "error";
}

export interface Camera {
  readonly lon: number;
  readonly lat: number;
  readonly zoom: number;
}

export type CameraTarget =
  | { readonly kind: "point"; readonly lon: number; readonly lat: number; readonly zoom: number }
  | { readonly kind: "box"; readonly bbox: readonly [number, number, number, number] }
  | { readonly kind: "view"; readonly camera: Camera; readonly animate: boolean };

export interface CameraRequest {
  readonly target: CameraTarget;
  readonly seq: number;
}

/**
 * What search and links select besides a train: a station, and the camera moves they ask the map
 * for. A train stays in the app store (`selectedId`); one selection holds at a time.
 */
export interface PlaceState {
  readonly station: StationSelection | null;
  /** A station a link names whose details are still loading. */
  readonly pendingStationId: string | null;
  /** Kept while a retry of the same station loads, so its card stays in place. */
  readonly missingStation: MissingStation | null;
  readonly camera: CameraRequest | null;
  selectStation(station: StationSelection | null): void;
  setPendingStation(id: string): void;
  markStationMissing(id: string, reason: MissingStation["reason"]): void;
  requestCamera(target: CameraTarget): void;
}

export const usePlaceStore = create<PlaceState>()((set, get) => ({
  station: null,
  pendingStationId: null,
  missingStation: null,
  camera: null,
  selectStation: (station) => set({ station, pendingStationId: null, missingStation: null }),
  setPendingStation: (id) =>
    set((state) => ({
      pendingStationId: id,
      station: state.station?.id === id ? state.station : null,
      missingStation: state.missingStation?.id === id ? state.missingStation : null,
    })),
  markStationMissing: (id, reason) =>
    set({ station: null, pendingStationId: null, missingStation: { id, reason } }),
  requestCamera: (target) => set({ camera: { target, seq: (get().camera?.seq ?? 0) + 1 } }),
}));

export function resetPlaceStore(): void {
  usePlaceStore.setState({
    station: null,
    pendingStationId: null,
    missingStation: null,
    camera: null,
  });
}
