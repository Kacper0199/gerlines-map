import { MapLibreOverlay } from "@deck.gl/maplibre";
import { Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import fixtureUrl from "../fixtures/rail-segments.json.gz?url";
import { GpuTimer } from "./gpu-timer.ts";
import { ARCHITECTURE_THRESHOLDS } from "./lod.ts";
import { FrameProbe, type ProbeResult, roundSummary } from "./probe.ts";
import {
  ENVIRONMENTS,
  MATRICES,
  type MatrixEntry,
  type ScenarioSpec,
  specFromSearch,
} from "./scenario.ts";
import { summarize } from "./stats.ts";
import {
  BUILDINGS_3D_LAYER_ID,
  buildStyle,
  HILLSHADE_LAYER_ID,
  TERRAIN_SOURCE_ID,
} from "./style.ts";
import { type RendererStats, TrainRenderer } from "./train-renderer.ts";

setWorkerUrl(maplibreWorkerUrl);

const TILE_WAIT_LIMIT_MS = 60000;

interface PrepareResult {
  id: string;
  tilesLoadedAfterMs: number;
  baseHeightMetres: number;
  workerInitMs: number;
  zoom: number;
  pitch: number;
  canvas: { width: number; height: number };
  devicePixelRatio: number;
}

interface MeasureResult {
  probe: ProbeResult;
  renderer: RendererStats | null;
  gpuMs: ReturnType<typeof roundSummary> | null;
  gpuSamples: number;
  gpuDisjointFrames: number;
  gpuTimerSupported: boolean;
}

export interface Sp4Api {
  environments: typeof ENVIRONMENTS;
  matrix(name: string): MatrixEntry[];
  matrixNames(): string[];
  prepare(spec: ScenarioSpec): Promise<PrepareResult>;
  measure(durationMs: number): Promise<MeasureResult>;
  graphicsInfo(): { renderer: string; vendor: string };
  status(): { moving: boolean; styleLoaded: boolean; tilesLoaded: boolean; zoom: number };
}

declare global {
  interface Window {
    sp4: Sp4Api;
    sp4Ready: Promise<void>;
  }
}

function focusOf(spec: ScenarioSpec) {
  if (spec.focusTrains <= 0) return null;
  return { lon: spec.center[0], lat: spec.center[1], trains: spec.focusTrains, startSeconds: 1000 };
}

function applyScene(map: MapLibreMap, spec: ScenarioSpec): void {
  map.setLayoutProperty(HILLSHADE_LAYER_ID, "visibility", spec.terrain ? "visible" : "none");
  map.setLayoutProperty(BUILDINGS_3D_LAYER_ID, "visibility", spec.buildings ? "visible" : "none");
  map.setTerrain(spec.terrain ? { source: TERRAIN_SOURCE_ID, exaggeration: 1 } : null);
  map.jumpTo({ center: spec.center, zoom: spec.zoom, pitch: spec.pitch, bearing: spec.bearing });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForTiles(map: MapLibreMap): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < TILE_WAIT_LIMIT_MS) {
    if (!map.isMoving() && map.isStyleLoaded() && map.areTilesLoaded()) break;
    await sleep(150);
  }
  return performance.now() - started;
}

async function boot(): Promise<void> {
  const map = new MapLibreMap({
    container: "map",
    style: buildStyle(),
    center: [10.45, 51.2],
    zoom: 6,
    maxPitch: 85,
    fadeDuration: 0,
    attributionControl: { compact: true },
  });
  await map.once("load");

  const gpuTimer = new GpuTimer();
  const [timerBegin, timerEnd] = gpuTimer.layers();
  const firstLayerId = map.getStyle().layers[0]?.id;
  map.addLayer(timerBegin, firstLayerId);
  map.addLayer(timerEnd);

  const overlay = new MapLibreOverlay({ interleaved: true, layers: [] });
  map.addControl(overlay);
  const renderer = new TrainRenderer(map, overlay, fixtureUrl);
  const probe = new FrameProbe(() => map.getZoom());
  map.on("render", () => probe.noteMapDraw());
  let rendererActive = false;
  let currentSpec: ScenarioSpec | null = null;
  let repaintRunning = false;

  const repaintEveryFrame = () => {
    if (!repaintRunning) return;
    map.triggerRepaint();
    requestAnimationFrame(repaintEveryFrame);
  };

  async function prepare(spec: ScenarioSpec): Promise<PrepareResult> {
    currentSpec = spec;
    repaintRunning = false;
    renderer.stop();
    rendererActive = false;
    map.resize();
    applyScene(map, spec);
    const tilesLoadedAfterMs = await waitForTiles(map);

    const baseHeightMetres = spec.terrain
      ? (map.queryTerrainElevation({ lng: spec.center[0], lat: spec.center[1] }) ?? 0)
      : 0;
    let workerInitMs = 0;
    if (spec.trains > 0 && (spec.tiers === "auto" || spec.tiers.length > 0)) {
      const ready = await renderer.configure({
        trainCount: spec.trains,
        workerSlowdown: spec.workerSlowdown,
        tiers: spec.tiers,
        thresholds: ARCHITECTURE_THRESHOLDS,
        baseHeightMetres,
        focus: focusOf(spec),
      });
      workerInitMs = ready.initMs;
      renderer.start();
      rendererActive = true;
    }
    if (!rendererActive) {
      repaintRunning = true;
      requestAnimationFrame(repaintEveryFrame);
    }
    await sleep(spec.warmupMs);
    await waitForTiles(map);
    const canvas = map.getCanvas();
    return {
      id: spec.id,
      tilesLoadedAfterMs: Math.round(tilesLoadedAfterMs),
      baseHeightMetres,
      workerInitMs: Math.round(workerInitMs),
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      canvas: { width: canvas.width, height: canvas.height },
      devicePixelRatio: window.devicePixelRatio,
    };
  }

  async function measure(durationMs: number): Promise<MeasureResult> {
    renderer.resetStats();
    gpuTimer.startRecording();
    if (currentSpec?.camera === "zoom-sweep") {
      map.easeTo({
        zoom: currentSpec.sweepTo,
        duration: durationMs,
        easing: (t) => t,
        essential: true,
      });
    }
    probe.start();
    await sleep(durationMs);
    const probeResult = probe.stop();
    const gpu = gpuTimer.stopRecording();
    return {
      probe: probeResult,
      renderer: rendererActive ? renderer.snapshot() : null,
      gpuMs: gpu.samplesMs.length > 0 ? roundSummary(summarize(gpu.samplesMs)) : null,
      gpuSamples: gpu.samplesMs.length,
      gpuDisjointFrames: gpu.disjointFrames,
      gpuTimerSupported: gpuTimer.supported,
    };
  }

  function graphicsInfo() {
    const gl = map.getCanvas().getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer:
        extension && gl ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : "unknown",
      vendor:
        extension && gl ? String(gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)) : "unknown",
    };
  }

  window.sp4 = {
    environments: ENVIRONMENTS,
    matrix: (name) => (MATRICES[name] ?? (() => []))(),
    matrixNames: () => Object.keys(MATRICES),
    prepare,
    measure,
    graphicsInfo,
    status: () => ({
      moving: map.isMoving(),
      styleLoaded: Boolean(map.isStyleLoaded()),
      tilesLoaded: map.areTilesLoaded(),
      zoom: map.getZoom(),
    }),
  };

  const manual = specFromSearch(window.location.search);
  if (manual) await prepare(manual);
}

window.sp4Ready = boot();
