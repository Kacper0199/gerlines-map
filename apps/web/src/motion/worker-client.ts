import type { PlaybackState } from "../live/playback/driver.ts";
import type { DeckWindows } from "../map/terrain/deck-windows.ts";
import type { ColourMode } from "../modes/colour-mode.ts";
import type { LabelMode } from "../modes/label-mode.ts";
import type { OperatorGroup } from "../modes/operator-groups.ts";
import type { CategoryKey } from "./categories.ts";
import type { Frame, Palette } from "./frame.ts";
import type {
  CarViewInput,
  ContinuityTotals,
  DataStatus,
  LiveConfig,
  LiveDiagnostics,
  LiveSelectionInfo,
  NearestRequest,
  NearestTrains,
  PlaybackCommand,
  SelectionStops,
  WorkerMessage,
  WorkerRequest,
} from "./protocol.ts";

export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void;
  terminate(): void;
}

export interface MotionHandlers {
  readonly onFrame: (
    frame: Frame,
    selectionPath: Float32Array | undefined,
    selectionHeights: Float32Array | undefined,
    deck: DeckWindows | undefined,
    selectionStops: SelectionStops | undefined,
  ) => void;
  readonly onStatus: (status: DataStatus) => void;
  readonly onLiveSelection?: (info: LiveSelectionInfo | null) => void;
  readonly onSelectionDrawn?: (drawn: boolean, key: number) => void;
  readonly onPlayback?: (state: PlaybackState | null) => void;
}

export interface MotionClient {
  startLive(palette: Palette, config: LiveConfig): void;
  /** Continuity of the frames this worker evaluates; the map draws a subset of them, at most half a pixel apart (`stop` ends the measurement). */
  continuity(
    action: "start" | "report" | "stop",
    sample?: number,
  ): Promise<ContinuityTotals | null>;
  diagnostics(): Promise<LiveDiagnostics>;
  requestFrame(nowMs: number): boolean;
  select(id: string | null): void;
  setPalette(palette: Palette): void;
  setHiddenCategories(hidden: readonly CategoryKey[]): void;
  setHiddenOperatorGroups(hidden: readonly OperatorGroup[]): void;
  setColourMode(mode: ColourMode): void;
  setLabelMode(mode: LabelMode): void;
  setHidden(hidden: boolean): void;
  /** The forge manifest, so the worker can place cars (live frames only). */
  setCarCatalog(manifest: unknown): void;
  setView(view: CarViewInput): void;
  /** Lets the shape packs of a worker that started early (`holdPacks`) download. */
  releasePacks(): void;
  /** The exaggeration trains are lifted by (0 puts them at sea level on a flat map); live frames only. */
  setElevation(scale: number): void;
  /** The shown trains nearest a point and how many are in view (the text path to the map). */
  nearest(request: NearestRequest): Promise<NearestTrains>;
  /** The visitor changed the reduced motion preference while the page is open. */
  setReducedMotion(reduced: boolean): void;
  /** Starts, steers or ends the playback of a past hour (live frames only). */
  playback(command: PlaybackCommand): void;
  terminate(): void;
}

export function createMotionClient(worker: WorkerLike, handlers: MotionHandlers): MotionClient {
  let frameInFlight = false;
  const continuityWaiters: ((report: ContinuityTotals | null) => void)[] = [];
  const diagnosticsWaiters: ((data: LiveDiagnostics) => void)[] = [];
  const nearestWaiters = new Map<
    number,
    { resolve: (result: NearestTrains) => void; reject: (error: Error) => void }
  >();
  let nextNearestId = 1;

  worker.addEventListener("message", ({ data }) => {
    switch (data.type) {
      case "frame":
        frameInFlight = false;
        handlers.onFrame(
          data.frame,
          data.selectionPath,
          data.selectionHeights,
          data.deck,
          data.selectionStops,
        );
        break;
      case "status":
        handlers.onStatus(data.status);
        break;
      case "live-selection":
        handlers.onLiveSelection?.(data.info);
        break;
      case "selection-drawn":
        handlers.onSelectionDrawn?.(data.drawn, data.key);
        break;
      case "playback":
        handlers.onPlayback?.(data.state);
        break;
      case "continuity":
        continuityWaiters.shift()?.(data.report);
        break;
      case "diagnostics":
        diagnosticsWaiters.shift()?.(data.data);
        break;
      case "nearest-trains": {
        const waiter = nearestWaiters.get(data.id);
        nearestWaiters.delete(data.id);
        waiter?.resolve(data.result);
        break;
      }
    }
  });

  return {
    startLive(palette, config) {
      worker.postMessage({ type: "init-live", palette, config });
    },
    continuity(action, sample) {
      if (action === "start") {
        worker.postMessage({
          type: "continuity",
          action,
          ...(sample === undefined ? {} : { sample }),
        });
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        continuityWaiters.push(resolve);
        worker.postMessage({ type: "continuity", action });
      });
    },
    diagnostics() {
      return new Promise((resolve) => {
        diagnosticsWaiters.push(resolve);
        worker.postMessage({ type: "diagnostics" });
      });
    },
    requestFrame(nowMs) {
      if (frameInFlight) {
        return false;
      }
      frameInFlight = true;
      worker.postMessage({ type: "tick", now: nowMs });
      return true;
    },
    select(id) {
      worker.postMessage({ type: "select", id });
    },
    setPalette(palette) {
      worker.postMessage({ type: "palette", palette });
    },
    setHiddenCategories(hidden) {
      worker.postMessage({ type: "categories", hidden });
    },
    setHiddenOperatorGroups(hidden) {
      worker.postMessage({ type: "operator-groups", hidden });
    },
    setColourMode(mode) {
      worker.postMessage({ type: "colour-mode", mode });
    },
    setLabelMode(mode) {
      worker.postMessage({ type: "label-mode", mode });
    },
    setHidden(hidden) {
      worker.postMessage({ type: "visibility", hidden });
    },
    setCarCatalog(manifest) {
      worker.postMessage({ type: "car-catalog", manifest });
    },
    setView(view) {
      worker.postMessage({ type: "view", view });
    },
    releasePacks() {
      worker.postMessage({ type: "release-packs" });
    },
    setElevation(scale) {
      worker.postMessage({ type: "elevation", scale });
    },
    nearest(request) {
      return new Promise((resolve, reject) => {
        const id = nextNearestId++;
        nearestWaiters.set(id, { resolve, reject });
        worker.postMessage({ type: "nearest", id, request });
      });
    },
    setReducedMotion(reduced) {
      worker.postMessage({ type: "reduced-motion", reduced });
    },
    playback(command) {
      worker.postMessage({ type: "playback", command });
    },
    terminate() {
      for (const waiter of nearestWaiters.values()) {
        waiter.reject(new Error("the worker was terminated"));
      }
      nearestWaiters.clear();
      worker.terminate();
    },
  };
}
