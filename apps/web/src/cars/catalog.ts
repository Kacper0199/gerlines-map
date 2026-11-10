import { type Consist, joinConsists } from "@gerlines/geo";
import type { Category, TripRecord } from "@gerlines/live-frame";
import { IDENTICAL_BODY_TABLE } from "./identical-bodies.generated.ts";
import { type BodyTable, bodyOf } from "./identical-body-rules.ts";
import {
  type LiveryBook,
  type LiveryManifest,
  type LiveryTrip,
  NEUTRAL_ROW,
  parseLiveryBook,
} from "./livery.ts";

/** Levels of detail of the forge, 0 the finest. */
export const LOD_LEVELS = 3;
/** The most units a fleet rule couples (fleet_rule units 1 to 4). */
export const MAX_COUPLED_UNITS = 4;

export interface CarSlot {
  readonly carType: string;
  readonly reversed: boolean;
}

/** One train model of the forge's manifest, ready for placement and drawing. */
export interface CarModel {
  readonly modelId: string;
  readonly generic: boolean;
  /** Units of the model coupled front to back (double traction is 2). */
  readonly units: number;
  readonly liveryRow: number;
  readonly consist: Consist;
  readonly cars: readonly CarSlot[];
  /** Mesh key of the bogie drawn at each pivot of the consist (a Jacobs bogie once). */
  readonly pivotMeshes: readonly string[];
  /** Mesh key of each car of the formation. */
  readonly carMeshes: readonly string[];
}

/** A mesh of the forge with its file per level of detail (index = level). */
export interface MeshFiles {
  readonly key: string;
  readonly files: readonly string[];
}

export interface PaletteLayout {
  readonly file: string;
  readonly columns: number;
  readonly rows: number;
  readonly modeColumn: number;
  readonly lightColumn: number;
  readonly tailColumn: number;
  /** Columns of the DB logo's field and ink; the logo triangles of a row without a logo are culled. */
  readonly logoColumns: readonly number[];
  /** Per palette row whether it shows the DB logo (the forge's logoRows; every row when the manifest lists none). */
  readonly logoRows: readonly boolean[];
}

export interface CarCatalog {
  readonly models: ReadonlyMap<string, CarModel>;
  /**
   * Per catalogue series the model drawn for it (the first the manifest lists), coupled 1 to
   * MAX_COUPLED_UNITS times: index units - 1.
   */
  readonly bySeries: ReadonlyMap<string, readonly CarModel[]>;
  readonly meshes: ReadonlyMap<string, MeshFiles>;
  readonly palette: PaletteLayout;
  /** Which palette row paints a train of an operator and series. */
  readonly liveries: LiveryBook;
}

interface ManifestLod {
  readonly level: number;
  readonly file: string;
}

interface ManifestModel {
  readonly modelId: string;
  readonly seriesId?: string | null;
  readonly generic: boolean;
  readonly livery: { readonly row: number };
  readonly formation: readonly { readonly carType: string; readonly reversed: boolean }[];
  readonly consist: {
    readonly length: number;
    readonly bogieOffsets: readonly number[];
    readonly pivots: readonly { readonly bogie: string }[];
    readonly cars: readonly {
      readonly front: number;
      readonly rear: number;
      readonly centreFraction: number;
    }[];
  };
  readonly bogies: Readonly<Record<string, { readonly lods: readonly ManifestLod[] }>>;
  readonly carTypes: readonly { readonly carType: string; readonly lods: readonly ManifestLod[] }[];
}

interface Manifest {
  readonly schema: number;
  readonly palette: {
    readonly file: string;
    readonly columns: number;
    readonly slots: readonly string[];
    readonly rows: readonly string[];
    readonly logoRows?: readonly number[];
    readonly modeSlot: string;
  };
  readonly liveries?: LiveryManifest;
  readonly models: readonly ManifestModel[];
}

export const MANIFEST_SCHEMA = 2;

/**
 * The generic model drawn for a frame category: for a train whose frame names no series (layer L4,
 * the same mapping as the category rules of catalog/fleet-rules.yaml) or a series the forge has no
 * model of; a foreign train takes the model of its own service.
 */
export const GENERIC_MODEL_OF: Readonly<Record<Category, string>> = {
  hsr: "generic-hsr",
  ld: "generic-ld",
  night: "generic-ld",
  rfast: "generic-reg-dd",
  reg: "generic-reg-emu",
  unknown: "generic-reg-emu",
  bus: "generic-reg-emu",
  sbahn: "generic-sbahn",
  urban: "generic-sbahn",
};

function columnOf(slots: readonly string[], name: string): number {
  const index = slots.indexOf(name);
  if (index < 0) throw new Error(`palette has no ${name} slot`);
  return index;
}

function lodFiles(lods: readonly ManifestLod[], key: string): readonly string[] {
  const files: string[] = [];
  for (let level = 0; level < LOD_LEVELS; level++) {
    const lod = lods.find((entry) => entry.level === level);
    if (!lod) throw new Error(`${key} has no level ${level}`);
    files.push(lod.file);
  }
  return files;
}

function consistOf(model: ManifestModel): Consist {
  const { consist } = model;
  return {
    length: consist.length,
    carCount: consist.cars.length,
    bogieOffsets: Float64Array.from(consist.bogieOffsets),
    carFront: Int32Array.from(consist.cars.map((car) => car.front)),
    carRear: Int32Array.from(consist.cars.map((car) => car.rear)),
    carCentreFraction: Float64Array.from(consist.cars.map((car) => car.centreFraction)),
  };
}

