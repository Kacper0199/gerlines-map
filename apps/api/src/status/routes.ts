import { STATUS_CACHE_S, STATUS_PATH } from "@gerlines/schema/status";
import type { Context, Hono } from "hono";
import { type ClientSource, clientKeyOf, refuseOverLimit } from "../client-limit.ts";
import { STATUS_RATE_LIMIT } from "../limits.ts";
import { fixedWindowLimiter, type RateLimiter } from "../search/rate-limit.ts";
import { throttledLog } from "../trains/routes.ts";
import { type StatusService, StatusUnavailableError } from "./service.ts";

export { STATUS_RATE_LIMIT } from "../limits.ts";

export interface StatusRouteDependencies extends ClientSource {
  readonly service: Pick<StatusService, "status"> | undefined;
  readonly logger: { error(line: string): void };
  readonly now?: () => number;
  readonly limiter?: RateLimiter | undefined;
}

function refused(context: Context, error: string, retryAfterS = STATUS_CACHE_S) {
  context.header("Cache-Control", "no-store");
  context.header("Retry-After", String(retryAfterS));
  return context.json({ error }, 503);
}

/**
 * `GET /api/v1/status`: per source of the map its newest recorded payload, the newest payload the
 * live engine folded, the staleness threshold and a state, and the live engine's frame age. Read
 * from the rows the recorder writes and the live store, one answer (or one refusal) per 30 s for all clients, 60
 * requests a minute per client. 503 not_configured without a database, 503 status_unavailable
 * while the recorder's rows cannot be read.
 */
export function registerStatusRoutes(
  app: Hono,
  {
    service,
    logger,
    now = Date.now,
    limiter = fixedWindowLimiter({ limit: STATUS_RATE_LIMIT, windowMs: 60_000, now }),
    trustedProxies,
    peerAddress,
  }: StatusRouteDependencies,
): void {
  const log = throttledLog(logger, now);
  const clientKey = clientKeyOf({ trustedProxies, peerAddress });
  app.get(STATUS_PATH, async (context) => {
    const over = refuseOverLimit(context, limiter, clientKey(context));
    if (over) return over;
    if (!service) return refused(context, "not_configured");
    try {
      const { status, maxAgeS } = await service.status();
      context.header("Cache-Control", `public, max-age=${maxAgeS}`);
      return context.json(status);
    } catch (error) {
      if (error instanceof StatusUnavailableError) {
        return refused(context, "status_unavailable", error.retryAfterS);
      }
      log(`status request failed: ${error instanceof Error ? error.name : "Error"}`);
      return refused(context, "status_unavailable");
    }
  });
}
