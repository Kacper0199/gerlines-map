import type { CarFrame } from "../cars/car-instances.ts";
import { liveKeyOf, liveTrainId } from "../live/train-ids.ts";
import type { SelectedFrame } from "../motion/frame.ts";

/** How a selected train is drawn: as cars, placed as cars with a mesh still loading, or as its chevron. */
export type CarsState = "drawn" | "placed" | "chevron";

export interface CheckSnapshot {
  /** The trip key of the selected train the frame shows, null for a train that is not live. */
  readonly key: number | null;
  readonly lon: number;
  readonly lat: number;
  readonly cars: CarsState;
}

export interface CheckView {
  readonly zoom?: number;
  readonly pitch?: number;
  readonly bearing?: number;
  /** Milliseconds to wait for the train to appear in a frame. */
  readonly timeoutMs?: number;
  /**
   * Release the selection once the view is set: the roof band then shows the colour mode instead
   * of the selection's amber and follow ends, so the train drifts out of the view within seconds.
   */
  readonly release?: boolean;
}

export interface CheckResult {
  readonly found: boolean;
  readonly key: number;
  readonly lon?: number;
  readonly lat?: number;
  readonly zoom?: number;
  readonly cars?: CarsState;
}

/** The selection actions of the app store the hook drives. */
export interface CheckStore {
  select(id: string | null): void;
  setFollowing(on: boolean): void;
}

/** What the hook reads from and does to the map. */
export interface CheckTarget {
  /** The selected train in the latest frame, null while there is none. */
  snapshot(): CheckSnapshot | null;
  isMoving(): boolean;
  jumpTo(camera: { center: [number, number]; zoom: number; pitch: number; bearing: number }): void;
}

export interface CheckClock {
  now(): number;
  wait(ms: number): Promise<void>;
}

const REAL_CLOCK: CheckClock = {
  now: () => performance.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The selected train of a frame and how it is drawn, null without a selected train. */
export function snapshotOf(
  selected: SelectedFrame | null | undefined,
  cars: Pick<CarFrame, "drawnKeys" | "trainKeys"> | undefined,
): CheckSnapshot | null {
  if (!selected) return null;
  const key = liveKeyOf(selected.id);
  let state: CarsState = "chevron";
  if (key !== null && cars?.drawnKeys.includes(key)) state = "drawn";
  else if (key !== null && cars?.trainKeys.includes(key)) state = "placed";
  return { key, lon: selected.lon, lat: selected.lat, cars: state };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
const BLEND_MS = 600;

function keyOf(trip: number | string): number {
  const key =
    typeof trip === "number" ? trip : liveKeyOf(trip.startsWith("live:") ? trip : `live:${trip}`);
  if (key === null || !Number.isSafeInteger(key) || key <= 0) {
    throw new RangeError(`not a trip key: ${String(trip)}`);
  }
  return key;
}

/**
 * Development check for visual reviews: selects the train of a frame trip by its key, follows it and
 * frames it at a zoom, pitch and bearing, with no detail API (the card may be empty). Selecting
 * starts again when the train is already selected, so the camera always flies; once the flight
 * has ended the camera jumps to the view and follow keeps the train in its centre. The result says
 * whether the train was found and how it is drawn, so a reviewer knows what the picture shows.
 */
export async function showTrain(
  store: CheckStore,
  target: CheckTarget,
  trip: number | string,
  view: CheckView = {},
  clock: CheckClock = REAL_CLOCK,
): Promise<CheckResult> {
  const key = keyOf(trip);
  const {
    zoom = 17,
    pitch = 0,
    bearing = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    release = false,
  } = view;
  store.select(null);
  store.select(liveTrainId(key));
  store.setFollowing(true);
  const ofTrain = (): CheckSnapshot | null => {
    const snapshot = target.snapshot();
    return snapshot?.key === key ? snapshot : null;
  };
  const deadline = clock.now() + timeoutMs;
  let seen = ofTrain();
  while (clock.now() < deadline && !(seen !== null && !target.isMoving())) {
    await clock.wait(POLL_MS);
    seen = ofTrain();
  }
  if (seen === null || target.isMoving()) {
    store.select(null);
    return { found: false, key };
  }
  target.jumpTo({ center: [seen.lon, seen.lat], zoom, pitch, bearing });
  await clock.wait(BLEND_MS);
  const after = ofTrain() ?? seen;
  if (release) store.select(null);
  return { found: true, key, lon: after.lon, lat: after.lat, zoom, cars: after.cars };
}
