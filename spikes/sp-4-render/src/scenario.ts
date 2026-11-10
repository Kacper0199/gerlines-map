import type { Tier } from "./protocol.ts";

export type EnvironmentName = "desktop" | "phone";

export interface Environment {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  cpuSlowdown: number;
}

export const ENVIRONMENTS: Record<EnvironmentName, Environment> = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false, cpuSlowdown: 1 },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, cpuSlowdown: 4 },
};

export interface ScenarioSpec {
  id: string;
  zoom: number;
  center: [number, number];
  pitch: number;
  bearing: number;
  terrain: boolean;
  buildings: boolean;
  trains: number;
  tiers: Tier[] | "auto";
  camera: "static" | "zoom-sweep";
  sweepTo: number;
  focusTrains: number;
  workerSlowdown: number;
  warmupMs: number;
  measureMs: number;
}

export interface MatrixEntry {
  env: EnvironmentName;
  spec: ScenarioSpec;
}

const GERMANY: [number, number] = [10.45, 51.2];
const RHINE_RUHR: [number, number] = [7.0, 51.2];
const KOELN_HBF: [number, number] = [6.9589, 50.943];

const TRAIN_COUNT = 15000;
const RICH_PITCH = 50;

interface Level {
  name: string;
  zoom: number;
  center: [number, number];
  tier: Tier;
}

const LEVELS: Level[] = [
  { name: "national-z6", zoom: 6, center: GERMANY, tier: "dots" },
  { name: "regional-z9", zoom: 9, center: RHINE_RUHR, tier: "icons" },
  { name: "city-z13", zoom: 13, center: KOELN_HBF, tier: "slices" },
  { name: "close-z16", zoom: 16, center: KOELN_HBF, tier: "cars" },
];

function spec(
  overrides: Partial<ScenarioSpec> & Pick<ScenarioSpec, "id" | "zoom" | "center">,
): ScenarioSpec {
  return {
    pitch: 0,
    bearing: 0,
    terrain: false,
    buildings: false,
    trains: TRAIN_COUNT,
    tiers: [],
    camera: "static",
    sweepTo: 0,
    focusTrains: 0,
    workerSlowdown: 1,
    warmupMs: 8000,
    measureMs: 30000,
    ...overrides,
  };
}

const ENV_ORDER: EnvironmentName[] = ["desktop", "phone"];

function levelSpec(level: Level, rich: boolean, withTrains: boolean): ScenarioSpec {
  return spec({
    id: `${withTrains ? "trains" : "map-only"}.${level.name}.${rich ? "rich" : "plain"}`,
    zoom: level.zoom,
    center: level.center,
    pitch: rich ? RICH_PITCH : 0,
    terrain: rich,
    buildings: rich,
    trains: withTrains ? TRAIN_COUNT : 0,
    tiers: withTrains ? [level.tier] : [],
  });
}

function mainMatrix(withTrains: boolean): MatrixEntry[] {
  return ENV_ORDER.flatMap((env) =>
    [false, true].flatMap((rich) =>
      LEVELS.map((level) => ({ env, spec: levelSpec(level, rich, withTrains) })),
    ),
  );
}

interface Sweep {
  tier: Tier[];
  zoom: number;
  center: [number, number];
}

const SWEEPS: Sweep[] = [
  { tier: ["dots"], zoom: 9, center: RHINE_RUHR },
  { tier: ["dots"], zoom: 13, center: KOELN_HBF },
  { tier: ["icons"], zoom: 6, center: GERMANY },
  { tier: ["icons"], zoom: 12.5, center: KOELN_HBF },
  { tier: ["icons"], zoom: 13, center: KOELN_HBF },
  { tier: ["slices"], zoom: 9, center: RHINE_RUHR },
  { tier: ["slices"], zoom: 12, center: KOELN_HBF },
  { tier: ["slices"], zoom: 14.5, center: KOELN_HBF },
  { tier: ["cars"], zoom: 9, center: RHINE_RUHR },
  { tier: ["cars"], zoom: 12.5, center: KOELN_HBF },
  { tier: ["cars"], zoom: 13, center: KOELN_HBF },
  { tier: ["cars"], zoom: 14.5, center: KOELN_HBF },
  { tier: ["dots", "icons"], zoom: 9, center: RHINE_RUHR },
  { tier: ["icons", "slices"], zoom: 12.5, center: KOELN_HBF },
  { tier: ["slices", "cars"], zoom: 14.5, center: KOELN_HBF },
];

function sweepMatrix(): MatrixEntry[] {
  return ENV_ORDER.flatMap((env) =>
    SWEEPS.map((sweep) => ({
      env,
      spec: spec({
        id: `sweep.${sweep.tier.join("+")}.z${sweep.zoom}`,
        zoom: sweep.zoom,
        center: sweep.center,
        tiers: sweep.tier,
        measureMs: 20000,
      }),
    })),
  );
}

