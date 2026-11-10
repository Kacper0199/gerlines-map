import { TrainCategory } from "@gerlines/schema";
import { addDays, localDate } from "@gerlines/schema/service-day";
import {
  STATS_BASE_PATH,
  STATS_MAX_DAYS,
  StatsLandCode,
  StatsLineName,
  StatsTrainNumber,
} from "@gerlines/schema/stats";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { clientKeyOf, refuseOverLimit } from "../client-limit.ts";
import { STATS_LONG_RATE_LIMIT, STATS_RATE_LIMIT } from "../limits.ts";
import type { TrustedProxies } from "../search/client-address.ts";
import { fixedWindowLimiter, type RateLimiter } from "../search/rate-limit.ts";
import { throttledLog } from "../throttled-log.ts";
import { StatsCache } from "./cache.ts";
import { gated, type ReadGate, readGate, STATS_READ_QUERIES, StatsBusyError } from "./reads.ts";
import { daysIn, type StatsRange, type StatsService } from "./service.ts";

export { STATS_LONG_RATE_LIMIT, STATS_RATE_LIMIT } from "../limits.ts";

export const STATS_RATE_WINDOW_MS = 60_000;
/** Periods longer than this also count against the long-period limit. */
export const STATS_LONG_PERIOD_DAYS = 31;
export const STATS_FIRST_DAY = "2000-01-01";
export const STATS_LAST_DAY = "2100-12-31";
const RECENT_TTL_MS = 60_000;
const SETTLED_TTL_MS = 3_600_000;
const RETRY_AFTER_S = 5;
const RECENT_CACHE = "public, max-age=60";
const SETTLED_CACHE = "public, max-age=3600";
/** Days this far back can still change: late finals and the level-1 window reach two days ahead of them. */
const SETTLING_DAYS = 2;

const categoryList = z
  .string()
  .transform((value) => [...new Set(value.split(",").map((item) => item.trim()))])
  .pipe(z.array(TrainCategory).min(1))
  .optional()
  .describe(
    "Comma list of hsr, ld, night, rfast, reg, sbahn, urban, bus, other; all when left out",
  );

export const statsTodayQuerySchema = z.object({ category: categoryList });

export const statsPeriodQuerySchema = z.object({
  from: z.iso
    .date()
    .optional()
    .describe("First Berlin service day (YYYY-MM-DD); the same as to when left out"),
  to: z.iso.date().optional().describe("Last Berlin service day, inclusive; today when left out"),
  category: categoryList,
});

const operatorId = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "an operator id such as db-fernverkehr-ag")
  .optional()
  .describe("Operator id, to tell apart trains or lines of the same name");

export const statsRunQuerySchema = statsPeriodQuerySchema.extend({ operator: operatorId });

export interface StatsRouteDependencies {
  readonly service: StatsService | undefined;
  readonly logger: { error(line: string): void };
  readonly now?: () => number;
  readonly limiter?: RateLimiter;
  readonly longLimiter?: RateLimiter;
  readonly cache?: StatsCache;
  readonly reads?: ReadGate;
  readonly trustedProxies?: TrustedProxies;
  readonly peerAddress?: (context: Context) => string;
}

type Issues = { path: string; message: string }[];

function invalid(context: Context, issues: Issues) {
  context.header("Cache-Control", "no-store");
  return context.json({ error: "invalid_request", issues }, 400);
}

