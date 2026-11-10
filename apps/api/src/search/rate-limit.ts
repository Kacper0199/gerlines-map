import { aggregateKey, networkKey } from "./client-address.ts";

export interface RateDecision {
  readonly allowed: boolean;
  readonly retryAfterS: number;
}

export interface RateLimiter {
  hit(key: string): RateDecision;
}

export interface FixedWindowOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
  readonly maxKeys?: number;
  readonly overflowLimit?: number;
  readonly maxOverflowKeys?: number;
  readonly maxNetworkKeys?: number;
  readonly aggregate?: (key: string) => string;
  readonly network?: (key: string) => string;
}

interface Window {
  readonly start: number;
  count: number;
}

const SHARED = "\u0000overflow";
const OVERFLOW_LIMIT_FACTOR = 4;
const NETWORK_TABLE_SHARE = 5;

/**
 * Counts requests per key in fixed windows. It guards one API process; the per-IP limit at the
 * edge stays the outer guard. Expired windows are dropped as time goes on. When `maxKeys`
 * live windows are held, a new key is counted in an overflow table by its aggregate (an IPv6 /64
 * by its /48, other keys as they are) under `overflowLimit`, so one network filling the table
 * locks out only itself. When that table is full too, a newcomer is counted by its network (an
 * IPv6 /32, an IPv4 /16) under `overflowLimit`, so filling both tables from one provider locks out
 * only that provider; only when the network table is full as well do newcomers share one window.
 * A key keeps the window it has, so filling the tables resets nobody's limit.
 */
export function fixedWindowLimiter({
  limit,
  windowMs,
  now = Date.now,
  maxKeys = 50_000,
  overflowLimit = limit * OVERFLOW_LIMIT_FACTOR,
  maxOverflowKeys = maxKeys,
  maxNetworkKeys = Math.ceil(maxKeys / NETWORK_TABLE_SHARE),
  aggregate = aggregateKey,
  network = networkKey,
}: FixedWindowOptions): RateLimiter & { size(): number } {
  const windows = new Map<string, Window>();
  const overflow = new Map<string, Window>();
  const networks = new Map<string, Window>();
  const sweep = (table: Map<string, Window>, at: number) => {
    for (const [key, window] of table) {
      if (at - window.start < windowMs) return;
      table.delete(key);
    }
  };
  const open = (table: Map<string, Window>, key: string, at: number) => {
    const window = { start: at, count: 0 };
    table.set(key, window);
    return window;
  };
  const count = (window: Window, cap: number, at: number): RateDecision => {
    window.count += 1;
    if (window.count <= cap) return { allowed: true, retryAfterS: 0 };
    return {
      allowed: false,
      retryAfterS: Math.max(1, Math.ceil((window.start + windowMs - at) / 1000)),
    };
  };
  return {
    hit(key) {
      const at = now();
      sweep(windows, at);
      sweep(overflow, at);
      sweep(networks, at);
      const own = windows.get(key);
      if (own) return count(own, limit, at);
      const wide = aggregate(key);
      const cap = wide === key ? limit : overflowLimit;
      const widened = overflow.get(wide);
      if (widened) return count(widened, cap, at);
      if (windows.size < maxKeys) return count(open(windows, key, at), limit, at);
      if (overflow.size < maxOverflowKeys) return count(open(overflow, wide, at), cap, at);
      const widest = network(key);
      const counted = networks.get(widest);
      if (counted) return count(counted, overflowLimit, at);
      if (networks.size < maxNetworkKeys) {
        return count(open(networks, widest, at), overflowLimit, at);
      }
      return count(networks.get(SHARED) ?? open(networks, SHARED, at), overflowLimit, at);
    },
    size: () => windows.size + overflow.size + networks.size,
  };
}
