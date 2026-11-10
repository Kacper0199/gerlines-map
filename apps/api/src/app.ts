import { type Context, Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { type RouterDependencies, registerJourneyRoutes } from "./journeys/routes.ts";
import { registerPhotoRoutes } from "./photos/routes.ts";
import type { PhotoService } from "./photos/service.ts";
import type { Forecaster } from "./predictions/config.ts";
import type { TrustedProxies } from "./search/client-address.ts";
import { HEALTH_PATH, registerOpenApiRoute } from "./search/openapi.ts";
import type { RateLimiter } from "./search/rate-limit.ts";
import { registerSearchRoutes } from "./search/routes.ts";
import type { SearchService } from "./search/service.ts";
import { type ReadGate, readGate } from "./stats/reads.ts";
import { registerStatsRoutes } from "./stats/routes.ts";
import type { StatsService } from "./stats/service.ts";
import { registerStatusRoutes } from "./status/routes.ts";
import type { StatusService } from "./status/service.ts";
import type { TrainDetailReader } from "./trains/reader.ts";
import { registerTrainRoutes, type TrainRouteDependencies } from "./trains/routes.ts";

export { JOURNEYS_PATH, ROUTER_HEALTH_PATH } from "@gerlines/schema/journeys";
export {
  DEFAULT_MAX_ROUTER_CALLS_IN_FLIGHT,
  type RouterDependencies,
} from "./journeys/routes.ts";

export interface Logger {
  error(line: string): void;
}

export interface AppDependencies {
  readonly router?: RouterDependencies | undefined;
  readonly trains?: TrainDetailReader | undefined;
  readonly identity?: TrainRouteDependencies["identity"];
  readonly photos?: Pick<PhotoService, "forSeries" | "credits" | "file"> | undefined;
  readonly predictions?: Forecaster | undefined;
  readonly search?: SearchService | undefined;
  readonly searchLimiter?: RateLimiter;
  readonly stats?: StatsService | undefined;
  readonly statsLimiter?: RateLimiter;
  readonly status?: Pick<StatusService, "status"> | undefined;
  readonly statusLimiter?: RateLimiter;
  readonly journeyLimiter?: RateLimiter;
  readonly trainDetailLimiter?: RateLimiter;
  readonly liveKeyLimiter?: RateLimiter;
  readonly photoFileLimiter?: RateLimiter;
  readonly identityReads?: ReadGate;
  readonly statsReads?: ReadGate;
  readonly trustedProxies?: TrustedProxies;
  readonly peerAddress?: (context: Context) => string;
  readonly version?: string;
  readonly logger?: Logger;
  readonly now?: () => number;
}

const stderrLogger: Logger = {
  error: (line) => void process.stderr.write(`${line}\n`),
};

export function createApp({
  router,
  trains,
  identity,
  photos,
  predictions,
  search,
  searchLimiter,
  stats,
  statsLimiter,
  status,
  statusLimiter,
  journeyLimiter,
  trainDetailLimiter,
  liveKeyLimiter,
  photoFileLimiter,
  identityReads,
  statsReads = readGate(),
  trustedProxies,
  peerAddress,
  version = "0.0.0",
  logger = stderrLogger,
  now = Date.now,
}: AppDependencies = {}): Hono {
  const app = new Hono();
  app.use("*", secureHeaders());

  app.get(HEALTH_PATH, (context) => context.json({ status: "ok" }));

  registerJourneyRoutes(app, {
    router,
    reliability: stats,
    reliabilityReads: statsReads,
    logger,
    now,
    stopName: search && ((stopId) => search.current()?.stationNameOfStop(stopId) ?? null),
    routableStop: search && ((stopId) => search.current()?.routableStopOf(stopId) ?? null),
    trainRun:
      search &&
      ((serviceDate, tripKey) => search.current()?.runOfTrip(serviceDate, tripKey) ?? null),
    ...(journeyLimiter ? { limiter: journeyLimiter } : {}),
    ...(trustedProxies ? { trustedProxies } : {}),
    ...(peerAddress ? { peerAddress } : {}),
  });
  registerTrainRoutes(app, {
    reader: trains,
    logger,
    now,
    identity,
    photos,
    detailLimiter: trainDetailLimiter,
    keyLimiter: liveKeyLimiter,
    identityReads,
    trustedProxies,
    peerAddress,
    predictions,
  });
  registerPhotoRoutes(app, {
    service: photos,
    logger,
    now,
    fileLimiter: photoFileLimiter,
    trustedProxies,
    peerAddress,
  });
  registerSearchRoutes(app, {
    service: search,
    logger,
    now,
    ...(searchLimiter ? { limiter: searchLimiter } : {}),
    ...(trustedProxies ? { trustedProxies } : {}),
    ...(peerAddress ? { peerAddress } : {}),
  });
  registerStatsRoutes(app, {
    service: stats,
    reads: statsReads,
    logger,
    now,
    ...(statsLimiter ? { limiter: statsLimiter } : {}),
    ...(trustedProxies ? { trustedProxies } : {}),
    ...(peerAddress ? { peerAddress } : {}),
  });
  registerStatusRoutes(app, {
    service: status,
    logger,
    now,
    ...(statusLimiter ? { limiter: statusLimiter } : {}),
    ...(trustedProxies ? { trustedProxies } : {}),
    ...(peerAddress ? { peerAddress } : {}),
  });
  registerOpenApiRoute(app, version);

  return app;
}
