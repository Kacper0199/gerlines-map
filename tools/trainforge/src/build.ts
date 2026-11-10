import type { CatalogInput, VehicleInput } from "./catalog.ts";
import { type ConsistLayout, consistLayout } from "./consist.ts";
import { buildBody, buildBogie } from "./geometry/car-body.ts";
import { CAR_BUDGET, LODS, type LodLevel, type LodSettings } from "./geometry/lod.ts";
import type { MeshBuilder } from "./geometry/mesh.ts";
import { writeGlb } from "./gltf.ts";
import { type LiveryRules, liveryRules } from "./livery-rules.ts";
import { dbOperators, drawsDbLogo, withoutLogo } from "./logo.ts";
import {
  ATLAS_COLUMNS,
  atlasPng,
  liveryRow,
  logoRows,
  modelRow,
  neutralRow,
  type PaletteRow,
  SLOTS,
} from "./palette.ts";
import { type BogieSpec, bogieKey, type CarSpec, resolveCar } from "./spec.ts";

export const AXES =
  "glTF +x forward, +y up, +z right; origin at the car centre on top of rail; metres";

export interface LodOutput {
  readonly level: LodLevel;
  readonly file: string;
  readonly bodyTriangles: number;
  /** Body plus the bogies of its two pivots, the per-car budget figure. */
  readonly carTriangles: number;
  readonly budget: number;
  readonly bytes: number;
  readonly rawBytes: number;
}

export interface CarOutput {
  readonly carType: string;
  readonly name: string;
  readonly role: string;
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
  readonly bogies: readonly {
    readonly xM: number;
    readonly kind: string;
    readonly bogie: string;
  }[];
  readonly jacobs: boolean;
  readonly estimated: readonly string[];
  readonly sources: readonly string[];
  readonly lods: readonly LodOutput[];
}

export interface BogieLodOutput {
  readonly level: LodLevel;
  readonly file: string;
  readonly triangles: number;
  readonly bytes: number;
}

export interface BogieOutput {
  readonly wheelbaseM: number;
  readonly wheelDiameterM: number;
  readonly lods: readonly BogieLodOutput[];
}

export interface ModelOutput {
  readonly modelId: string;
  readonly name: string;
  readonly seriesId: string | null;
  readonly category: string;
  readonly generic: boolean;
  readonly livery: {
    readonly id: string;
    readonly row: number;
    readonly sourcedSlots: readonly string[];
  };
  readonly unitLengthM: number | null;
  readonly formation: readonly { readonly carType: string; readonly reversed: boolean }[];
  readonly consist: ConsistLayout;
  readonly bogies: Readonly<Record<string, BogieOutput>>;
  readonly carTypes: readonly CarOutput[];
}

export interface BuildResult {
  readonly models: readonly ModelOutput[];
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly paletteRows: readonly PaletteRow[];
  readonly liveryRules: LiveryRules;
}

const r3 = (value: number) => Math.round(value * 1000) / 1000;

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The shared atlas: the neutral row, then one row per livery in code-point order of its id. */
function paletteRows(catalog: CatalogInput): PaletteRow[] {
  const db = dbOperators(catalog.operators ?? []);
  const liveries = [...catalog.liveries]
    .sort((a, b) => byCodePoint(a.livery_id, b.livery_id))
    .map((livery) => liveryRow(livery, db.has(livery.operator_id ?? "")));
  return [neutralRow(), ...liveries];
}

function rowOf(model: VehicleInput, rows: readonly PaletteRow[]) {
  const index = model.livery_id ? rows.findIndex((r) => r.id === model.livery_id) : 0;
  const found = Math.max(0, index);
  return { row: rows[found] as PaletteRow, index: found };
}

