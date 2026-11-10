import { z } from "zod";

export const STATUS_PATH = "/api/v1/status";

/** Seconds the API keeps one status answer, in process and in HTTP caches. */
export const STATUS_CACHE_S = 30;

export const DataSourceKind = z.enum(["timetable", "realtime", "iris", "neighbours"]);

/**
 * `ok` fresh; `stale` older than its threshold; `down` nothing new for an hour (or three thresholds)
 * or not fetched at all now; `not_recorded` no reading of it is held.
 */
export const DataSourceState = z.enum(["ok", "stale", "down", "not_recorded"]);

const Instant = z.iso.datetime({ offset: true });

export const DataSourceStatus = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(1),
  kind: DataSourceKind,
  country: z.string().regex(/^[A-Z]{2}$/),
  /** The newest payload the recorder stored for it; an unchanged answer stores none. */
  recordedAt: Instant.nullable(),
  /** The newest payload of it the live engine has folded into what the map shows. */
  dataTime: Instant.nullable(),
  staleAfterSeconds: z.number().int().positive().nullable(),
  state: DataSourceState,
});

export const LiveEngineStatus = z.object({
  /** The live engine's last confirmed tick. */
  confirmedAt: Instant.nullable(),
  frameAgeSeconds: z.number().int().nonnegative().nullable(),
  staleAfterSeconds: z.number().int().positive(),
  state: DataSourceState,
});

export const DataStatus = z.object({
  at: Instant,
  live: LiveEngineStatus,
  sources: z.array(DataSourceStatus),
});

export type DataSourceKind = z.infer<typeof DataSourceKind>;
export type DataSourceState = z.infer<typeof DataSourceState>;
export type DataSourceStatus = z.infer<typeof DataSourceStatus>;
export type LiveEngineStatus = z.infer<typeof LiveEngineStatus>;
export type DataStatus = z.infer<typeof DataStatus>;
