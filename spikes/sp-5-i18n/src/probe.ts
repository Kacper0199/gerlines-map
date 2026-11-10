import { changeLocale, copyFor, type Locale } from "@gerlines/i18n";
import type { Map as MapLibreMap } from "maplibre-gl";
import { nameLabelLayerIds } from "./map/labels.ts";
import { currentMap, registryStats } from "./map/registry.ts";

interface RunOptions {
  readonly sequence: readonly Locale[];
  readonly idleTimeoutMs?: number;
  readonly settleMs?: number;
}

interface SwitchTiming {
  readonly to: Locale;
  readonly commitMs: number;
  readonly paintMs: number;
  readonly idleMs: number | null;
}

interface Summary {
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

const ids = new WeakMap<object, number>();
let nextId = 1;

function idOf(value: object | null): number | null {
  if (value === null) {
    return null;
  }
  const known = ids.get(value);
  if (known !== undefined) {
    return known;
  }
  ids.set(value, nextId);
  nextId += 1;
  return nextId - 1;
}

function summarise(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
  return { median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function resourceCounts() {
  const counts = {
    tiles: 0,
    glyphs: 0,
    styles: 0,
    sprites: 0,
    other: 0,
    otherUrls: [] as string[],
  };
  for (const entry of performance.getEntriesByType("resource")) {
    const url = entry.name;
    if (url.includes("/fonts/")) {
      counts.glyphs += 1;
    } else if (url.includes("/styles/")) {
      counts.styles += 1;
    } else if (url.includes("/sprites/")) {
      counts.sprites += 1;
    } else if (url.includes("/planet/")) {
      counts.tiles += 1;
    } else {
      counts.other += 1;
      counts.otherUrls.push(url);
    }
  }
  return counts;
}

function identity(map: MapLibreMap) {
  return {
    map: idOf(map),
    canvas: idOf(map.getCanvas()),
    container: idOf(map.getContainer()),
    main: idOf(document.querySelector("main")),
    brandHeading: idOf(document.querySelector(".brand h1")),
    cardToggle: idOf(document.querySelector(".train .more")),
    center: map
      .getCenter()
      .toArray()
      .map((value) => Number(value.toFixed(5))),
    zoom: Number(map.getZoom().toFixed(4)),
  };
}

function trackMapEvents(map: MapLibreMap) {
  const counts = { styleLoad: 0, sourceDataLoading: 0, tileDataLoading: 0, mapLoad: 0, error: 0 };
  const onStyleLoad = () => {
    counts.styleLoad += 1;
  };
  const onLoad = () => {
    counts.mapLoad += 1;
  };
  const onError = () => {
    counts.error += 1;
  };
  const onDataLoading = (event: { dataType?: string; tile?: unknown }) => {
    if (event.dataType === "source") {
      counts.sourceDataLoading += 1;
      if (event.tile !== undefined) {
        counts.tileDataLoading += 1;
      }
    }
  };
  map.on("style.load", onStyleLoad);
  map.on("load", onLoad);
  map.on("error", onError);
  map.on("dataloading", onDataLoading);
  return {
    counts,
    stop: () => {
      map.off("style.load", onStyleLoad);
      map.off("load", onLoad);
      map.off("error", onError);
      map.off("dataloading", onDataLoading);
    },
  };
}

function trackLongTasks() {
  const tasks: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      tasks.push(entry.duration);
    }
  });
  observer.observe({ type: "longtask", buffered: false });
  return {
    tasks,
    stop: () => {
      observer.disconnect();
    },
  };
}

function waitForIdle(map: MapLibreMap, timeoutMs: number): Promise<number | null> {
  const started = performance.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      map.off("idle", onIdle);
      resolve(null);
    }, timeoutMs);
    const onIdle = () => {
      clearTimeout(timer);
      resolve(performance.now() - started);
    };
    map.once("idle", onIdle);
  });
}

async function waitForTagline(expected: string, startedAt: number): Promise<number> {
  const heading = () => document.querySelector(".brand p")?.textContent;
  while (heading() !== expected) {
    await Promise.resolve();
    if (performance.now() - startedAt > 2000) {
      break;
    }
  }
  return performance.now() - startedAt;
}

