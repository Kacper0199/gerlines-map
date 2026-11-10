import type { TrainDetail, TrainForecast, TrainPhoto, VehicleIdentity } from "@gerlines/schema";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { type ClientSource, clientKeyOf, refuseOverLimit } from "../client-limit.ts";
import { LIVE_KEY_RATE_LIMIT, TRAIN_DETAIL_RATE_LIMIT } from "../limits.ts";
import { fixedWindowLimiter, type RateLimiter } from "../search/rate-limit.ts";
import { type ReadGate, readGate } from "../stats/reads.ts";
import { composeDetail, etagOf, matchesEtag } from "./compose.ts";
import { LiveStoreUnavailableError, type TrainDetailReader } from "./reader.ts";

export { LIVE_KEY_RATE_LIMIT, TRAIN_DETAIL_RATE_LIMIT } from "../limits.ts";

export const TRAIN_DETAIL_PATH = "/api/v1/trains/:id";
export const LIVE_KEY_PATH = "/api/v1/live/keys/:key";

const DETAIL_CACHE = "public, max-age=5";
const KEY_CACHE = "public, max-age=3600";
const RETRY_AFTER_S = 5;
const MAX_FRAME_KEY = 0xffff_ffff;
const RATE_WINDOW_MS = 60_000;
/** Vehicle identity reads (two vehicle database queries each) run at once in this process. */
export const IDENTITY_READS_MAX = 4;

/** The detail waits this long for the vehicle identity, then answers with `vehicle: null`. */
export const IDENTITY_DEADLINE_MS = 150;

/** The detail waits this long for the photo of the identified series, then answers with `photo: null`. */
export const PHOTO_DEADLINE_MS = 150;

const tripInstanceId = z.uuid();
const frameKey = z
  .string()
  .regex(/^(0|[1-9]\d{0,9})$/)
  .transform(Number)
  .pipe(z.int().max(MAX_FRAME_KEY));

export interface TrainRouteDependencies extends ClientSource {
  readonly reader: TrainDetailReader | undefined;
  readonly logger: { error(line: string): void };
  readonly now?: () => number;
  readonly identity?:
    | { identify(detail: TrainDetail, client?: string): Promise<VehicleIdentity | null> }
    | undefined;
  readonly identityDeadlineMs?: number;
  readonly photos?: { forSeries(seriesId: string): Promise<TrainPhoto | null> } | undefined;
  readonly photoDeadlineMs?: number;
  readonly predictions?: { forecast(detail: TrainDetail): TrainForecast | null } | undefined;
  readonly detailLimiter?: RateLimiter | undefined;
  readonly keyLimiter?: RateLimiter | undefined;
  readonly identityReads?: ReadGate | undefined;
}

const LATE = Symbol("late");

async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** At most one "live store unavailable" line per this many ms; the rest are counted into the next. */
export const UNAVAILABLE_LOG_INTERVAL_MS = 10_000;

/** Logs the first line, then at most one line per interval with the number of lines it held back. */
export function throttledLog(
  logger: TrainRouteDependencies["logger"],
  now: () => number,
  intervalMs = UNAVAILABLE_LOG_INTERVAL_MS,
): (line: string) => void {
  let lastAt = Number.NEGATIVE_INFINITY;
  let held = 0;
  return (line) => {
    const at = now();
    if (at - lastAt < intervalMs) {
      held += 1;
      return;
    }
    logger.error(held > 0 ? `${line} (${held} more since the last report)` : line);
    lastAt = at;
    held = 0;
  };
}

/** A live engine that has not confirmed for this long is treated as down. */
export const LIVE_SILENCE_MS = 30_000;

function silent(confirmed: string | null, now: number): boolean {
  const at = confirmed === null ? Number.NaN : Date.parse(confirmed);
  return Number.isNaN(at) || now - at > LIVE_SILENCE_MS;
}

function unavailable(
  context: Context,
  error: unknown,
  logger: TrainRouteDependencies["logger"],
  logUnavailable: (line: string) => void,
) {
  context.header("Cache-Control", "no-store");
  if (error instanceof LiveStoreUnavailableError) {
    logUnavailable(`live store unavailable: ${error.message}`);
    context.header("Retry-After", String(RETRY_AFTER_S));
    return context.json({ error: "live_unavailable" }, 503);
  }
  logger.error(`train detail failed: ${error instanceof Error ? error.name : String(error)}`);
  return context.json({ error: "internal_error" }, 500);
}

function notConfigured(context: Context) {
  context.header("Cache-Control", "no-store");
  return context.json({ error: "not_configured" }, 503);
}

function invalid(context: Context, message: string) {
  context.header("Cache-Control", "no-store");
  return context.json({ error: "invalid_request", message }, 400);
}

function notFound(context: Context) {
  context.header("Cache-Control", DETAIL_CACHE);
  return context.json({ error: "not_found" }, 404);
}

/**
 * `GET /api/v1/trains/{id}`: the train detail the live engine keeps for a running or recent trip
 * instance (404 otherwise, 503 while the engine has not confirmed for 30 s), cached for 5 s with a strong ETag over the body. `GET
 * /api/v1/live/keys/{key}`: the trip instance a frame key stands for; cached for an hour, since a
 * frame key can name another instance after the live store is reset. Each client may ask 120
 * details and 120 keys a minute; at most four vehicle identity reads run at once, a detail past
 * them answers with `vehicle: null`.
 */
