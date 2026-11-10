import {
  SEARCH_KINDS,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_PATH,
  SEARCH_QUERY_MAX,
  SearchKind,
  SearchLocale,
  type SearchResponse,
} from "@gerlines/schema/search";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { clientKeyOf, refuseOverLimit } from "../client-limit.ts";
import { SEARCH_RATE_LIMIT } from "../limits.ts";
import type { TrustedProxies } from "./client-address.ts";
import { fixedWindowLimiter, type RateLimiter } from "./rate-limit.ts";
import type { SearchService } from "./service.ts";

export { SEARCH_RATE_LIMIT } from "../limits.ts";

const RESULT_CACHE = "public, max-age=60";
const RETRY_AFTER_S = 5;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
export const STATION_PATH = "/api/v1/stations/:id";
const STATION_CACHE = "public, max-age=300";
export const SEARCH_RATE_WINDOW_MS = 60_000;

export const searchQuerySchema = z.object({
  q: z
    .string()
    .transform((value) => value.replace(CONTROL, "").trim())
    .pipe(z.string().min(1).max(SEARCH_QUERY_MAX))
    .describe("What the visitor typed: a train number, a line, a station or a place"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMIT_MAX)
    .default(SEARCH_LIMIT_DEFAULT)
    .describe("Most results in the answer"),
  kinds: z
    .string()
    .transform((value) => value.split(",").map((kind) => kind.trim()))
    .pipe(z.array(SearchKind).min(1).max(SEARCH_KINDS.length))
    .optional()
    .describe("Comma list of station, train, line, place; all when left out"),
  lang: SearchLocale.default("en").describe("Language of place names"),
});

export interface SearchRouteDependencies {
  readonly service: SearchService | undefined;
  readonly logger: { error(line: string): void };
  readonly now?: () => number;
  readonly limiter?: RateLimiter;
  readonly trustedProxies?: TrustedProxies;
  readonly peerAddress?: (context: Context) => string;
}

export { remoteAddress } from "../client-limit.ts";

/**
 * `GET /api/v1/search`: stations, trains and lines of today's timetable and places of the geo
 * base for a typed text, ranked best first. Read-only, cached for a minute, limited per client.
 */
export function registerSearchRoutes(
  app: Hono,
  {
    service,
    now = Date.now,
    limiter = fixedWindowLimiter({
      limit: SEARCH_RATE_LIMIT,
      windowMs: SEARCH_RATE_WINDOW_MS,
      now,
    }),
    trustedProxies,
    peerAddress,
  }: SearchRouteDependencies,
): void {
  const clientKey = clientKeyOf({ trustedProxies, peerAddress });
  const limited = (context: Context) => refuseOverLimit(context, limiter, clientKey(context));
  const unavailable = (context: Context) => {
    context.header("Cache-Control", "no-store");
    if (!service) return context.json({ error: "not_configured" }, 503);
    context.header("Retry-After", String(RETRY_AFTER_S));
    return context.json({ error: "search_unavailable" }, 503);
  };

  app.get(STATION_PATH, (context) => {
    const refused = limited(context);
    if (refused) return refused;
    const id = z.uuid().safeParse(context.req.param("id").toLowerCase());
    if (!id.success) {
      context.header("Cache-Control", "no-store");
      return context.json(
        { error: "invalid_request", message: "The station id must be a UUID." },
        400,
      );
    }
    const index = service?.current();
    if (!index) return unavailable(context);
    const station = index.station(id.data);
    context.header("Cache-Control", STATION_CACHE);
    return station ? context.json(station) : context.json({ error: "not_found" }, 404);
  });

  app.get(SEARCH_PATH, (context) => {
    const refused = limited(context);
    if (refused) return refused;
    const parsed = searchQuerySchema.safeParse(context.req.query());
    if (!parsed.success) {
      context.header("Cache-Control", "no-store");
      return context.json(
        {
          error: "invalid_request",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        400,
      );
    }
    const index = service?.current();
    if (!index) return unavailable(context);
    const { q, limit, kinds, lang } = parsed.data;
    const body: SearchResponse = {
      query: q,
      serviceDate: index.serviceDate,
      timetableVersion: index.timetableVersion,
      results: index.search(q, {
        limit,
        locale: lang,
        nowMs: now(),
        ...(kinds ? { kinds } : {}),
      }),
    };
    context.header("Cache-Control", RESULT_CACHE);
    return context.json(body);
  });
}
