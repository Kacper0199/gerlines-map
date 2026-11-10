import { z } from "zod";
import { SEARCH_PATH, SEARCH_QUERY_MAX } from "./constants.ts";
import { TrainCategory, TrainPlace } from "./train-detail.ts";

export { SEARCH_PATH, SEARCH_QUERY_MAX };

export const SEARCH_KINDS = ["station", "train", "line", "place"] as const;
export const SEARCH_LOCALES = ["en", "de", "pl"] as const;
export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 20;

const label = z.string().trim().min(1);
const instant = z.iso.datetime();
const longitude = z.number().min(-180).max(180);
/** A DELFI stop id (DHID) of a parent station, as `stop_place.dhid` holds it and journeys take it. */
const DHID = /^[a-z]{2}:[0-9]{5}:[0-9A-Za-z_]+$/;
/** A stop id of the DELFI feed, a DHID or a foreign id such as `ch:1:sloid:10`, as journeys take it. */
export const STOP_ID_PATTERN = /^[\p{L}\p{N}:_.-]{1,128}$/u;
const latitude = z.number().min(-90).max(90);

/** West, south, east, north in degrees. */
export const SearchBox = z.tuple([longitude, latitude, longitude, latitude]);

export const SearchKind = z.enum(SEARCH_KINDS);
export const SearchLocale = z.enum(SEARCH_LOCALES);

export const SearchStation = z.object({
  kind: z.literal("station"),
  id: z.uuid(),
  name: label,
  lon: longitude,
  lat: latitude,
  eva: z.int().positive().nullable(),
  dhid: z
    .string()
    .regex(DHID)
    .nullable()
    .describe(
      "DHID of the station, null when DELFI has none (most stations abroad). The journeys API takes stopId",
    ),
  stopId: z
    .string()
    .regex(STOP_ID_PATTERN)
    .nullable()
    .optional()
    .describe(
      "Stop id of the station in the DELFI feed, the `from` and `to` of /api/v1/journeys: the DHID, else the feed's own id (ch:1:sloid:10 for Basel SBB); null when the feed has none",
    ),
  lines: z.array(label).max(24),
  trainsToday: z.int().nonnegative(),
});

export const SearchTrain = z.object({
  kind: z.literal("train"),
  id: z.uuid(),
  title: label,
  productName: label.nullable(),
  trainNumber: label.nullable(),
  line: label.nullable(),
  category: TrainCategory,
  foreign: z.boolean(),
  operator: label.nullable(),
  origin: TrainPlace,
  destination: TrainPlace,
  departure: instant,
  arrival: instant,
  serviceDate: z.iso.date(),
});

export const SearchLine = z.object({
  kind: z.literal("line"),
  id: label,
  line: label,
  productName: label.nullable(),
  category: TrainCategory,
  operator: label.nullable(),
  trainsToday: z.int().nonnegative(),
  bbox: SearchBox,
});

export const SearchPlace = z.object({
  kind: z.literal("place"),
  id: label,
  type: z.enum(["land", "town"]),
  name: label,
  region: label.nullable(),
  landCode: z
    .string()
    .regex(/^DE-[A-Z]{2}$/)
    .nullable(),
  lon: longitude,
  lat: latitude,
  bbox: SearchBox.nullable(),
});

export const SearchResult = z.discriminatedUnion("kind", [
  SearchStation,
  SearchTrain,
  SearchLine,
  SearchPlace,
]);

/** What `GET /api/v1/search` answers: results ranked best first, every kind from a named source. */
export const SearchResponse = z.object({
  query: z.string(),
  serviceDate: z.iso.date(),
  timetableVersion: label,
  results: z.array(SearchResult).max(SEARCH_LIMIT_MAX),
});

export type SearchKind = z.infer<typeof SearchKind>;
export type SearchLocale = z.infer<typeof SearchLocale>;
export type SearchStation = z.infer<typeof SearchStation>;
export type SearchTrain = z.infer<typeof SearchTrain>;
export type SearchLine = z.infer<typeof SearchLine>;
export type SearchPlace = z.infer<typeof SearchPlace>;
export type SearchResult = z.infer<typeof SearchResult>;
export type SearchResponse = z.infer<typeof SearchResponse>;
