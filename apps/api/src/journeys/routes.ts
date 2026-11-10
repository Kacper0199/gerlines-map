import {
  JOURNEY_RELIABILITY_PATH,
  JOURNEYS_PATH,
  ROUTER_HEALTH_PATH,
} from "@gerlines/schema/journeys";
import type { Context, Hono } from "hono";
import { clientKeyOf } from "../client-limit.ts";
import { JOURNEY_RATE_LIMIT, RELIABILITY_HTTP_CACHE_S, RELIABILITY_RATE_LIMIT } from "../limits.ts";
import {
  limitPlansInFlight,
  RouterBusyError,
  type RouterClient,
  RouterRejectedError,
  RouterUnavailableError,
} from "../router/motis.ts";
import type { TrustedProxies } from "../search/client-address.ts";
import { fixedWindowLimiter, type RateDecision, type RateLimiter } from "../search/rate-limit.ts";
import type { StatsCache } from "../stats/cache.ts";
import { throttledLog } from "../throttled-log.ts";
import { cachedRouterHealth } from "./health.ts";
import { journeyQuerySchema, restoreTimeOffset } from "./query.ts";
import {
  reliabilityCache as createReliabilityCache,
  parseReliabilityQuery,
  type ReadGate,
  type ReliabilitySource,
  readGate,
  StatsBusyError,
  trainReliability,
  uncachedTrains,
} from "./reliability.ts";
import { type RoutableStop, type StopName, searchJourneys, type TrainRun } from "./service.ts";

export { JOURNEY_RATE_LIMIT, RELIABILITY_HTTP_CACHE_S, RELIABILITY_RATE_LIMIT } from "../limits.ts";

export const DEFAULT_MAX_ROUTER_CALLS_IN_FLIGHT = 6;
export const JOURNEY_RATE_WINDOW_MS = 60_000;
const RELIABILITY_CACHE_CONTROL = `public, max-age=${RELIABILITY_HTTP_CACHE_S}`;
const STATS_RETRY_AFTER_S = 5;
const ROUTER_BUSY_RETRY_AFTER_S = 1;

const REJECTION_MESSAGES = {
  stop_not_found: "A stop of this query is not in the timetable.",
  router_rejected:
    "The router cannot answer this query, for example for a time outside the timetable.",
} as const;

export interface RouterDependencies {
  readonly client: RouterClient;
  readonly datasetTag: string;
  readonly maxInFlight?: number | undefined;
}