export function registerTrainRoutes(
  app: Hono,
  {
    reader,
    logger,
    now = Date.now,
    identity,
    identityDeadlineMs = IDENTITY_DEADLINE_MS,
    photos,
    photoDeadlineMs = PHOTO_DEADLINE_MS,
    predictions,
    detailLimiter = fixedWindowLimiter({
      limit: TRAIN_DETAIL_RATE_LIMIT,
      windowMs: RATE_WINDOW_MS,
      now,
    }),
    keyLimiter = fixedWindowLimiter({ limit: LIVE_KEY_RATE_LIMIT, windowMs: RATE_WINDOW_MS, now }),
    identityReads = readGate(IDENTITY_READS_MAX),
    trustedProxies,
    peerAddress,
  }: TrainRouteDependencies,
): void {
  const clientKey = clientKeyOf({ trustedProxies, peerAddress });
  const logUnavailable = throttledLog(logger, now);
  const logIdentity = throttledLog(logger, now);
  const logPhoto = throttledLog(logger, now);
  const logForecast = throttledLog(logger, now);
  const withForecast = (detail: TrainDetail): TrainDetail => {
    if (!predictions) return { ...detail, forecast: detail.forecast ?? null };
    try {
      return { ...detail, forecast: predictions.forecast(detail) };
    } catch (error) {
      logForecast(`forecast failed: ${error instanceof Error ? error.name : String(error)}`);
      return { ...detail, forecast: null };
    }
  };
  const withPhoto = async (detail: TrainDetail): Promise<TrainDetail> => {
    if (!photos || detail.vehicle === null || detail.photo !== null) return detail;
    try {
      const photo = await withinDeadline(
        photos.forSeries(detail.vehicle.seriesId),
        photoDeadlineMs,
      );
      if (photo === LATE) {
        logPhoto(`vehicle photo took longer than ${photoDeadlineMs} ms`);
        return detail;
      }
      return { ...detail, photo };
    } catch (error) {
      logPhoto(`vehicle photo failed: ${error instanceof Error ? error.name : String(error)}`);
      return detail;
    }
  };
  const withVehicle = async (detail: TrainDetail, client: string): Promise<TrainDetail> => {
    if (!identity || detail.vehicle !== null) return detail;
    if (!identityReads.tryEnter()) {
      logIdentity(`vehicle identity skipped: ${identityReads.inFlight()} reads in flight`);
      return detail;
    }
    const leave = () => identityReads.leave();
    const work = Promise.resolve().then(() => identity.identify(detail, client));
    work.then(leave, leave);
    try {
      const vehicle = await withinDeadline(work, identityDeadlineMs);
      if (vehicle === LATE) {
        logIdentity(`vehicle identity took longer than ${identityDeadlineMs} ms`);
        return detail;
      }
      return { ...detail, vehicle };
    } catch (error) {
      logIdentity(
        `vehicle identity failed: ${error instanceof Error ? error.name : String(error)}`,
      );
      return detail;
    }
  };
  app.get(TRAIN_DETAIL_PATH, async (context) => {
    const client = clientKey(context);
    const refused = refuseOverLimit(context, detailLimiter, client);
    if (refused) return refused;
    const id = tripInstanceId.safeParse(context.req.param("id").toLowerCase());
    if (!id.success) return invalid(context, "The train id must be a UUID.");
    if (!reader) return notConfigured(context);
    let body: string;
    try {
      const snapshot = await reader.train(id.data);
      const detail = composeDetail(snapshot);
      if (detail === null) return notFound(context);
      if (silent(snapshot.confirmed, now())) {
        throw new LiveStoreUnavailableError(`live engine silent since ${snapshot.confirmed}`);
      }
      body = JSON.stringify(withForecast(await withPhoto(await withVehicle(detail, client))));
    } catch (error) {
      return unavailable(context, error, logger, logUnavailable);
    }
    const etag = etagOf(body);
    context.header("ETag", etag);
    context.header("Cache-Control", DETAIL_CACHE);
    if (matchesEtag(context.req.header("If-None-Match"), etag)) return context.body(null, 304);
    context.header("Content-Type", "application/json; charset=utf-8");
    return context.body(body);
  });

  app.get(LIVE_KEY_PATH, async (context) => {
    const refused = refuseOverLimit(context, keyLimiter, clientKey(context));
    if (refused) return refused;
    const key = frameKey.safeParse(context.req.param("key"));
    if (!key.success) return invalid(context, "The key must be an integer from 0 to 4294967295.");
    if (!reader) return notConfigured(context);
    let stored: string | null;
    try {
      stored = await reader.instanceOfKey(key.data);
    } catch (error) {
      return unavailable(context, error, logger, logUnavailable);
    }
    const id = tripInstanceId.safeParse(stored);
    if (!id.success) return notFound(context);
    context.header("Cache-Control", KEY_CACHE);
    return context.json({ tripInstanceId: id.data });
  });
}
