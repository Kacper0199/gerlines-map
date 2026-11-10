import { liveKeyOf } from "../live/train-ids.ts";
import type { LandCode } from "../map/style/map-styles.ts";
import type { Camera } from "../state/place-store.ts";
import { parseUrlView, sameSelection, type UrlView, writeUrlView } from "./url-state.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CAMERA_WRITE_MS = 300;

export interface SelectionSnapshot {
  readonly selectedId: string | null;
  readonly stationId: string | null;
  /** A station the address named that the API does not know; it leaves the address by replace. */
  readonly missingStationId: string | null;
  readonly land: LandCode | null;
}

export interface UrlSyncEnvironment {
  readonly location: Pick<Location, "pathname" | "search" | "hash">;
  readonly history: Pick<History, "pushState" | "replaceState">;
  addPopListener(listener: () => void): () => void;
  /** The trip instance a frame key stands for, null when it cannot be told. */
  trainOfKey(key: number): Promise<string | null>;
  setTimer?(callback: () => void, ms: number): () => void;
}

export interface UrlSyncTarget {
  snapshot(): SelectionSnapshot;
  subscribe(listener: () => void): () => void;
  apply(view: UrlView, cause: "load" | "pop"): void;
}

export interface UrlSync {
  cameraMoved(camera: Camera): void;
  stop(): void;
}

function defaultTimer(callback: () => void, ms: number): () => void {
  const id = setTimeout(callback, ms);
  return () => clearTimeout(id);
}

/**
 * Keeps the address and the selection in step. A new selection (train, station, Land) is a new
 * history entry, so Back returns to the one before; camera moves replace the current entry. Back
 * and Forward hand the entry's view to `apply`; so does the first load. A train picked on the map
 * is written by its trip instance, looked up from its frame key. What an apply changes never adds an
 * entry, so Back always leaves an entry whose station fails to load.
 */
export function startUrlSync(environment: UrlSyncEnvironment, target: UrlSyncTarget): UrlSync {
  const { location, history } = environment;
  const timer = environment.setTimer ?? defaultTimer;
  let generation = 0;
  let applying = false;
  let cancelCamera: (() => void) | undefined;

  const current = () => parseUrlView(location.search);
  const write = (view: UrlView, mode: "pushState" | "replaceState") => {
    const search = writeUrlView(location.search, view);
    if (search === location.search) return;
    history[mode](null, "", `${location.pathname}${search}${location.hash}`);
  };

  let lastSelected: string | null = null;

  const trainOf = async (
    selectedId: string | null,
    previous: string | null,
  ): Promise<string | null | undefined> => {
    if (selectedId === null) return null;
    if (UUID.test(selectedId)) return selectedId.toLowerCase();
    const key = liveKeyOf(selectedId);
    if (key === null) return null;
    const known = current().train;
    const train = await environment.trainOfKey(key);
    if (train !== null) return train;
    return known !== null && previous?.toLowerCase() === known ? known : null;
  };

  const apply = (cause: "load" | "pop") => {
    applying = true;
    try {
      target.apply(current(), cause);
    } finally {
      applying = false;
    }
  };

  const onChange = async () => {
    generation += 1;
    const mine = generation;
    const fromApply = applying;
    const snapshot = target.snapshot();
    const previous = lastSelected;
    lastSelected = snapshot.selectedId;
    const train = await trainOf(snapshot.selectedId, previous);
    if (mine !== generation || train === undefined) return;
    const latest = current();
    const next: UrlView = {
      train,
      station: train === null ? snapshot.stationId : null,
      land: snapshot.land,
      camera: latest.camera,
    };
    if (sameSelection(next, latest)) return;
    const dropsMissing =
      latest.station !== null &&
      latest.station === snapshot.missingStationId &&
      next.station === null;
    write(next, fromApply || dropsMissing ? "replaceState" : "pushState");
  };

  const unsubscribe = target.subscribe(() => void onChange());
  const removePop = environment.addPopListener(() => {
    generation += 1;
    apply("pop");
  });
  apply("load");

  return {
    cameraMoved(camera) {
      cancelCamera?.();
      cancelCamera = timer(() => {
        cancelCamera = undefined;
        write({ ...current(), camera }, "replaceState");
      }, CAMERA_WRITE_MS);
    },
    stop() {
      cancelCamera?.();
      unsubscribe();
      removePop();
    },
  };
}
