import Valkey from "iovalkey";
import { ConfigurationError } from "../config.ts";
import { ValkeyTrainDetailReader } from "./reader.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The live store reader from `VALKEY_URL` (redis:// or rediss://), or undefined when it is unset:
 * the train routes then answer 503 not_configured. A command waits at most the command timeout,
 * also while the store reconnects, so a request gets its 503 within about a second.
 */
export function liveStoreFromEnv(
  env: Environment,
  logger: { error(line: string): void },
): ValkeyTrainDetailReader | undefined {
  const text = env.VALKEY_URL?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigurationError("VALKEY_URL is not a URL");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new ConfigurationError("VALKEY_URL must use redis:// or rediss://");
  }
  const client = new Valkey(text, {
    lazyConnect: true,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 1000,
    connectionName: "gerlines-api",
  });
  let reported = false;
  client.on("error", (error: Error) => {
    if (!reported) logger.error(`live store: ${error.message}`);
    reported = true;
  });
  client.on("ready", () => {
    reported = false;
  });
  void client.connect().catch(() => undefined);
  return new ValkeyTrainDetailReader(client);
}