function denseMatrix(): MatrixEntry[] {
  return ENV_ORDER.flatMap((env) => [
    {
      env,
      spec: spec({
        id: "dense.close-z16.plain",
        zoom: 16,
        center: KOELN_HBF,
        tiers: ["cars"],
        focusTrains: 300,
      }),
    },
    {
      env,
      spec: spec({
        id: "dense.close-z16.rich",
        zoom: 16,
        center: KOELN_HBF,
        pitch: RICH_PITCH,
        terrain: true,
        buildings: true,
        tiers: ["cars"],
        focusTrains: 300,
      }),
    },
    {
      env,
      spec: spec({
        id: "dense.crossfade-z14.5.plain",
        zoom: 14.5,
        center: KOELN_HBF,
        tiers: ["slices", "cars"],
        focusTrains: 300,
      }),
    },
  ]);
}

interface Stress {
  label: string;
  tiers: Tier[];
  zoom: number;
  center: [number, number];
  trains: number;
  focusTrains: number;
}

const STRESSES: Stress[] = [
  {
    label: "dots-z6-30k",
    tiers: ["dots"],
    zoom: 6,
    center: GERMANY,
    trains: 30000,
    focusTrains: 0,
  },
  {
    label: "dots-z6-60k",
    tiers: ["dots"],
    zoom: 6,
    center: GERMANY,
    trains: 60000,
    focusTrains: 0,
  },
  {
    label: "dots-z6-120k",
    tiers: ["dots"],
    zoom: 6,
    center: GERMANY,
    trains: 120000,
    focusTrains: 0,
  },
  {
    label: "slices-z13-focus1200",
    tiers: ["slices"],
    zoom: 13,
    center: KOELN_HBF,
    trains: 15000,
    focusTrains: 1200,
  },
  {
    label: "cars-z16-focus600",
    tiers: ["cars"],
    zoom: 16,
    center: KOELN_HBF,
    trains: 15000,
    focusTrains: 600,
  },
  {
    label: "cars-z16-focus1200",
    tiers: ["cars"],
    zoom: 16,
    center: KOELN_HBF,
    trains: 15000,
    focusTrains: 1200,
  },
  {
    label: "cars-z16-focus2400",
    tiers: ["cars"],
    zoom: 16,
    center: KOELN_HBF,
    trains: 15000,
    focusTrains: 2400,
  },
];

function stressMatrix(): MatrixEntry[] {
  return ENV_ORDER.flatMap((env) =>
    STRESSES.map((stress) => ({
      env,
      spec: spec({
        id: `stress.${stress.label}`,
        zoom: stress.zoom,
        center: stress.center,
        tiers: stress.tiers,
        trains: stress.trains,
        focusTrains: stress.focusTrains,
        measureMs: 20000,
      }),
    })),
  );
}

function zoomSweepMatrix(): MatrixEntry[] {
  const base = {
    zoom: 6,
    center: KOELN_HBF,
    tiers: "auto" as const,
    camera: "zoom-sweep" as const,
    sweepTo: 17,
    measureMs: 66000,
  };
  return ENV_ORDER.flatMap((env) => [
    { env, spec: spec({ ...base, id: "zoom-sweep.real-density.plain" }) },
    { env, spec: spec({ ...base, id: "zoom-sweep.dense.plain", focusTrains: 300 }) },
    {
      env,
      spec: spec({
        ...base,
        id: "zoom-sweep.dense.rich",
        focusTrains: 300,
        pitch: RICH_PITCH,
        terrain: true,
        buildings: true,
      }),
    },
  ]);
}

export const MATRICES: Record<string, () => MatrixEntry[]> = {
  main: () => mainMatrix(true),
  "map-only": () => mainMatrix(false),
  sweep: sweepMatrix,
  dense: denseMatrix,
  stress: stressMatrix,
  "zoom-sweep": zoomSweepMatrix,
};

export function specFromSearch(search: string): ScenarioSpec | null {
  const params = new URLSearchParams(search);
  if (!params.has("zoom")) return null;
  const tiers = (params.get("tiers") ?? "").split(",").filter(Boolean) as Tier[];
  return spec({
    id: "manual",
    zoom: Number(params.get("zoom")),
    center: [Number(params.get("lon") ?? KOELN_HBF[0]), Number(params.get("lat") ?? KOELN_HBF[1])],
    pitch: Number(params.get("pitch") ?? 0),
    bearing: Number(params.get("bearing") ?? 0),
    terrain: params.get("terrain") === "1",
    buildings: params.get("buildings") === "1",
    trains: Number(params.get("trains") ?? TRAIN_COUNT),
    tiers,
    focusTrains: Number(params.get("focus") ?? 0),
    workerSlowdown: Number(params.get("slowdown") ?? 1),
  });
}
