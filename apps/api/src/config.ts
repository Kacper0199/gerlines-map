import { isIP } from "node:net";
import { userAgent } from "@gerlines/schema";

export const DEFAULT_API_PORT = 8787;
export const DEFAULT_API_HOST = "127.0.0.1";
const MAX_PORT = 65_535;

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigurationError(`${name} must be set in the environment`);
  }
  return value;
}

export function buildUserAgent(env: Environment, version: string): string {
  try {
    return userAgent({
      appName: required(env, "APP_NAME"),
      version,
      contact: required(env, "APP_CONTACT"),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ConfigurationError(
        `APP_NAME or APP_CONTACT cannot form a User-Agent: ${error.message}`,
      );
    }
    throw error;
  }
}

function isProduction(env: Environment): boolean {
  return env.NODE_ENV?.trim().toLowerCase() === "production";
}

const PRODUCTION_REQUIRED = [
  "APP_NAME",
  "APP_CONTACT",
  "API_TRUSTED_PROXIES",
  "API_CLOUDFLARE_RANGES",
] as const;

const SHORTEST_PREFIX = { 4: 8, 6: 16 } as const;
const ADDRESS_LISTS = ["API_TRUSTED_PROXIES", "API_CLOUDFLARE_RANGES"] as const;

function tooWide(entry: string): boolean {
  const [address = "", prefix] = entry.split("/");
  const family = isIP(address);
  if (prefix === undefined || family === 0) return false;
  return Number(prefix) < SHORTEST_PREFIX[family as 4 | 6];
}

/**
 * With `NODE_ENV=production` the API starts only behind its edge: the User-Agent settings, the
 * edge proxy in `API_TRUSTED_PROXIES` and the Cloudflare ranges in `API_CLOUDFLARE_RANGES`, neither
 * with a prefix shorter than /8 (IPv4) or /16 (IPv6), which would let a large part of the internet
 * forge `X-Forwarded-For` or `CF-Connecting-IP`. Without them every visitor would share the edge's
 * limiter key.
 */
export function checkProductionSettings(env: Environment): void {
  if (!isProduction(env)) return;
  const missing = PRODUCTION_REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigurationError(`${missing.join(", ")} must be set with NODE_ENV=production`);
  }
  for (const name of ADDRESS_LISTS) {
    const wide = (env[name] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .find(tooWide);
    if (wide !== undefined) {
      throw new ConfigurationError(
        `${name} must not hold a prefix shorter than /8 (IPv4) or /16 (IPv6), got ${wide}`,
      );
    }
  }
}

/** `API_PORT`, or the default when it is unset or empty (as `.env.example` leaves it). */
export function readPort(env: Environment): number {
  const text = env.API_PORT?.trim();
  if (!text) return DEFAULT_API_PORT;
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new ConfigurationError(
      `API_PORT must be a port number from 1 to ${MAX_PORT}, got ${text}`,
    );
  }
  return port;
}

/**
 * `API_HOST`: the address the server listens on, loopback when unset or empty. In a container
 * behind the edge it is `0.0.0.0`, reachable only on the Compose networks the service joins.
 */
export function readHost(env: Environment): string {
  const text = env.API_HOST?.trim();
  if (!text) return DEFAULT_API_HOST;
  if (isIP(text) === 0) {
    throw new ConfigurationError(`API_HOST must be an IPv4 or IPv6 address, got ${text}`);
  }
  return text;
}
