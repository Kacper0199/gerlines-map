import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { clientAddress, limiterKey, type TrustedProxies } from "./search/client-address.ts";
import type { RateLimiter } from "./search/rate-limit.ts";

export const TRUST_NOBODY: TrustedProxies = { has: () => false };

/** The socket peer of the request: the visitor, or the proxy in front of the API. */
export function remoteAddress(context: Context): string {
  try {
    return getConnInfo(context).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface ClientSource {
  readonly trustedProxies?: TrustedProxies | undefined;
  readonly peerAddress?: ((context: Context) => string) | undefined;
}

/** The limiter key of the client a request came from (`clientAddress`, then `limiterKey`). */
export function clientKeyOf({
  trustedProxies = TRUST_NOBODY,
  peerAddress = remoteAddress,
}: ClientSource): (context: Context) => string {
  return (context) =>
    limiterKey(
      clientAddress(
        peerAddress(context),
        {
          cfConnectingIp: context.req.header("cf-connecting-ip"),
          forwardedFor: context.req.header("x-forwarded-for"),
        },
        trustedProxies,
      ),
    );
}

/** Counts the request against the client's budget: null when allowed, else a 429 with Retry-After. */
export function refuseOverLimit(
  context: Context,
  limiter: RateLimiter,
  key: string,
): Response | null {
  const decision = limiter.hit(key);
  if (decision.allowed) return null;
  context.header("Retry-After", String(decision.retryAfterS));
  context.header("Cache-Control", "no-store");
  return context.json({ error: "rate_limited" }, 429);
}
