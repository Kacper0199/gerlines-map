import { buildUserAgent, ConfigurationError } from "../config.ts";

export const DEFAULT_DATASET_TAG = "de-DELFI";

export interface RouterConfig {
  readonly baseUrl: string;
  readonly datasetTag: string;
  readonly userAgent: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DATASET_TAG = /^[A-Za-z0-9-]{1,32}$/;

function parseBaseUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigurationError(`ROUTER_BASE_URL is not a URL: ${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(`ROUTER_BASE_URL must be http or https, got ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(
      "ROUTER_BASE_URL must not carry credentials, a query or a fragment",
    );
  }
  if (url.pathname !== "/") {
    throw new ConfigurationError(
      `ROUTER_BASE_URL must be an origin without a path, got the path ${url.pathname}`,
    );
  }
  return url.origin;
}

export function readRouterConfig(env: Environment, version: string): RouterConfig | undefined {
  const base = env.ROUTER_BASE_URL?.trim();
  if (!base) {
    return undefined;
  }
  const datasetTag = env.ROUTER_DATASET_TAG?.trim() || DEFAULT_DATASET_TAG;
  if (!DATASET_TAG.test(datasetTag)) {
    throw new ConfigurationError(`ROUTER_DATASET_TAG is not a dataset tag: ${datasetTag}`);
  }
  return {
    baseUrl: parseBaseUrl(base),
    datasetTag,
    userAgent: buildUserAgent(env, version),
  };
}