async function switchTo(
  map: MapLibreMap,
  to: Locale,
  idleTimeoutMs: number,
): Promise<SwitchTiming> {
  const idle = waitForIdle(map, idleTimeoutMs);
  const startedAt = performance.now();
  const pending = changeLocale(to);
  const commitMs = await waitForTagline(copyFor(to).brand.tagline, startedAt);
  await nextFrame();
  await nextFrame();
  const paintMs = performance.now() - startedAt;
  await pending;
  return { to, commitMs, paintMs, idleMs: await idle };
}

async function run(options: RunOptions) {
  const map = currentMap();
  if (map === null) {
    throw new Error("The map is not mounted");
  }
  const idleTimeoutMs = options.idleTimeoutMs ?? 4000;
  const settleMs = options.settleMs ?? 300;
  const before = identity(map);
  const resourcesBefore = resourceCounts();
  const registryBefore = { ...registryStats };
  const events = trackMapEvents(map);
  const longTasks = trackLongTasks();
  const timings: SwitchTiming[] = [];
  for (const to of options.sequence) {
    timings.push(await switchTo(map, to, idleTimeoutMs));
    await sleep(settleMs);
  }
  events.stop();
  longTasks.stop();
  const after = identity(map);
  const resourcesAfter = resourceCounts();
  const idles = timings.flatMap((timing) => (timing.idleMs === null ? [] : [timing.idleMs]));
  return {
    sameMap: before.map === after.map,
    sameCanvas: before.canvas === after.canvas,
    sameContainer: before.container === after.container,
    sameMain: before.main === after.main,
    sameBrandHeading: before.brandHeading === after.brandHeading,
    sameCardToggle: before.cardToggle === after.cardToggle,
    cameraUnchanged: before.zoom === after.zoom && before.center.join() === after.center.join(),
    registry: {
      createdDuring: registryStats.created - registryBefore.created,
      removedDuring: registryStats.removed - registryBefore.removed,
    },
    mapEvents: events.counts,
    resourceDelta: {
      tiles: resourcesAfter.tiles - resourcesBefore.tiles,
      glyphs: resourcesAfter.glyphs - resourcesBefore.glyphs,
      styles: resourcesAfter.styles - resourcesBefore.styles,
      sprites: resourcesAfter.sprites - resourcesBefore.sprites,
      other: resourcesAfter.other - resourcesBefore.other,
      otherUrls: resourcesAfter.otherUrls.filter((url) => !resourcesBefore.otherUrls.includes(url)),
    },
    switches: timings.length,
    commitMs: summarise(timings.map((timing) => timing.commitMs)),
    paintMs: summarise(timings.map((timing) => timing.paintMs)),
    idleMs: idles.length === 0 ? null : summarise(idles),
    idleMissed: timings.length - idles.length,
    longTasks: { count: longTasks.tasks.length, maxMs: Math.max(0, ...longTasks.tasks) },
    htmlLang: document.documentElement.lang,
    nameKeysInTiles: nameKeysInTiles(map),
  };
}

function nameKeysInTiles(map: MapLibreMap) {
  const features = map.querySourceFeatures("openmaptiles", { sourceLayer: "place" });
  const has = (key: string) =>
    features.filter((feature) => feature.properties[key] !== undefined).length;
  return {
    placeFeatures: features.length,
    withNamePl: has("name:pl"),
    withNameEn: has("name:en"),
    withNameDe: has("name:de"),
    withName: has("name"),
    withNameLatin: has("name:latin"),
    withNameNonLatin: has("name:nonlatin"),
    plFallsBackToLatin: features.filter(
      (feature) =>
        feature.properties["name:pl"] === undefined &&
        feature.properties["name:latin"] !== undefined,
    ).length,
  };
}

function labelFields(map: MapLibreMap) {
  return nameLabelLayerIds(map).map((id) => ({
    id,
    textField: JSON.stringify(map.getLayoutProperty(id, "text-field")),
  }));
}

async function ready(): Promise<boolean> {
  while (currentMap() === null) {
    await sleep(50);
  }
  const map = currentMap();
  if (map === null) {
    return false;
  }
  if (!map.loaded() || map.isMoving()) {
    await waitForIdle(map, 20000);
  }
  return map.loaded();
}

export function installProbe(): void {
  Object.defineProperty(window, "__sp5", {
    value: {
      run,
      labelFields: () => {
        const map = currentMap();
        return map === null ? [] : labelFields(map);
      },
      jumpTo: (lng: number, lat: number, zoom: number) => {
        currentMap()?.jumpTo({ center: [lng, lat], zoom });
      },
      ready,
      registry: registryStats,
    },
  });
}
