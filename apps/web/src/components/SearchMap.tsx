import type { Map as MapLibreMap } from "maplibre-gl";
import { type RefObject, useEffect, useState } from "react";
import { PHONE_QUERY } from "../hooks/use-media-query.ts";
import { pollFor } from "../map/poll-for.ts";
import type { TrainMap } from "../map/train-map.ts";
import { viewPadding } from "../map/view-padding.ts";
import { type CameraTarget, usePlaceStore } from "../state/place-store.ts";
import { useAppStore } from "../state/store.ts";
import { applyView } from "../url/apply-view.ts";
import { browserApplyStores, browserTrainOfKey, storeTarget } from "../url/store-target.ts";
import { startUrlSync, type UrlSync } from "../url/url-sync.ts";

const FLIGHT_MS = 900;
const LINE_MAX_ZOOM = 12;
const MAP_WAIT_MS = 60_000;

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

function moveCamera(map: MapLibreMap, target: CameraTarget): void {
  const phone = window.matchMedia(PHONE_QUERY).matches;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duration = reduced ? 0 : FLIGHT_MS;
  switch (target.kind) {
    case "point":
      map.easeTo({
        center: [target.lon, target.lat],
        zoom: target.zoom,
        padding: viewPadding(phone, true),
        duration,
      });
      return;
    case "box": {
      const [west, south, east, north] = target.bbox;
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: viewPadding(phone, false), maxZoom: LINE_MAX_ZOOM, duration },
      );
      return;
    }
    case "view": {
      const view = {
        center: [target.camera.lon, target.camera.lat] as [number, number],
        zoom: target.camera.zoom,
      };
      if (target.animate) map.easeTo({ ...view, duration });
      else map.jumpTo(view);
      return;
    }
  }
}

function startSync(): UrlSync {
  const stores = browserApplyStores();
  return startUrlSync(
    {
      location: window.location,
      history: window.history,
      addPopListener: (listener) => {
        window.addEventListener("popstate", listener);
        return () => window.removeEventListener("popstate", listener);
      },
      trainOfKey: browserTrainOfKey,
    },
    storeTarget((view, cause) => applyView(view, cause, stores)),
  );
}

/** One selection at a time: a train picked on the map closes the station card. */
function useOneSelection(): void {
  useEffect(
    () =>
      useAppStore.subscribe((next, previous) => {
        if (next.selectedId !== null && next.selectedId !== previous.selectedId) {
          usePlaceStore.getState().selectStation(null);
        }
      }),
    [],
  );
}

function StationPin({ map }: { map: MapLibreMap }) {
  const station = usePlaceStore((state) => state.station);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!station) {
      setPoint(null);
      return;
    }
    const place = () => setPoint(map.project([station.lon, station.lat]));
    place();
    map.on("move", place);
    map.on("resize", place);
    return () => {
      map.off("move", place);
      map.off("resize", place);
    };
  }, [map, station]);
  if (!point) return null;
  return (
    <div
      aria-hidden="true"
      data-slot="station-pin"
      className="pointer-events-none fixed z-10 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-selection bg-surface shadow-[0_0_0_2px_var(--gl-surface)]"
      style={{ left: point.x, top: point.y }}
    />
  );
}

/**
 * Connects search and links to the map: the address follows the selection and the camera, Back
 * and Forward restore them, and camera requests from search fly the map once it exists.
 */
export function SearchMap({ handle }: { handle: RefObject<TrainMap | null> }) {
  const map = useMap(handle);
  const camera = usePlaceStore((state) => state.camera);
  const [sync, setSync] = useState<UrlSync | null>(null);
  useOneSelection();

  useEffect(() => {
    const started = startSync();
    setSync(started);
    return () => started.stop();
  }, []);

  useEffect(() => {
    if (map && camera) moveCamera(map, camera.target);
  }, [map, camera]);

  useEffect(() => {
    if (!(map && sync)) return;
    const moved = () => {
      const center = map.getCenter();
      sync.cameraMoved({ lon: center.lng, lat: center.lat, zoom: map.getZoom() });
    };
    map.on("moveend", moved);
    return () => {
      map.off("moveend", moved);
    };
  }, [map, sync]);

  return map ? <StationPin map={map} /> : null;
}
