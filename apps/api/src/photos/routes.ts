import { PHOTOS_PATH } from "@gerlines/schema/photos";
import type { Context, Hono } from "hono";
import { type ClientSource, clientKeyOf, refuseOverLimit } from "../client-limit.ts";
import { PHOTO_FILE_RATE_LIMIT } from "../limits.ts";
import { fixedWindowLimiter, type RateLimiter } from "../search/rate-limit.ts";
import { throttledLog } from "../trains/routes.ts";
import { COLD_RETRY_MS, PhotoCatalogueUnavailableError, type PhotoService } from "./service.ts";

export { PHOTO_FILE_RATE_LIMIT } from "../limits.ts";

export const PHOTO_FILE_PATH = `${PHOTOS_PATH}/:file`;

const CREDITS_CACHE = "public, max-age=3600";
const FILE_CACHE = "public, max-age=31536000, immutable";
const MISSING_CACHE = "public, max-age=60";
const MAX_NAME_LENGTH = 100;

export interface PhotoRouteDependencies extends ClientSource {
  readonly service: Pick<PhotoService, "credits" | "file"> | undefined;
  readonly logger: { error(line: string): void };
  readonly now?: () => number;
  readonly fileLimiter?: RateLimiter | undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

function notConfigured(context: Context) {
  context.header("Cache-Control", "no-store");
  return context.json({ error: "not_configured" }, 503);
}

function failed(context: Context, log: (line: string) => void, error: unknown) {
  context.header("Cache-Control", "no-store");
  if (error instanceof PhotoCatalogueUnavailableError) {
    context.header("Retry-After", String(COLD_RETRY_MS / 1000));
    return context.json({ error: "photos_unavailable" }, 503);
  }
  log(`photo request failed: ${errorName(error)}`);
  return context.json({ error: "internal_error" }, 500);
}

function notFound(context: Context) {
  context.header("Cache-Control", MISSING_CACHE);
  return context.json({ error: "not_found" }, 404);
}

/**
 * `GET /api/v1/photos`: every approved vehicle photo with its credit, for the credits page.
 * `GET /api/v1/photos/{file}`: one stored copy. The name carries the photo id, the width class and
 * the start of the copy's SHA-256, so a copy never changes under its URL and is cached for a year.
 * Names are looked up in the catalogue, never joined into a path. Both answer 503 photos_unavailable
 * while the catalogue has not loaded (the service logs those failures once per retry period).
 * Each client may fetch 300 files a minute.
 */
export function registerPhotoRoutes(
  app: Hono,
  {
    service,
    logger,
    now = Date.now,
    fileLimiter = fixedWindowLimiter({ limit: PHOTO_FILE_RATE_LIMIT, windowMs: 60_000, now }),
    trustedProxies,
    peerAddress,
  }: PhotoRouteDependencies,
): void {
  const log = throttledLog(logger, now);
  const clientKey = clientKeyOf({ trustedProxies, peerAddress });
  app.get(PHOTOS_PATH, async (context) => {
    if (!service) return notConfigured(context);
    try {
      const photos = await service.credits();
      context.header("Cache-Control", CREDITS_CACHE);
      return context.json({ photos });
    } catch (error) {
      return failed(context, log, error);
    }
  });

  app.get(PHOTO_FILE_PATH, async (context) => {
    const refused = refuseOverLimit(context, fileLimiter, clientKey(context));
    if (refused) return refused;
    const name = context.req.param("file");
    if (name.length > MAX_NAME_LENGTH) return notFound(context);
    if (!service) return notConfigured(context);
    try {
      const file = await service.file(name);
      if (!file) return notFound(context);
      const etag = `"${file.sha256}"`;
      context.header("ETag", etag);
      context.header("Cache-Control", FILE_CACHE);
      context.header("Content-Security-Policy", "default-src 'none'; sandbox");
      if (context.req.header("If-None-Match") === etag) return context.body(null, 304);
      context.header("Content-Type", file.contentType);
      context.header("Content-Length", String(file.body.byteLength));
      return context.body(new Uint8Array(file.body));
    } catch (error) {
      return failed(context, log, error);
    }
  });
}
