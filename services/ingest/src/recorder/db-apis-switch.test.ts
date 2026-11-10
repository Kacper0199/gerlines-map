import { describe, expect, it } from "vitest";
import { type Env, loadRecorderConfig } from "../env.ts";
import type { Logger, LogLevel } from "../log.ts";
import { configuredSources, selectSources } from "./recorder.ts";

const keys = {
  DB_CLIENT_ID: "made-up-db-client-id-0000",
  DB_API_KEY: "made-up-db-api-key-1111111",
  SNCB_API_KEY: "made-up-sncb-key-3333333333",
};

function config(extra: Env = {}) {
  return loadRecorderConfig({ RECORDINGS_DIR: "/recordings", ...extra });
}

function collecting(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      log: (_level: LogLevel, message: string, fields?: Record<string, unknown>) => {
        lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
      },
    },
  };
}

const isDb = (id: string) => id.startsWith("db-");

describe("RECORDER_DB_APIS", () => {
  it("is off by default, also when the DB keys are set", () => {
    const off = config(keys);
    expect(off.dbApis).toBe(false);
    expect(configuredSources(off).some((source) => isDb(source.id))).toBe(false);
    expect(selectSources(off, collecting().logger).some((source) => isDb(source.id))).toBe(false);
    expect(
      configuredSources(config({ ...keys, RECORDER_DB_APIS: "0" })).some((s) => isDb(s.id)),
    ).toBe(false);
  });

  it("adds IRIS, StaDa and FaSta with the keys as headers when set to 1", () => {
    const on = config({ ...keys, RECORDER_DB_APIS: "1" });
    const db = selectSources(on, collecting().logger).filter((source) => isDb(source.id));
    expect(db.map((source) => source.id)).toContain("db-iris-fchg-8000105");
    expect(db.map((source) => source.id)).toContain("db-stada-stations");
    expect(db.map((source) => source.id)).toContain("db-fasta-facilities");
    for (const source of db) expect(source.headers["db-api-key"], source.id).toBe(keys.DB_API_KEY);
  });

  it("skips every DB source with a logged reason when the switch is on but a key is missing", () => {
    const { logger, lines } = collecting();
    const on = config({ RECORDER_DB_APIS: "1", DB_CLIENT_ID: keys.DB_CLIENT_ID });
    expect(selectSources(on, logger).some((source) => isDb(source.id))).toBe(false);
    expect(
      lines.filter((line) => line.includes("DB_CLIENT_ID or DB_API_KEY is empty")).length,
    ).toBe(configuredSources(on).filter((source) => isDb(source.id)).length);
    expect(lines.join("\n")).not.toContain(keys.DB_CLIENT_ID);
    expect(lines.join("\n")).not.toContain(keys.DB_API_KEY);
  });

  it("logs no key value either when only the API key is set", () => {
    const { logger, lines } = collecting();
    const on = config({ RECORDER_DB_APIS: "1", DB_API_KEY: keys.DB_API_KEY });
    expect(selectSources(on, logger).some((source) => isDb(source.id))).toBe(false);
    expect(lines.some((line) => line.includes("DB_CLIENT_ID or DB_API_KEY is empty"))).toBe(true);
    expect(lines.join("\n")).not.toContain(keys.DB_API_KEY);
    expect(lines.join("\n")).not.toContain(keys.DB_CLIENT_ID);
  });

  it("loads the DB keys only when the switch is on", () => {
    expect(config(keys).dbCredentials).toBeNull();
    expect(config({ ...keys, RECORDER_DB_APIS: "0" }).dbCredentials).toBeNull();
    expect(config({ ...keys, RECORDER_DB_APIS: "1" }).dbCredentials).toEqual({
      clientId: keys.DB_CLIENT_ID,
      apiKey: keys.DB_API_KEY,
    });
  });

  it("refuses any other value", () => {
    for (const value of ["yes", "true", "on", "2"]) {
      expect(() => config({ RECORDER_DB_APIS: value }), value).toThrow(
        /RECORDER_DB_APIS must be 1 or 0/,
      );
    }
  });
});

describe("SNCB_API_KEY", () => {
  it("turns on the two SNCB sources, which are skipped without it", () => {
    const sncb = (extra: Env) =>
      selectSources(config(extra), collecting().logger)
        .map((source) => source.id)
        .filter((id) => id.startsWith("be-sncb"));
    expect(sncb({})).toEqual([]);
    expect(sncb({ SNCB_API_KEY: keys.SNCB_API_KEY })).toEqual([
      "be-sncb-gtfs-rt",
      "be-sncb-gtfs-sa",
    ]);
  });

  it("no longer reads the token URL of the former HAFAS feed", () => {
    const legacy = config({ SNCB_GTFS_RT_URL: "https://sncb-opendata.hafas.de/gtfs/realtime/x" });
    expect(legacy.sncbApiKey).toBeNull();
    expect(configuredSources(legacy).every((source) => !source.url?.includes("hafas"))).toBe(true);
  });
});
