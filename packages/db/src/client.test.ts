import { describe, expect, it } from "vitest";
import { poolConfig } from "./client.ts";

describe("poolConfig", () => {
  it("passes statement and query timeouts to every connection", () => {
    expect(
      poolConfig({
        databaseUrl: "postgres://u@h/db",
        applicationName: "x",
        statementTimeoutMs: 30_000,
        queryTimeoutMs: 35_000,
      }),
    ).toMatchObject({ statement_timeout: 30_000, query_timeout: 35_000, max: 10 });
  });

  it("leaves the timeouts out when none are asked for", () => {
    const config = poolConfig({ databaseUrl: "postgres://u@h/db", applicationName: "x" });
    expect("statement_timeout" in config).toBe(false);
    expect("query_timeout" in config).toBe(false);
    expect("connectionTimeoutMillis" in config).toBe(false);
  });

  it("passes the connection timeout, so a full pool or an unreachable server fails instead of waiting", () => {
    expect(
      poolConfig({
        databaseUrl: "postgres://u@h/db",
        applicationName: "x",
        connectionTimeoutMs: 1_000,
      }),
    ).toMatchObject({ connectionTimeoutMillis: 1_000 });
  });

  it("opens read-only connections when asked, so no statement of the pool can write", () => {
    expect(
      poolConfig({ databaseUrl: "postgres://u@h/db", applicationName: "x", readOnly: true }),
    ).toMatchObject({ options: "-c default_transaction_read_only=on" });
    expect(
      "options" in poolConfig({ databaseUrl: "postgres://u@h/db", applicationName: "x" }),
    ).toBe(false);
  });
});
