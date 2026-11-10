import { z } from "zod";
import { liveKeyPath, trainDetailPath } from "./constants.ts";

export { liveKeyPath, trainDetailPath };

export const TRAIN_CATEGORIES = [
  "hsr",
  "ld",
  "night",
  "rfast",
  "reg",
  "sbahn",
  "urban",
  "bus",
  "other",
] as const;

export const VEHICLE_LAYERS = ["L0", "L1", "L2", "L3", "L4"] as const;

const instant = z.iso.datetime();
const label = z.string().trim().min(1);
const webLink = z.url({ protocol: /^https$/, hostname: z.regexes.domain });

export const TrainCategory = z.enum(TRAIN_CATEGORIES);

export const TrainOperator = z.object({
  id: label,
  name: label,
  wikidataQid: z
    .string()
    .regex(/^Q[1-9]\d*$/)
    .nullable(),
});

export const TrainPlace = z.object({
  stopPlaceId: z.uuid(),
  name: label,
});

export const TrainStop = z.object({
  index: z.int().nonnegative(),
  stopPlaceId: z.uuid(),
  name: label,
  scheduledArrival: instant.nullable(),
  scheduledDeparture: instant.nullable(),
  predictedArrival: instant.nullable(),
  predictedDeparture: instant.nullable(),
  arrivalDelaySeconds: z.int().nullable(),
  departureDelaySeconds: z.int().nullable(),
  platformScheduled: label.nullable(),
  platformActual: label.nullable(),
  cancelled: z.boolean(),
  prediction: z.enum(["explicit", "propagated"]).nullable(),
});

export const ATTRIBUTION_ROLES = ["publisher", "aggregator", "mirror"] as const;

/**
 * One holder the source's licence asks to name: the publisher of the data, an aggregator that
 * processed it, or a mirror that passes it on unchanged. Clients join the names per locale.
 */
export const AttributionHolder = z.object({
  name: label,
  role: z.enum(ATTRIBUTION_ROLES),
  url: webLink.nullable(),
});

/** The source's licence as an SPDX id (or a LicenseRef), with a link when one is published over https. */
export const SourceLicence = z.object({
  id: label,
  url: webLink.nullable(),
});

export const TrainProvenance = z.object({
  kind: z.enum(["realtime", "timetable"]),
  sourceId: label,
  sourceName: label,
  attribution: label,
  predictionChangedAt: instant.nullable(),
  feedObservedAt: instant.nullable(),
  holders: z.array(AttributionHolder).min(1).optional(),
  licence: SourceLicence.optional(),
});

export const TrainGeometry = z.object({
  available: z.boolean(),
  reason: z.enum(["low_quality", "unmeasured", "no_shape"]).nullable(),
});

export const TrainProgress = z.object({
  lastPassedIndex: z.int().nonnegative().nullable(),
  nextIndex: z.int().nonnegative().nullable(),
});

export const VehicleIdentity = z.object({
  seriesId: label,
  seriesName: label,
  /** The Baureihe number or numbers of the series ("422", "483, 484"); absent in older answers, null where the catalogue has none. */
  br: label.nullable().optional(),
  variant: label.nullable(),
  units: z.int().positive().nullable(),
  cars: z.int().positive().nullable(),
  lengthMetres: z.number().positive().nullable(),
  layer: z.enum(VEHICLE_LAYERS),
  confidence: z.number().min(0).max(1),
  source: label,
  /** The catalogue display name of `source`; null when the catalogue has none, absent in older answers. */
  sourceName: label.nullable().optional(),
});

/** Where the API serves a stored photo copy: photo id, width class and the first 12 hex digits of its SHA-256. */
export const PHOTO_FILE =
  /^\/api\/v1\/photos\/([a-z][a-z0-9-]{1,62})-(330|960)-([0-9a-f]{12})\.(jpg|png)$/;

export const PhotoImage = z.object({
  url: z.string().regex(PHOTO_FILE),
  width: z.int().positive().max(960),
  height: z.int().positive().max(4000),
});