function issuesOf(error: z.ZodError): Issues {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

function cacheKey(subject: string, range: StatsRange): string {
  return [subject, range.from, range.to, [...(range.categories ?? [])].sort().join()].join("|");
}

/** The service days asked for, defaulting to today in Berlin, or the reason they are refused. */
export function resolveRange(
  query: {
    from?: string | undefined;
    to?: string | undefined;
    category?: TrainCategory[] | undefined;
  },
  today: string,
): StatsRange | Issues {
  const to = query.to ?? (query.from && query.from > today ? query.from : today);
  const from = query.from ?? to;
  for (const [path, day] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (day < STATS_FIRST_DAY || day > STATS_LAST_DAY) {
      return [{ path, message: "a day between 2000-01-01 and 2100-12-31" }];
    }
  }
  if (from > to) return [{ path: "from", message: "from must not be after to" }];
  if (daysIn(from, to) > STATS_MAX_DAYS) {
    return [{ path: "to", message: `a period covers at most ${STATS_MAX_DAYS} days` }];
  }
  return { from, to, ...(query.category ? { categories: query.category } : {}) };
}

/**
 * `GET /api/v1/stats/...`: punctuality, cancellations and delays from the WP-2.7 rollups for
 * today, a period, a train, a line, a station and a Land, and the segment profile of a train. Read-only, cached, limited per client;
 * at most six queries run at once in the process (shared with the reliability route), each read
 * counted by the queries it runs at once; a read past them answers 503 stats_unavailable with
 * Retry-After. A failing read is logged at most once a minute.
 */
export function registerStatsRoutes(
  app: Hono,
  {
    service,
    logger,
    now = Date.now,
    limiter = fixedWindowLimiter({ limit: STATS_RATE_LIMIT, windowMs: STATS_RATE_WINDOW_MS, now }),
    longLimiter = fixedWindowLimiter({
      limit: STATS_LONG_RATE_LIMIT,
      windowMs: STATS_RATE_WINDOW_MS,
      now,
    }),
    cache = new StatsCache({ now }),
    reads = readGate(),
    trustedProxies,
    peerAddress,
  }: StatsRouteDependencies,
): void {
  const clientKey = clientKeyOf({ trustedProxies, peerAddress });
  const limited = (context: Context, using: RateLimiter = limiter) =>
    refuseOverLimit(context, using, clientKey(context));

  const logFailure = throttledLog((line) => logger.error(line), now);
  const unavailable = (context: Context, error: unknown) => {
    if (!(error instanceof StatsBusyError))
      logFailure(
        `stats request failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    context.header("Cache-Control", "no-store");
    context.header("Retry-After", String(RETRY_AFTER_S));
    return context.json({ error: "stats_unavailable" }, 503);
  };

  const answer = async <T>(
    context: Context,
    subject: string,
    range: StatsRange,
    queries: number,
    run: (stats: StatsService) => Promise<T | null>,
  ) => {
    if (!service) {
      context.header("Cache-Control", "no-store");
      return context.json({ error: "not_configured" }, 503);
    }
    const key = cacheKey(subject, range);
    const refused =
      daysIn(range.from, range.to) > STATS_LONG_PERIOD_DAYS && !cache.holds(key)
        ? limited(context, longLimiter)
        : null;
    if (refused) return refused;
    const recent = range.to >= addDays(localDate(now()), -SETTLING_DAYS);
    try {
      const body = await cache.read(key, recent ? RECENT_TTL_MS : SETTLED_TTL_MS, () =>
        gated(reads, () => run(service), queries),
      );
      if (body === null) {
        context.header("Cache-Control", "no-store");
        return context.json({ error: "not_found" }, 404);
      }
      context.header("Cache-Control", recent ? RECENT_CACHE : SETTLED_CACHE);
      return context.json(body as object);
    } catch (error) {
      return unavailable(context, error);
    }
  };

  const periodOf = <S extends z.ZodType>(context: Context, schema: S) => {
    const parsed = schema.safeParse(context.req.query());
    if (!parsed.success) return { issues: issuesOf(parsed.error) };
    const query = parsed.data as z.infer<typeof statsRunQuerySchema>;
    const range = resolveRange(query, localDate(now()));
    return Array.isArray(range) ? { issues: range } : { range, operator: query.operator ?? null };
  };

  app.get(`${STATS_BASE_PATH}/today`, async (context) => {
    const refused = limited(context);
    if (refused) return refused;
    const parsed = statsTodayQuerySchema.safeParse(context.req.query());
    if (!parsed.success) return invalid(context, issuesOf(parsed.error));
    const today = localDate(now());
    const range: StatsRange = {
      from: today,
      to: today,
      ...(parsed.data.category ? { categories: parsed.data.category } : {}),
    };
    return answer(context, "network", range, STATS_READ_QUERIES.network, (stats) =>
      stats.network(range),
    );
  });

  app.get(`${STATS_BASE_PATH}/period`, async (context) => {
    const refused = limited(context);
    if (refused) return refused;
    const resolved = periodOf(context, statsPeriodQuerySchema);
    if ("issues" in resolved) return invalid(context, resolved.issues);
    return answer(context, "network", resolved.range, STATS_READ_QUERIES.network, (stats) =>
      stats.network(resolved.range),
    );
  });

  app.get(`${STATS_BASE_PATH}/trains/:number`, async (context) => {
    const refused = limited(context);
    if (refused) return refused;
    const number = StatsTrainNumber.safeParse(context.req.param("number"));
    if (!number.success)
      return invalid(context, [{ path: "number", message: "letters and digits, at most 12" }]);
    const resolved = periodOf(context, statsRunQuerySchema);
    if ("issues" in resolved) return invalid(context, resolved.issues);
    return answer(
      context,
      `train|${number.data}|${resolved.operator ?? ""}`,
      resolved.range,
      STATS_READ_QUERIES.train,
      (stats) => stats.train(number.data, resolved.operator, resolved.range),
    );
  });

  app.get(`${STATS_BASE_PATH}/trains/:number/segments`, async (context) => {
    const refused = limited(context);
    if (refused) return refused;
    const number = StatsTrainNumber.safeParse(context.req.param("number"));
    if (!number.success)
      return invalid(context, [{ path: "number", message: "letters and digits, at most 12" }]);
    const resolved = periodOf(context, statsRunQuerySchema);
    if ("issues" in resolved) return invalid(context, resolved.issues);
    return answer(
      context,
      `segments|${number.data}|${resolved.operator ?? ""}`,
      resolved.range,
      STATS_READ_QUERIES.segments,
      (stats) => stats.trainSegments(number.data, resolved.operator, resolved.range),
    );
  });

  app.get(`${STATS_BASE_PATH}/lines/:line`, async (context) => {
    const refused = limited(context);
    if (refused) return refused;
    const line = StatsLineName.safeParse(context.req.param("line"));
    if (!line.success) {
      return invalid(context, [
        { path: "line", message: "letters, digits, spaces, plus and hyphen, at most 16" },
      ]);
    }
    const resolved = periodOf(context, statsRunQuerySchema);
    if ("issues" in resolved) return invalid(context, resolved.issues);
    return answer(
      context,
      `line|${line.data}|${resolved.operator ?? ""}`,
      resolved.range,
      STATS_READ_QUERIES.line,
      (stats) => stats.line(line.data, resolved.operator, resolved.range),
    );
  });

  app.get(`${STATS_BASE_PATH}/stations/:id`, async (context) => {
    const refused = limited(context);
    if (refused) return refused;
    const id = z.uuid().safeParse(context.req.param("id").toLowerCase());
    if (!id.success)
      return invalid(context, [{ path: "id", message: "The station id must be a UUID." }]);
    const resolved = periodOf(context, statsPeriodQuerySchema);
    if ("issues" in resolved) return invalid(context, resolved.issues);
    return answer(
      context,
      `station|${id.data}`,
      resolved.range,
      STATS_READ_QUERIES.station,
      (stats) => stats.station(id.data, resolved.range),
    );
  });

  app.get(`${STATS_BASE_PATH}/lands/:code`, async (context) => {
    const refused = limited(context);
    if (refused) return refused;
    const code = StatsLandCode.safeParse(context.req.param("code").toUpperCase());
    if (!code.success)
      return invalid(context, [{ path: "code", message: "a Land code such as DE-BY" }]);
    const resolved = periodOf(context, statsPeriodQuerySchema);
    if ("issues" in resolved) return invalid(context, resolved.issues);
    return answer(context, `land|${code.data}`, resolved.range, STATS_READ_QUERIES.land, (stats) =>
      stats.land(code.data, resolved.range),
    );
  });
}
