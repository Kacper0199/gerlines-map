import type { CategoryKey } from "@gerlines/i18n";
import raw from "../fixtures/sample.json";

interface NextStop {
  readonly name: string;
  readonly scheduledArrivalMs: number;
  readonly arrivalMs: number;
  readonly departureMs: number;
  readonly platform: string;
  readonly scheduledPlatform: string;
}

export interface Sample {
  readonly capturedMs: number;
  readonly trainsTotal: number;
  readonly trainsRealtime: number;
  readonly counts: Readonly<Record<CategoryKey, number>>;
  readonly train: {
    readonly line: string;
    readonly category: CategoryKey;
    readonly operator: string;
    readonly origin: string;
    readonly destination: string;
    readonly delayMinutes: number;
    readonly nextStop: NextStop;
  };
}

const stop = raw.train.nextStop;

export const sample: Sample = {
  capturedMs: Date.parse(raw.capturedAt),
  trainsTotal: raw.trainsTotal,
  trainsRealtime: raw.trainsRealtime,
  counts: raw.countsByCategory,
  train: {
    line: raw.train.line,
    category: "hsr",
    operator: raw.train.operator,
    origin: raw.train.origin,
    destination: raw.train.destination,
    delayMinutes: raw.train.delayMinutes,
    nextStop: {
      name: stop.name,
      scheduledArrivalMs: Date.parse(stop.scheduledArrivalAt),
      arrivalMs: Date.parse(stop.arrivalAt),
      departureMs: Date.parse(stop.departureAt),
      platform: stop.platform,
      scheduledPlatform: stop.scheduledPlatform,
    },
  },
};
