import { z } from "zod";

const count = z.int().positive();
const month = z.string().regex(/^\d{4}-\d{2}$/);
const field = z.tuple([z.int().min(0).max(52), z.int().min(1).max(32)]);
const LEVEL_NAMES = ["train", "stop", "category"] as const;
const KEY_FIELDS = ["category", "train_number", "eva", "band", "horizon"] as const;

export type ForecastLevel = (typeof LEVEL_NAMES)[number];
type KeyField = (typeof KEY_FIELDS)[number];

const Meta = z.object({
  method: z.string().min(1),
  variant: z.enum(["level", "change"]),
  trainedFrom: month,
  trainedTo: month,
  minRuns: count,
  maxAhead: count,
  shippedAhead: z.array(count),
  bandUpperMinutes: z.tuple([z.int(), z.int(), z.int()]),
  horizonUpperStops: z.tuple([count, count, count]),
  key: z.object({
    categories: z.array(z.string().min(1)).min(1),
    evaBase: z.int().nonnegative(),
    fields: z.record(z.enum(KEY_FIELDS), field),
    levels: z.object({
      train: z.array(z.enum(KEY_FIELDS)),
      stop: z.array(z.enum(KEY_FIELDS)),
      category: z.array(z.enum(KEY_FIELDS)),
    }),
  }),
  source: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.url({ protocol: /^https$/ }),
    licence: z.string().min(1),
    attribution: z.string().min(1),
  }),
});

const numbers = z.array(z.number());
const Columns = z.object({ key: numbers, runs: numbers, median: numbers, p80: numbers });

/** The B1 table `gerlines-predict table` writes (format 2), after gunzip: meta and one set of
 * columns per level, sorted by the packed key. `runs` counts distinct service days and runs. */
export const PredictionTableFile = z.object({
  format: z.literal(2),
  meta: Meta,
  train: Columns,
  stop: Columns,
  category: Columns,
});

export type PredictionTableFile = z.infer<typeof PredictionTableFile>;

export interface Quantiles {
  readonly level: ForecastLevel;
  readonly runs: number;
  readonly median: number;
  readonly p80: number;
}

export interface LookupKey {
  readonly category: string;
  readonly trainNumber: number;
  readonly eva: number;
  readonly band: number;
  readonly horizon: number;
}

const LICENCE_URLS: Readonly<Record<string, string>> = {
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
};

interface Level {
  readonly fields: readonly KeyField[];
  readonly keys: Float64Array;
  readonly runs: Uint32Array;
  readonly median: Int16Array;
  readonly p80: Int16Array;
}

function levelOf(name: ForecastLevel, columns: z.infer<typeof Columns>, fields: KeyField[]): Level {
  const size = columns.key.length;
  if ([columns.runs, columns.median, columns.p80].some((column) => column.length !== size)) {
    throw new Error(`${name}: columns differ in length`);
  }
  const keys = Float64Array.from(columns.key);
  for (let i = 0; i < size; i += 1) {
    const key = keys[i] ?? Number.NaN;
    const median = columns.median[i] ?? Number.NaN;
    const upper = columns.p80[i] ?? Number.NaN;
    if (!Number.isSafeInteger(key) || (i > 0 && key <= (keys[i - 1] ?? 0))) {
      throw new Error(`${name}: keys must be increasing integers`);
    }
    if (!Number.isInteger(median) || !Number.isInteger(upper) || upper < median) {
      throw new Error(`${name}: quantiles must be integers with p80 at least the median`);
    }
  }
  return {
    fields,
    keys,
    runs: Uint32Array.from(columns.runs),
    median: Int16Array.from(columns.median),
    p80: Int16Array.from(columns.p80),
  };
}

function find(keys: Float64Array, key: number): number {
  let low = 0;
  let high = keys.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = keys[middle] ?? Number.NaN;
    if (value === key) return middle;
    if (value < key) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

/**
 * The B1 quantiles in typed arrays, answered in the order the backtest used: this train number at
 * this stop when it has at least `minRuns` runs, then the category at this stop with as many, then
 * the category. Rows the builder pruned answer exactly as their fallback, so the lookup equals the
 * full table; the level and runs reported are those of the level that answers.
 */
export class PredictionTable {
  readonly meta: PredictionTableFile["meta"];
  readonly licenceUrl: string | null;
  private readonly shipped: ReadonlySet<number>;
  private readonly levels: readonly (readonly [ForecastLevel, Level])[];
  private readonly categories: ReadonlyMap<string, number>;

  constructor(file: PredictionTableFile) {
    this.meta = file.meta;
    this.licenceUrl = LICENCE_URLS[file.meta.source.licence] ?? null;
    this.shipped = new Set(file.meta.shippedAhead);
    this.categories = new Map(file.meta.key.categories.map((name, index) => [name, index]));
    this.levels = LEVEL_NAMES.map(
      (name) => [name, levelOf(name, file[name], file.meta.key.levels[name])] as const,
    );
  }

  static parse(json: unknown): PredictionTable {
    return new PredictionTable(PredictionTableFile.parse(json));
  }

  get size(): number {
    return this.levels.reduce((sum, [, level]) => sum + level.keys.length, 0);
  }

  /** True when B1 beat persistence at this many served stops ahead in the backtest. */
  ships(stopsAhead: number): boolean {
    return stopsAhead <= this.meta.maxAhead && this.shipped.has(stopsAhead);
  }

  /** The band of a current delay in whole minutes: on time, 1 to 5, 6 to 15, over 15. */
  band(delayMinutes: number): number {
    const index = this.meta.bandUpperMinutes.findIndex((upper) => delayMinutes <= upper);
    return index === -1 ? this.meta.bandUpperMinutes.length : index;
  }

  /** The horizon bucket of a count of served stops ahead: 1, 2 to 3, 4 to 7, 8 or more. */
  horizon(stopsAhead: number): number {
    const index = this.meta.horizonUpperStops.findIndex((upper) => stopsAhead <= upper);
    return index === -1 ? this.meta.horizonUpperStops.length : index;
  }

  private pack(fields: readonly KeyField[], key: LookupKey, category: number): number | null {
    const values: Record<KeyField, number> = {
      category,
      train_number: key.trainNumber,
      eva: key.eva - this.meta.key.evaBase,
      band: key.band,
      horizon: key.horizon,
    };
    let packed = 0;
    for (const name of fields) {
      const place = this.meta.key.fields[name];
      const value = values[name];
      if (!place || !Number.isInteger(value) || value < 0 || value >= 2 ** place[1]) return null;
      packed += value * 2 ** place[0];
    }
    return packed;
  }

  lookup(key: LookupKey): Quantiles | null {
    const category = this.categories.get(key.category);
    if (category === undefined) return null;
    for (const [name, level] of this.levels) {
      const packed = this.pack(level.fields, key, category);
      const at = packed === null ? -1 : find(level.keys, packed);
      if (at >= 0) {
        return {
          level: name,
          runs: level.runs[at] ?? 0,
          median: level.median[at] ?? 0,
          p80: level.p80[at] ?? 0,
        };
      }
    }
    return null;
  }
}