export interface JourneyRouteDependencies {
  readonly router: RouterDependencies | undefined;
  readonly logger: { error(line: string): void };
  readonly now?: () => number;
  readonly elapsed?: () => number;
  readonly limiter?: RateLimiter;
  readonly reliability?: ReliabilitySource | undefined;
  readonly reliabilityLimiter?: RateLimiter;
  readonly reliabilityCache?: StatsCache;
  readonly reliabilityReads?: ReadGate;
  readonly trustedProxies?: TrustedProxies;
  readonly peerAddress?: (context: Context) => string;
  readonly stopName?: StopName | undefined;
  readonly trainRun?: TrainRun | undefined;
  readonly routableStop?: RoutableStop | undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function journeyFailure(
  error: unknown,
  logger: JourneyRouteDependencies["logger"],
  context: Context,
): Response {
  logger.error(`journeys request failed: ${describeError(error)}`);
  context.header("Cache-Control", "no-store");
  if (error instanceof RouterBusyError) {
    context.header("Retry-After", String(ROUTER_BUSY_RETRY_AFTER_S));
    return context.json({ error: "router_busy" }, 503);
  }
  if (error instanceof RouterRejectedError) {
    const code = error.status === 404 ? "stop_not_found" : "router_rejected";
    return context.json(
      { error: code, message: REJECTION_MESSAGES[code] },
      error.status === 404 ? 404 : 422,
    );
  }
  if (error instanceof RouterUnavailableError) {
    return context.json({ error: "router_unavailable" }, 503);
  }
  return context.json({ error: "internal_error" }, 500);
}

/** The request already paid one; each further train the statistics must read costs one more. */
function chargeReads(limiter: RateLimiter, key: string, extra: number): RateDecision {
  let decision: RateDecision = { allowed: true, retryAfterS: 0 };
  for (let paid = 0; paid < extra && decision.allowed; paid += 1) decision = limiter.hit(key);
  return decision;
}

/**
 * `GET /api/v1/journeys`: journeys from A to B over MOTIS with category, product and operator
 * filters, ranking and paging; `GET /api/v1/journeys/reliability`: punctuality of the legs' train
 * numbers over 30 days from the statistics rollups; `GET /api/v1/router/health`. At most six MOTIS
 * calls run at once (503 `router_busy` with Retry-After above), and each client has a request
 * budget per minute. The router health is asked at most once per five seconds and shared by every
 * request.
 */
export function registerJourneyRoutes(
  app: Hono,
  {
    router,
    logger,
    now = Date.now,
    elapsed = performance.now.bind(performance),
    limiter = fixedWindowLimiter({
      limit: JOURNEY_RATE_LIMIT,
      windowMs: JOURNEY_RATE_WINDOW_MS,
      now,
    }),
    reliability,
    reliabilityLimiter = fixedWindowLimiter({
      limit: RELIABILITY_RATE_LIMIT,
      windowMs: JOURNEY_RATE_WINDOW_MS,
      now,
    }),
    reliabilityCache = createReliabilityCache(now),
    reliabilityReads = readGate(),
    trustedProxies,
    peerAddress,
    stopName,
    trainRun,
    routableStop,
  }: JourneyRouteDependencies,
): void {
  const limited = router && {
    client: limitPlansInFlight(
      router.client,
      router.maxInFlight ?? DEFAULT_MAX_ROUTER_CALLS_IN_FLIGHT,
    ),
    datasetTag: router.datasetTag,
  };
  const clientKey = clientKeyOf({ trustedProxies, peerAddress });
  const logReliabilityFailure = throttledLog((line) => logger.error(line), now);

  app.get(JOURNEYS_PATH, async (context) => {
    context.header("Cache-Control", "no-store");
    const decision = limiter.hit(clientKey(context));
    if (!decision.allowed) {
      context.header("Retry-After", String(decision.retryAfterS));
      return context.json({ error: "rate_limited" }, 429);
    }
    const parsed = journeyQuerySchema.safeParse(restoreTimeOffset(context.req.query()));
    if (!parsed.success) {
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
    if (!limited) {
      return context.json({ error: "not_configured" }, 503);
    }
    try {
      return context.json(
        await searchJourneys(parsed.data, {
          ...limited,
          now,
          elapsed,
          signal: context.req.raw.signal,
          stopName,
          trainRun,
          routableStop,
        }),
      );
    } catch (error) {
      return journeyFailure(error, logger, context);
    }
  });

  app.get(JOURNEY_RELIABILITY_PATH, async (context) => {
    const decision = reliabilityLimiter.hit(clientKey(context));
    if (!decision.allowed) {
      context.header("Cache-Control", "no-store");
      context.header("Retry-After", String(decision.retryAfterS));
      return context.json({ error: "rate_limited" }, 429);
    }
    const parsed = parseReliabilityQuery(context.req.queries("train") ?? []);
    if (!parsed.ok) {
      context.header("Cache-Control", "no-store");
      return context.json(
        { error: "invalid_request", issues: [{ path: "train", message: parsed.message }] },
        400,
      );
    }
    if (!reliability) {
      context.header("Cache-Control", "no-store");
      return context.json({ error: "not_configured" }, 503);
    }
    const reads = uncachedTrains(parsed.trains, reliabilityCache, now());
    const charged = chargeReads(reliabilityLimiter, clientKey(context), reads - 1);
    if (!charged.allowed) {
      context.header("Cache-Control", "no-store");
      context.header("Retry-After", String(charged.retryAfterS));
      return context.json({ error: "rate_limited" }, 429);
    }
    try {
      const body = await trainReliability(parsed.trains, {
        source: reliability,
        now,
        cache: reliabilityCache,
        reads: reliabilityReads,
      });
      context.header("Cache-Control", RELIABILITY_CACHE_CONTROL);
      return context.json(body);
    } catch (error) {
      if (!(error instanceof StatsBusyError)) {
        logReliabilityFailure(`journey reliability request failed: ${describeError(error)}`);
      }
      context.header("Cache-Control", "no-store");
      context.header("Retry-After", String(STATS_RETRY_AFTER_S));
      return context.json({ error: "stats_unavailable" }, 503);
    }
  });

  const routerHealth = router && cachedRouterHealth(() => router.client.health(), elapsed);

  app.get(ROUTER_HEALTH_PATH, async (context) => {
    context.header("Cache-Control", "no-store");
    if (!routerHealth) {
      return context.json({ status: "not_configured" }, 503);
    }
    const health = await routerHealth().catch((error: unknown) => {
      logger.error(`router health failed: ${describeError(error)}`);
      return null;
    });
    if (!health) {
      return context.json({ status: "unavailable" }, 503);
    }
    return context.json(
      { status: health.ok ? "ok" : "unavailable", latencyMs: health.latencyMs },
      health.ok ? 200 : 503,
    );
  });
}
