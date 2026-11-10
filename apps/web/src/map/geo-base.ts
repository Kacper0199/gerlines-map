import type { GeoCollection, GeoData } from "./style/build-style.ts";
import { isLandCode, type LandCode } from "./style/map-styles.ts";

export interface LandFacts {
  readonly code: LandCode;
  readonly names: { readonly en: string; readonly de: string; readonly pl: string };
  readonly label: readonly [number, number];
  readonly fit: readonly [[number, number], [number, number]];
}

export interface PointCollection {
  readonly type: "FeatureCollection";
  readonly features: ReadonlyArray<{
    readonly type: "Feature";
    readonly geometry: { readonly type: "Point"; readonly coordinates: readonly [number, number] };
    readonly properties: Readonly<Record<string, string>>;
  }>;
}

export const EMPTY_POINTS: PointCollection = { type: "FeatureCollection", features: [] };

const NAME_OVERRIDES: Readonly<Partial<Record<LandCode, Partial<LandFacts["names"]>>>> = {
  "DE-HB": { en: "Bremen" },
};

interface RawFeature {
  readonly properties?: Record<string, unknown> | null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readLaender(collection: unknown): LandFacts[] {
  const features = (collection as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) {
    return [];
  }
  const facts: LandFacts[] = [];
  for (const feature of features as RawFeature[]) {
    const p = feature.properties ?? {};
    const code = p.code;
    const en = text(p.name_en);
    const de = text(p.name_de);
    const pl = text(p.name_pl);
    const numbers = [
      p.label_lon,
      p.label_lat,
      p.fit_west,
      p.fit_south,
      p.fit_east,
      p.fit_north,
    ].map(finite);
    if (!(isLandCode(code) && en && de && pl) || numbers.some((n) => n === undefined)) {
      continue;
    }
    const [lon, lat, west, south, east, north] = numbers as number[];
    facts.push({
      code,
      names: { en, de, pl, ...NAME_OVERRIDES[code] },
      label: [lon as number, lat as number],
      fit: [
        [west as number, south as number],
        [east as number, north as number],
      ],
    });
  }
  return facts;
}

export function landLabelPoints(laender: readonly LandFacts[]): PointCollection {
  return {
    type: "FeatureCollection",
    features: laender.map((land) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: land.label },
      properties: {
        code: land.code,
        name_en: land.names.en,
        name_de: land.names.de,
        name_pl: land.names.pl,
      },
    })),
  };
}

export type FetchJson = (url: string) => Promise<unknown>;

const NATIONAL_FILES = {
  mask: "germany-mask.geojson",
  outline: "germany-outline.geojson",
  neighbours: "neighbours.geojson",
  laender: "laender.geojson",
} as const;

type NationalKey = keyof typeof NATIONAL_FILES;

async function fetchJsonOverHttp(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return response.json();
}

function isCollection(value: unknown): value is GeoCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

export class GeoFiles {
  private readonly base: string;
  private readonly fetchJson: FetchJson;
  private held: GeoData = {};
  private readonly requests = new Map<string, Promise<GeoCollection | null>>();
  private nationalRequest: Promise<GeoData> | undefined;

  constructor(origin: string, fetchJson: FetchJson = fetchJsonOverHttp) {
    this.base = `${origin.replace(/\/+$/, "")}/geo`;
    this.fetchJson = fetchJson;
  }

  get data(): GeoData {
    return this.held;
  }

  national(): Promise<GeoData> {
    if (!this.nationalRequest) {
      const keys = Object.keys(NATIONAL_FILES) as NationalKey[];
      const request = Promise.all(
        keys.map(async (key) => {
          const collection = await this.file(NATIONAL_FILES[key]);
          if (collection) {
            this.held = { ...this.held, [key]: collection };
          }
          return collection;
        }),
      ).then((loaded) => {
        if (loaded.includes(null)) {
          this.nationalRequest = undefined;
        }
        return this.held;
      });
      this.nationalRequest = request;
    }
    return this.nationalRequest;
  }

  async landMask(code: LandCode): Promise<GeoCollection | null> {
    const collection = await this.file(`laender-masks/${code}.geojson`);
    if (collection && this.held.landMasks?.[code] !== collection) {
      this.held = { ...this.held, landMasks: { ...this.held.landMasks, [code]: collection } };
    }
    return collection;
  }

  private file(path: string): Promise<GeoCollection | null> {
    const pending = this.requests.get(path);
    if (pending) {
      return pending;
    }
    const request = this.fetchJson(`${this.base}/${path}`)
      .then((value) => (isCollection(value) ? value : Promise.reject(new Error(path))))
      .catch(() => {
        this.requests.delete(path);
        return null;
      });
    this.requests.set(path, request);
    return request;
  }
}

const shared = new Map<string, GeoFiles>();

export function geoFilesFor(origin: string): GeoFiles {
  let files = shared.get(origin);
  if (!files) {
    files = new GeoFiles(origin);
    shared.set(origin, files);
  }
  return files;
}
