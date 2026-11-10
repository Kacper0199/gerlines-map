import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../config.ts";
import { STATS_CONNECTION_TIMEOUT_MS, statsDatabaseOptions } from "./config.ts";

describe("statsDatabaseOptions", () => {
  const logger = { error: () => undefined };

  it("gives up waiting for a pool connection after 2 s, so a full pool answers 503 quickly", () => {
    expect(STATS_CONNECTION_TIMEOUT_MS).toBe(2_000);
    const options = statsDatabaseOptions({ STATS_DATABASE_URL: "postgres://stats@db/x" }, logger);
    expect(options?.connectionTimeoutMs).toBe(2_000);
    expect(options?.maxConnections).toBe(6);
    expect(options?.databaseUrl).toBe("postgres://stats@db/x");
  });

  it("falls back to the search database and is undefined when neither is set", () => {
    expect(
      statsDatabaseOptions({ SEARCH_DATABASE_URL: "postgresql://search@db/x" }, logger)
        ?.databaseUrl,
    ).toBe("postgresql://search@db/x");
    expect(statsDatabaseOptions({}, logger)).toBeUndefined();
  });

  it("refuses a URL that is not postgres", () => {
    expect(() => statsDatabaseOptions({ STATS_DATABASE_URL: "mysql://x" }, logger)).toThrow(
      ConfigurationError,
    );
  });
});