/** The model coupled `units` times front to back: each unit as built, so the inner cabs meet. */
export function coupledModel(model: CarModel, units: number): CarModel {
  if (units <= 1) return model;
  const repeat = <T>(items: readonly T[]): T[] => Array.from({ length: units }, () => items).flat();
  return {
    ...model,
    units,
    consist: joinConsists(Array.from({ length: units }, () => model.consist)),
    cars: repeat(model.cars),
    pivotMeshes: repeat(model.pivotMeshes),
    carMeshes: repeat(model.carMeshes),
  };
}

/** Reads the forge's manifest (schema 2); throws on anything a placement could not trust. */
export function parseCatalog(manifest: unknown): CarCatalog {
  const data = manifest as Manifest;
  if (data?.schema !== MANIFEST_SCHEMA) {
    throw new Error(`train manifest schema ${String(data?.schema)}, expected ${MANIFEST_SCHEMA}`);
  }
  const slots = data.palette.slots;
  const palette: PaletteLayout = {
    file: data.palette.file,
    columns: data.palette.columns,
    rows: data.palette.rows.length,
    modeColumn: columnOf(slots, data.palette.modeSlot),
    lightColumn: columnOf(slots, "light"),
    tailColumn: columnOf(slots, "tail"),
    logoColumns: ["logo", "logo_ink"].map((name) => slots.indexOf(name)).filter((i) => i >= 0),
    logoRows: data.palette.rows.map(
      (_, row) => !data.palette.logoRows || data.palette.logoRows.includes(row),
    ),
  };
  const models = new Map<string, CarModel>();
  const meshes = new Map<string, MeshFiles>();
  for (const model of data.models) {
    for (const carType of model.carTypes) {
      const key = `${model.modelId}/${carType.carType}`;
      meshes.set(key, { key, files: lodFiles(carType.lods, key) });
    }
    for (const [bogie, entry] of Object.entries(model.bogies)) {
      const key = `${model.modelId}/${bogie}`;
      meshes.set(key, { key, files: lodFiles(entry.lods, key) });
    }
    const consist = consistOf(model);
    if (consist.carCount !== model.formation.length) {
      throw new Error(`${model.modelId}: formation and consist disagree`);
    }
    if (model.consist.pivots.length !== consist.bogieOffsets.length) {
      throw new Error(`${model.modelId}: pivots and bogie offsets disagree`);
    }
    const carMeshes = model.formation.map((car) => `${model.modelId}/${car.carType}`);
    const pivotMeshes = model.consist.pivots.map((pivot) => `${model.modelId}/${pivot.bogie}`);
    for (const key of [...carMeshes, ...pivotMeshes]) {
      if (!meshes.has(key)) throw new Error(`${model.modelId}: no files for ${key}`);
    }
    models.set(model.modelId, {
      modelId: model.modelId,
      generic: model.generic,
      units: 1,
      liveryRow: model.livery.row,
      consist,
      cars: model.formation.map((car) => ({ carType: car.carType, reversed: car.reversed })),
      pivotMeshes,
      carMeshes,
    });
  }
  return {
    models,
    bySeries: seriesModels(data.models, models),
    meshes,
    palette,
    liveries: parseLiveryBook(data.liveries),
  };
}

/** The first model the manifest lists per series, coupled 1 to MAX_COUPLED_UNITS times. */
function seriesModels(
  listed: readonly ManifestModel[],
  models: ReadonlyMap<string, CarModel>,
): Map<string, readonly CarModel[]> {
  const bySeries = new Map<string, readonly CarModel[]>();
  for (const model of listed) {
    const seriesId = model.seriesId;
    const parsed = models.get(model.modelId);
    if (model.generic || !seriesId || !parsed || bySeries.has(seriesId)) continue;
    bySeries.set(
      seriesId,
      Array.from({ length: MAX_COUPLED_UNITS }, (_, i) => coupledModel(parsed, i + 1)),
    );
  }
  return bySeries;
}

/**
 * The model a train is drawn with: its series' model with its units when the frame names a series
 * the forge has, else the model of the series whose body the table of identical bodies names for
 * it, else the generic model of its category; undefined when the build lacks all three.
 */
export function modelForTrain(
  catalog: CarCatalog,
  trip: Pick<TripRecord, "category" | "series" | "units">,
  bodies: BodyTable = IDENTICAL_BODY_TABLE,
): CarModel | undefined {
  const variants = trip.series ? seriesVariants(catalog, trip.series, bodies) : undefined;
  if (!variants) return modelForCategory(catalog, trip.category);
  const units = Math.min(Math.max(trip.units ?? 1, 1), MAX_COUPLED_UNITS);
  return variants[units - 1];
}

function seriesVariants(
  catalog: CarCatalog,
  series: string,
  bodies: BodyTable,
): readonly CarModel[] | undefined {
  const own = catalog.bySeries.get(series);
  if (own) return own;
  const related = bodyOf(bodies, series);
  return related ? catalog.bySeries.get(related.relatedSeriesId) : undefined;
}

/** The model a train of this frame category is drawn with, undefined when the build lacks it. */
export function modelForCategory(catalog: CarCatalog, category: Category): CarModel | undefined {
  return catalog.models.get(GENERIC_MODEL_OF[category]);
}

/**
 * The palette row a train is painted with: the livery of its operator for its series when the
 * forge has liveries for the series (the neutral row, without a logo, for any other operator),
 * else the row of its model. A generic model keeps its own row; a train drawn with the model of a
 * related series takes the neutral row, since the related model's row is that series' livery.
 */
export function liveryRowOf(
  catalog: CarCatalog,
  model: CarModel,
  trip: LiveryTrip,
  day: string,
): number {
  if (model.generic) return model.liveryRow;
  const ownModel = !trip.series || catalog.bySeries.has(trip.series);
  return catalog.liveries.rowFor(trip, day) ?? (ownModel ? model.liveryRow : NEUTRAL_ROW);
}