const fraction = z.number().min(0).max(1);

/**
 * One approved vehicle photo from Wikimedia Commons with its full credit (WP-6.3): the local copies at
 * 330 and 960 px, the crop focus as fractions of width and height, the author with an optional link,
 * the licence as shown with its link (public domain files may have none) and the Commons file page.
 */
export const TrainPhoto = z.object({
  photoId: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  seriesId: label,
  small: PhotoImage,
  large: PhotoImage,
  focus: z.object({ x: fraction, y: fraction }),
  title: label,
  author: label,
  authorUrl: webLink.nullable(),
  licence: label,
  licenceUrl: webLink.nullable(),
  sourceUrl: webLink,
});

/**
 * What the card head's delay is: `stop` is the chosen source's prediction at the stop the
 * train reaches or leaves next, the same value its stop row shows; `current` is the live tick's
 * delay, used only when that stop has no prediction, and labelled as the delay now. The API
 * recomputes both from the stops at the served `asOf` (`headDelay`).
 */
export const DELAY_BASES = ["stop", "current"] as const;

export const FORECAST_LEVELS = ["train", "stop", "category"] as const;

/**
 * Where a forecast stop's values come from (D-065): `feed_plus_spread` takes the expected delay
 * from the live feed's predicted arrival at the stop (the source in `provenance`) and adds B1's
 * spread, its 80th percentile minus its median, for the upper bound; `b1` takes both from B1.
 */
export const FORECAST_BASES = ["feed_plus_spread", "b1"] as const;

/**
 * The forecast for one stop ahead, in whole minutes: the expected arrival delay and the delay 8 in
 * 10 runs stay under (WP-7.5, D-065). B1 gives the median and the 80th percentile of the arrival
 * delay that history shows for trains in the same delay band, at the most specific level with
 * enough runs (this train number at this stop, any train of the category at this stop, the
 * category); `level` and `runs` name that level. `basis` says which part comes from the feed;
 * a stop without it predates D-065 and is `b1`. Never a measured value.
 */
export const ForecastStop = z.object({
  index: z.int().nonnegative(),
  stopsAhead: z.int().positive(),
  expectedDelayMinutes: z.int(),
  upperDelayMinutes: z.int(),
  level: z.enum(FORECAST_LEVELS),
  runs: z.int().positive(),
  basis: z.enum(FORECAST_BASES).optional(),
});

/**
 * Historical arrival forecasts for the stops ahead, from the delay at the last passed stop, at the
 * horizons where the backtest showed B1 beating persistence; the stops at other horizons are left
 * out. `method` names the model, `trainedFrom` and `trainedTo` the months of history.
 */
export const TrainForecast = z.object({
  method: label,
  fromIndex: z.int().nonnegative(),
  fromDelayMinutes: z.int(),
  upperQuantile: z.number().gt(0).lt(1),
  trainedFrom: z.string().regex(/^\d{4}-\d{2}$/),
  trainedTo: z.string().regex(/^\d{4}-\d{2}$/),
  sourceName: label,
  attribution: label,
  licence: SourceLicence,
  stops: z.array(ForecastStop).min(1),
});

/**
 * Everything the train card shows for one running trip instance (D-038). Missing values are `null`,
 * never zero or an empty string: a `null` delay reads as No data, not On time. Fields that later
 * packages fill (vehicle identity, photo) are present and `null` until then, so clients never break.
 */