function carExtras(
  spec: CarSpec,
  model: VehicleInput,
  level: LodLevel,
  liveryId: string,
  triangles: number,
) {
  return {
    gerlines: {
      schema: 2,
      kind: "car",
      modelId: model.model_id,
      seriesId: model.series_id ?? null,
      carType: spec.carType,
      role: spec.role,
      category: model.category,
      lod: level,
      axes: AXES,
      lengthM: r3(spec.length),
      widthM: r3(spec.width),
      heightM: r3(spec.height),
      floorM: r3(spec.floor),
      bogies: spec.bogies.map((b) => ({ xM: r3(b.x), kind: b.kind, bogie: bogieKey(b) })),
      jacobs: spec.bogies.some((b) => b.kind === "jacobs"),
      livery: liveryId,
      palette: { columns: ATLAS_COLUMNS, slots: SLOTS, rowV: 0.5, modeSlot: "mode" },
      estimated: spec.estimated,
      sources: spec.sources,
      triangles,
    },
  };
}

async function buildBogies(
  model: VehicleInput,
  bogies: readonly BogieSpec[],
  png: Uint8Array,
  files: Map<string, Uint8Array>,
): Promise<Record<string, BogieOutput>> {
  const unique = new Map<string, BogieSpec>();
  for (const b of bogies) if (!unique.has(bogieKey(b))) unique.set(bogieKey(b), b);
  const out: Record<string, BogieOutput> = {};
  for (const key of [...unique.keys()].sort(byCodePoint)) {
    const bogie = unique.get(key) as BogieSpec;
    const lods: BogieLodOutput[] = [];
    for (const lod of LODS) {
      const file = `models/${model.model_id}/${key}.lod${lod.level}.glb`;
      const glb = await writeGlb(buildBogie(bogie, lod), png, key, {
        gerlines: {
          schema: 2,
          kind: "bogie",
          modelId: model.model_id,
          lod: lod.level,
          axes: "glTF +x forward, +y up, +z right; origin at the bogie pivot on top of rail; metres",
          wheelbaseM: r3(bogie.wheelbase),
          wheelDiameterM: r3(bogie.wheelDiameter),
        },
      });
      files.set(file, glb.glb);
      lods.push({ level: lod.level, file, triangles: glb.triangles, bytes: glb.glb.byteLength });
    }
    out[key] = { wheelbaseM: r3(bogie.wheelbase), wheelDiameterM: r3(bogie.wheelDiameter), lods };
  }
  return out;
}

const FALLBACKS: readonly Partial<LodSettings>[] = [
  {},
  { noseLevels: "band" },
  { noseLevels: "none" },
  { noseLevels: "none", frontStripe: false },
  { noseLevels: "none", frontStripe: false, roofSegments: 4, lowerSegments: 2 },
];

/** The body at a level of detail, with the front simplified step by step until the car fits its budget. */
function fitBody(spec: CarSpec, lod: LodSettings, allowance: number): MeshBuilder {
  let body: MeshBuilder | undefined;
  for (const step of FALLBACKS) {
    const settings = { ...lod, ...step };
    if (step.noseLevels === "band" && lod.noseLevels !== "full") continue;
    if (step.roofSegments && step.roofSegments >= lod.roofSegments) continue;
    body = buildBody(spec, settings);
    if (body.triangleCount <= allowance) return body;
  }
  return body as MeshBuilder;
}

async function buildCar(
  model: VehicleInput,
  spec: CarSpec,
  png: Uint8Array,
  liveryId: string,
  bogies: Readonly<Record<string, BogieOutput>>,
  files: Map<string, Uint8Array>,
): Promise<CarOutput> {
  const lods: LodOutput[] = [];
  for (const lod of LODS) {
    const bogieTriangles = spec.bogies.reduce(
      (sum, b) =>
        sum + (bogies[bogieKey(b)]?.lods.find((l) => l.level === lod.level)?.triangles ?? 0),
      0,
    );
    const body = fitBody(spec, lod, CAR_BUDGET[lod.level] - bogieTriangles);
    const file = `models/${model.model_id}/${spec.carType}.lod${lod.level}.glb`;
    const out = await writeGlb(
      body,
      png,
      `${model.model_id}-${spec.carType}`,
      carExtras(spec, model, lod.level, liveryId, body.triangleCount),
    );
    files.set(file, out.glb);
    lods.push({
      level: lod.level,
      file,
      bodyTriangles: out.triangles,
      carTriangles: out.triangles + bogieTriangles,
      budget: CAR_BUDGET[lod.level],
      bytes: out.glb.byteLength,
      rawBytes: out.rawBytes,
    });
  }
  return {
    carType: spec.carType,
    name: spec.name,
    role: spec.role,
    lengthM: r3(spec.length),
    widthM: r3(spec.width),
    heightM: r3(spec.height),
    bogies: spec.bogies.map((b) => ({ xM: r3(b.x), kind: b.kind, bogie: bogieKey(b) })),
    jacobs: spec.bogies.some((b) => b.kind === "jacobs"),
    estimated: spec.estimated,
    sources: spec.sources,
    lods,
  };
}

