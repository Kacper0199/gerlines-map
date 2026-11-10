import type { Map as MapLibreMap } from "maplibre-gl";
import { type RefObject, useEffect, useState } from "react";
import { PHONE_QUERY } from "../hooks/use-media-query.ts";
import { pollFor } from "../map/poll-for.ts";
import type { TrainMap } from "../map/train-map.ts";
import { viewPadding } from "../map/view-padding.ts";
import { useAppStore } from "../state/store.ts";
import { JourneyLayer, linePointsOf } from "./journey-layer.ts";
import { journeyBounds } from "./journey-view.ts";
import { PLANNER_SHEET_PEEK, selectedJourney, usePlannerStore } from "./planner-store.ts";

const MAP_WAIT_MS = 60_000;
const FIT_MS = 900;
const FIT_MAX_ZOOM = 12;
const PLANNER_CARD_RIGHT = 444;
const RIGHT_COLUMN = 280;
const PHONE_SHEET_CLEARANCE = 40;
const PHONE_SIDE_CLEARANCE = 40;
const PHONE_TOP_FALLBACK = 220;
const PHONE_TOP_GAP = 24;

/** The bottom edge of the phone's top cards, which the shell publishes as `--gl-sheet-inset`. */
function phoneTopClearance(): number {
  const inset = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--gl-sheet-inset"),
  );
  return Number.isFinite(inset) ? inset + PHONE_TOP_GAP : PHONE_TOP_FALLBACK;
}

function useMap(handle: RefObject<TrainMap | null>): MapLibreMap | null {
  const [map, setMap] = useState<MapLibreMap | null>(null);
  useEffect(
    () =>
      pollFor(() => handle.current?.maplibre ?? null, setMap, {
        frame: (callback) => requestAnimationFrame(callback),
        cancel: (frame) => cancelAnimationFrame(frame),
        now: () => performance.now(),
        timeoutMs: MAP_WAIT_MS,
      }),
    [handle],
  );
  return map;
}

function fitPadding(phone: boolean) {
  if (phone) {
    const padding = viewPadding(true, false);
    return {
      ...padding,
      top: phoneTopClearance(),
      left: PHONE_SIDE_CLEARANCE,
      right: PHONE_SIDE_CLEARANCE,
      bottom: PLANNER_SHEET_PEEK + PHONE_SHEET_CLEARANCE,
    };
  }
  const padding = viewPadding(false, false);
  return {
    ...padding,
    left: Math.max(padding.left, PLANNER_CARD_RIGHT),
    right: Math.max(padding.right, RIGHT_COLUMN),
    top: 56,
    bottom: 104,
  };
}

/**
 * Draws the shown journey's legs as route lines on the map and fits the camera to the journey
 * whenever another journey is shown.
 */
export function JourneyMap({ handle }: { handle: RefObject<TrainMap | null> }) {
  const map = useMap(handle);
  const theme = useAppStore((state) => state.theme);
  const journey = usePlannerStore((state) => (state.open ? selectedJourney(state) : null));
  const [layer, setLayer] = useState<JourneyLayer | null>(null);

  useEffect(() => {
    if (!map) return;
    const created = new JourneyLayer(map, useAppStore.getState().theme);
    setLayer(created);
    return () => created.dispose();
  }, [map]);

  useEffect(() => {
    layer?.show(journey, theme);
  }, [layer, journey, theme]);

  const journeyId = journey?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the camera moves when another journey is shown, not when its punctuality loads
  useEffect(() => {
    if (!(map && journey)) return;
    const [west, south, east, north] = journeyBounds(journey, (leg) => linePointsOf(leg) ?? []);
    const phone = window.matchMedia(PHONE_QUERY).matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fit = () =>
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: fitPadding(phone), maxZoom: FIT_MAX_ZOOM, duration: reduced ? 0 : FIT_MS },
      );
    if (map.loaded()) {
      fit();
      return;
    }
    map.once("idle", fit);
    return () => {
      map.off("idle", fit);
    };
  }, [map, journeyId]);

  return null;
}