export const TrainDetail = z
  .object({
    tripInstanceId: z.uuid(),
    frameKey: z.int().nonnegative().max(0xffff_ffff).nullable(),
    serviceDate: z.iso.date(),
    timetableVersion: label,
    version: z.int().nonnegative(),
    asOf: instant,
    category: TrainCategory,
    productName: label.nullable(),
    line: label.nullable(),
    trainNumber: label.nullable(),
    foreign: z.boolean(),
    added: z.boolean(),
    cancelled: z.boolean(),
    operator: TrainOperator.nullable(),
    destination: TrainPlace,
    headsign: label.nullable(),
    delaySeconds: z.int().nullable(),
    delayBasis: z.enum(DELAY_BASES).nullable().optional(),
    /** The live tick's delay when the detail was written, the head's fallback (`current`). */
    currentDelaySeconds: z.int().nullable().optional(),
    provenance: TrainProvenance,
    geometry: TrainGeometry,
    progress: TrainProgress,
    stops: z.array(TrainStop).min(2),
    vehicle: VehicleIdentity.nullable(),
    photo: TrainPhoto.nullable(),
    forecast: TrainForecast.nullable().optional(),
  })
  .superRefine((detail, ctx) => {
    const indexes = detail.stops.map((stop) => stop.index);
    if (indexes.some((index, i) => i > 0 && index <= (indexes[i - 1] ?? -1))) {
      ctx.addIssue({ code: "custom", path: ["stops"], message: "stop indexes must increase" });
    }
    const known = new Set(indexes);
    const { lastPassedIndex, nextIndex } = detail.progress;
    for (const [key, value] of [
      ["lastPassedIndex", lastPassedIndex],
      ["nextIndex", nextIndex],
    ] as const) {
      if (value !== null && !known.has(value)) {
        ctx.addIssue({ code: "custom", path: ["progress", key], message: "not a stop index" });
      }
    }
    if (lastPassedIndex !== null && nextIndex !== null && nextIndex <= lastPassedIndex) {
      ctx.addIssue({
        code: "custom",
        path: ["progress", "nextIndex"],
        message: "the next stop must come after the last passed stop",
      });
    }
    const forecast = detail.forecast;
    if (forecast) {
      if (!known.has(forecast.fromIndex)) {
        ctx.addIssue({
          code: "custom",
          path: ["forecast", "fromIndex"],
          message: "not a stop index",
        });
      }
      forecast.stops.forEach((stop, i) => {
        if (!known.has(stop.index) || stop.index <= forecast.fromIndex) {
          ctx.addIssue({
            code: "custom",
            path: ["forecast", "stops", i, "index"],
            message: "a forecast stop must be a stop after the one it starts from",
          });
        }
        if (stop.upperDelayMinutes < stop.expectedDelayMinutes) {
          ctx.addIssue({
            code: "custom",
            path: ["forecast", "stops", i, "upperDelayMinutes"],
            message: "the upper quantile cannot lie below the median",
          });
        }
      });
    }
    if (detail.geometry.available !== (detail.geometry.reason === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["geometry", "reason"],
        message: "a reason is given exactly when no geometry is available",
      });
    }
  });

export type TrainCategory = z.infer<typeof TrainCategory>;
export type TrainOperator = z.infer<typeof TrainOperator>;
export type TrainPlace = z.infer<typeof TrainPlace>;
export type TrainStop = z.infer<typeof TrainStop>;
export type TrainProvenance = z.infer<typeof TrainProvenance>;
export type TrainGeometry = z.infer<typeof TrainGeometry>;
export type TrainProgress = z.infer<typeof TrainProgress>;
export type VehicleIdentity = z.infer<typeof VehicleIdentity>;
export type PhotoImage = z.infer<typeof PhotoImage>;
export type TrainPhoto = z.infer<typeof TrainPhoto>;
export type DelayBasis = (typeof DELAY_BASES)[number];
export type ForecastBasis = (typeof FORECAST_BASES)[number];
export type ForecastStop = z.infer<typeof ForecastStop>;
export type TrainForecast = z.infer<typeof TrainForecast>;
export type TrainDetail = z.infer<typeof TrainDetail>;

/** The answer of `GET /api/v1/live/keys/{key}`: the trip instance a frame key stands for. */
export const LiveKeyLookup = z.object({ tripInstanceId: z.uuid() });

export type AttributionHolder = z.infer<typeof AttributionHolder>;
export type SourceLicence = z.infer<typeof SourceLicence>;
export type LiveKeyLookup = z.infer<typeof LiveKeyLookup>;
