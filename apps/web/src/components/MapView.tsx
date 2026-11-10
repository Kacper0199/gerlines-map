import "maplibre-gl/dist/maplibre-gl.css";
import { currentLocale } from "@gerlines/i18n";
import { useA11yCopy } from "@gerlines/i18n/a11y";
import { useCopy, useLocale } from "@gerlines/i18n/react";
import { type RefObject, useEffect, useRef } from "react";
import { describeCanvas, MAP_KEYS_ID } from "../a11y/map-canvas.ts";
import { useInViewStore } from "../inview/store.ts";
import { abandonEarlyWorker } from "../live/early-start.ts";
import { showTrain } from "../map/check-hook.ts";
import { TrainMap } from "../map/train-map.ts";
import { browserPlaybackSync } from "../playback/browser-sync.ts";
import { usePlaybackStore } from "../playback/store.ts";
import { leftSlotOpen, watchLeftSlot } from "../state/panel-cards.ts";
import { useAppStore } from "../state/store.ts";

function probesEnabled(): boolean {
  return import.meta.env.DEV || new URLSearchParams(window.location.search).has("probe");
}

export default function MapView({ handle }: { handle: RefObject<TrainMap | null> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const copy = useCopy();
  const { mapKeys } = useA11yCopy();
  const selectedId = useAppStore((state) => state.selectedId);
  const mapStyle = useAppStore((state) => state.mapStyle);
  const terrain3d = useAppStore((state) => state.terrain3d);
  const buildings = useAppStore((state) => state.buildings);
  const selectionTilt = useAppStore((state) => state.selectionTilt);
  const focusLand = useAppStore((state) => state.focusLand);
  const locale = useLocale();
  const hiddenCategories = useAppStore((state) => state.hiddenCategories);
  const hiddenOperatorGroups = useAppStore((state) => state.hiddenOperatorGroups);
  const colourMode = useAppStore((state) => state.colourMode);
  const labelMode = useAppStore((state) => state.labelMode);
  const following = useAppStore((state) => state.following);
  const routeRequests = useAppStore((state) => state.routeRequests);
  const profile = useAppStore((state) => state.profile);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const {
      mapStyle,
      select,
      setStatus,
      setLiveSelection,
      setZoom,
      markMapInteracted,
      setFollowing,
      setSelectedDrawn,
      setRouteStops,
      setProfileHover,
    } = useAppStore.getState();
    let map: TrainMap;
    try {
      map = new TrainMap({
        container,
        style: mapStyle,
        labelLanguage: currentLocale(),
        buildings: useAppStore.getState().buildings,
        selectionTilt: useAppStore.getState().selectionTilt,
        terrain3d: useAppStore.getState().terrain3d,
        onSelect: select,
        onStatus: setStatus,
        onLiveSelectionInfo: setLiveSelection,
        onZoom: setZoom,
        onInteract: markMapInteracted,
        onUserMove: () => useInViewStore.getState().userMoved(),
        onFollowEnd: () => setFollowing(false),
        leftSlotOpen,
        onSelectionDrawn: setSelectedDrawn,
        onPlayback: usePlaybackStore.getState().setState,
        onRouteStops: setRouteStops,
        onProfileHover: setProfileHover,
      });
    } catch (error) {
      abandonEarlyWorker();
      throw error;
    }
    handle.current = map;
    const stopLeftSlot = watchLeftSlot((open, panelOnly) => map.setLeftSlot(open, panelOnly));
    usePlaybackStore.getState().attach((command) => map.playback(command));
    const playbackSync = browserPlaybackSync();
    if (probesEnabled()) {
      Object.assign(window, {
        gerlinesMap: map.maplibre,
        gerlinesLive: {
          continuity: (action: "start" | "report" | "stop", sample?: number) =>
            map.continuity(action, sample),
          diagnostics: () => map.diagnostics(),
          trainsNear: (near: [number, number], limit: number) => map.trainsNear(near, limit),
        },
      });
    }
    if (import.meta.env.DEV) {
      const target = {
        snapshot: () => map.checkSnapshot(),
        isMoving: () => map.maplibre.isMoving(),
        jumpTo: (camera: Parameters<typeof map.maplibre.jumpTo>[0]) => map.maplibre.jumpTo(camera),
      };
      Object.assign(window, {
        gerlinesStore: useAppStore,
        gerlinesCheck: {
          showTrain: (trip: number | string, view?: Parameters<typeof showTrain>[3]) =>
            showTrain(useAppStore.getState(), target, trip, view),
        },
      });
    }
    return () => {
      playbackSync.stop();
      stopLeftSlot();
      usePlaybackStore.getState().attach(null);
      map.dispose();
      handle.current = null;
    };
  }, [handle]);

  useEffect(() => {
    const canvas = handle.current?.maplibre.getCanvas();
    if (canvas) describeCanvas(canvas, copy.map.label);
  }, [handle, copy.map.label]);

  useEffect(() => {
    handle.current?.setSelected(selectedId);
  }, [handle, selectedId]);

  useEffect(() => {
    handle.current?.setFollowing(following);
  }, [handle, following]);

  useEffect(() => {
    if (routeRequests > 0) {
      handle.current?.showRoute();
    }
  }, [handle, routeRequests]);

  useEffect(() => {
    handle.current?.setProfile(profile);
  }, [handle, profile]);

  useEffect(() => {
    handle.current?.setMapStyle(mapStyle);
  }, [handle, mapStyle]);

  useEffect(() => {
    handle.current?.setTerrain3d(terrain3d);
  }, [handle, terrain3d]);

  useEffect(() => {
    handle.current?.setBuildings(buildings);
  }, [handle, buildings]);

  useEffect(() => {
    handle.current?.setSelectionTilt(selectionTilt);
  }, [handle, selectionTilt]);

  useEffect(() => {
    void handle.current?.focusLand(focusLand);
  }, [handle, focusLand]);

  useEffect(() => {
    handle.current?.setLabelLanguage(locale);
  }, [handle, locale]);

  useEffect(() => {
    handle.current?.setHiddenCategories(hiddenCategories);
  }, [handle, hiddenCategories]);

  useEffect(() => {
    handle.current?.setHiddenOperatorGroups(hiddenOperatorGroups);
  }, [handle, hiddenOperatorGroups]);

  useEffect(() => {
    handle.current?.setColourMode(colourMode);
  }, [handle, colourMode]);

  useEffect(() => {
    handle.current?.setLabelMode(labelMode);
  }, [handle, labelMode]);

  return (
    <div className="fixed inset-0">
      <div ref={containerRef} className="size-full" />
      <p id={MAP_KEYS_ID} className="sr-only">
        {mapKeys}
      </p>
    </div>
  );
}
