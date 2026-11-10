import { LngLat, type Map as MapLibreMap } from "maplibre-gl";
import { easeOutDesign } from "./easing.ts";
import {
  type Box,
  createElasticTracker,
  elasticBox,
  type LngLatLike,
  overshootKm,
  releaseTarget,
} from "./soft-bounds.ts";

export const EASE_BACK_MS = 280;
const SETTLED_KM = 0.05;

interface MovementEvent {
  readonly originalEvent?: unknown;
}

export type SoftBoundsMap = Pick<
  MapLibreMap,
  "setTransformCameraUpdate" | "getCenter" | "easeTo" | "on" | "off"
>;

export interface SoftBounds {
  endGesture(): void;
  detach(): void;
}

export interface SoftBoundsOptions {
  readonly reducedMotion: () => boolean;
  readonly selected?: () => LngLatLike | null;
  readonly box?: Box;
}

function settledIn(center: LngLatLike, box: Box): boolean {
  const { x, y } = overshootKm(center, box);
  return Math.hypot(x, y) < SETTLED_KM;
}

export function attachSoftBounds(map: SoftBoundsMap, options: SoftBoundsOptions): SoftBounds {
  const box = options.box ?? elasticBox();
  const tracker = createElasticTracker(box);
  const selected = () => options.selected?.() ?? null;
  let gesture = false;
  let gestureBox = box;
  let easingBack = false;

  map.setTransformCameraUpdate((next) => {
    if (!gesture) {
      return {};
    }
    const shown = tracker.next(next.center);
    return { center: new LngLat(shown.lng, shown.lat) };
  });

  const onStart = (event: MovementEvent) => {
    if (!event.originalEvent) {
      gesture = false;
      return;
    }
    const train = selected();
    gestureBox = tracker.start(map.getCenter(), {
      widen: !easingBack,
      keep: train ? [train] : [],
    });
    easingBack = false;
    gesture = true;
  };
  const onEnd = (event: MovementEvent) => {
    if (!gesture) {
      if (easingBack && settledIn(map.getCenter(), gestureBox)) {
        easingBack = false;
      }
      return;
    }
    if (event.originalEvent) {
      release();
    }
  };
  const release = () => {
    gesture = false;
    const target = releaseTarget(map.getCenter(), gestureBox, box, selected());
    if (!target) {
      return;
    }
    easingBack = true;
    map.easeTo({
      center: [target.lng, target.lat],
      duration: options.reducedMotion() ? 0 : EASE_BACK_MS,
      easing: easeOutDesign,
      essential: true,
    });
  };

  map.on("movestart", onStart);
  map.on("moveend", onEnd);
  return {
    endGesture: () => {
      gesture = false;
    },
    detach: () => {
      map.off("movestart", onStart);
      map.off("moveend", onEnd);
      map.setTransformCameraUpdate(null);
    },
  };
}
