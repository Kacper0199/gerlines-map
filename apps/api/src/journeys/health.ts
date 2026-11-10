import type { RouterHealth } from "../router/motis.ts";

export const ROUTER_HEALTH_TTL_MS = 5_000;

/**
 * The router's health, asked at most once per five seconds however many requests come in;
 * requests that arrive while it is being asked share that call. A call that throws is not kept.
 */
export function cachedRouterHealth(
  health: () => Promise<RouterHealth>,
  elapsed: () => number,
): () => Promise<RouterHealth> {
  let cached: { readonly at: number; readonly health: Promise<RouterHealth> } | null = null;
  return () => {
    const now = elapsed();
    if (cached && now - cached.at < ROUTER_HEALTH_TTL_MS) {
      return cached.health;
    }
    const entry = { at: now, health: health() };
    cached = entry;
    entry.health.catch(() => {
      if (cached === entry) {
        cached = null;
      }
    });
    return entry.health;
  };
}