/** Generates every model of the catalogue (or the ones named in `only`) with all files in memory. */
export async function buildAll(
  catalog: CatalogInput,
  only?: readonly string[],
): Promise<BuildResult> {
  const known = new Set(catalog.vehicles.map((v) => v.model_id));
  const unknown = (only ?? []).filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`unknown model ids: ${unknown.join(", ")}`);
  const files = new Map<string, Uint8Array>();
  const rows = paletteRows(catalog);
  const models: ModelOutput[] = [];
  for (const model of catalog.vehicles) {
    if (only && !only.includes(model.model_id)) continue;
    const { row, index } = rowOf(model, rows);
    const png = atlasPng([modelRow(row, model.category)]);
    const logo = drawsDbLogo(model, catalog);
    const specs = new Map(
      model.car_types.map((car) => {
        const spec = resolveCar(model, car);
        return [car.car_type, logo ? spec : withoutLogo(spec)];
      }),
    );
    const formation = model.formation.map((f) => ({
      carType: f.car_type,
      reversed: f.reversed ?? false,
    }));
    const consist = consistLayout(
      formation.map((f) => {
        const spec = specs.get(f.carType) as CarSpec;
        return { length: spec.length, bogies: spec.bogies, reversed: f.reversed };
      }),
    );
    const bogies = await buildBogies(
      model,
      [...specs.values()].flatMap((s) => s.bogies),
      png,
      files,
    );
    const carTypes: CarOutput[] = [];
    for (const spec of specs.values())
      carTypes.push(await buildCar(model, spec, png, row.id, bogies, files));
    models.push({
      modelId: model.model_id,
      name: model.name,
      seriesId: model.series_id ?? null,
      category: model.category,
      generic: model.generic,
      livery: {
        id: row.id,
        row: index,
        sourcedSlots: SLOTS.filter((slot) => row.origin[slot] === "livery"),
      },
      unitLengthM: model.unit_length_m ?? null,
      formation,
      consist,
      bogies,
      carTypes,
    });
  }
  files.set("palette.png", atlasPng(rows));
  return { models, files, paletteRows: rows, liveryRules: liveryRules(catalog, rows) };
}

export function manifestJson(result: BuildResult): string {
  return `${JSON.stringify(
    {
      schema: 2,
      axes: AXES,
      palette: {
        file: "palette.png",
        columns: ATLAS_COLUMNS,
        slots: SLOTS,
        rows: result.paletteRows.map((row) => row.id),
        logoRows: logoRows(result.paletteRows),
        modeSlot: "mode",
      },
      liveries: result.liveryRules,
      models: result.models,
    },
    null,
    2,
  )}\n`;
}

export function reportMarkdown(result: BuildResult): string {
  const lines = [
    "| Model | Car | LOD | Body tris | Car tris | Budget | GLB bytes | Raw bytes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  let bodies = 0;
  let bogieBytes = 0;
  for (const model of result.models) {
    for (const car of model.carTypes) {
      for (const lod of car.lods) {
        bodies += lod.bytes;
        lines.push(
          `| ${model.modelId} | ${car.carType} | ${lod.level} | ${lod.bodyTriangles} | ${lod.carTriangles} | ${lod.budget} | ${lod.bytes} | ${lod.rawBytes} |`,
        );
      }
    }
    for (const bogie of Object.values(model.bogies))
      for (const lod of bogie.lods) bogieBytes += lod.bytes;
  }
  const palette = result.files.get("palette.png")?.byteLength ?? 0;
  lines.push(
    "",
    `Car body files ${bodies} B, bogie files ${bogieBytes} B, palette ${palette} B, total ${bodies + bogieBytes + palette} B.`,
  );
  return `${lines.join("\n")}\n`;
}
