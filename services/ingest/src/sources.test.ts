import { describe, expect, it } from "vitest";
import { bucketCeiling, IRIS_PLAN_LIMIT_PER_MINUTE } from "./db-apis/limits.ts";
import { IRIS_LONG_DISTANCE_COVER } from "./db-apis/stations.ts";
import { redactText, redactUrl } from "./redact.ts";
import { dbApiSources, PROVIDER_LIMITS, recorderSources } from "./sources.ts";

const sncbApiKey = "made-up-sncb-key-3333333333";
const sncbIds = ["be-sncb-gtfs-rt", "be-sncb-gtfs-sa"];

describe("recorderSources", () => {
  it("fetches every source over https", () => {
    const sources = recorderSources({ otdChApiKey: "made-up-key-for-a-test-0000", sncbApiKey });
    for (const source of sources) {
      expect(new URL(source.url ?? "").protocol, source.id).toBe("https:");
    }
  });

  it("never declares the DB API sources, the recorder adds them behind RECORDER_DB_APIS", () => {
    const ids = recorderSources({ otdChApiKey: null, sncbApiKey: null }).map((s) => s.id);
    expect(ids.some((id) => id.startsWith("db-"))).toBe(false);
  });
});

describe("SNCB sources", () => {
  const sncb = recorderSources({ otdChApiKey: null, sncbApiKey }).filter((source) =>
    sncbIds.includes(source.id),
  );

  it("polls trip updates every minute and alerts every 5 minutes at the member endpoint", () => {
    expect(sncb.map((source) => [source.id, source.url, source.periodMs])).toEqual([
      [
        "be-sncb-gtfs-rt",
        "https://api-management-opendata-production.azure-api.net/api/gtfs/feed/nmbssncb/rt/trip-update?format=protobuf&unroll=false",
        60_000,
      ],
      [
        "be-sncb-gtfs-sa",
        "https://api-management-opendata-production.azure-api.net/api/gtfs/feed/nmbssncb/rt/alert?format=protobuf",
        300_000,
      ],
    ]);
    for (const source of sncb) {
      expect(source.metadata).toMatchObject({
        licence: "CC-BY-4.0",
        attribution: "Source: NMBS-SNCB, Open Data",
      });
      expect(source.offsetMs).toBeLessThan(source.periodMs);
    }
  });

  it("sends the key only as the bmc-partner-key header and redacts it everywhere", () => {
    for (const source of sncb) {
      expect(source.headers, source.id).toEqual({ "bmc-partner-key": sncbApiKey });
      expect(source.url, source.id).not.toContain(sncbApiKey);
      expect(source.secrets, source.id).toEqual([sncbApiKey]);
      expect(source.redirectHosts, source.id).toEqual([]);
      expect(source.skipReason, source.id).toBeNull();
      const logged = `GET ${source.url} with ${JSON.stringify(source.headers)} failed`;
      expect(redactText(logged, source.secrets)).not.toContain(sncbApiKey);
      expect(redactUrl(`${source.url}&k=${sncbApiKey}`, source.secrets)).not.toContain(sncbApiKey);
    }
  });

  it("skips both sources without a key and sends no header", () => {
    const keyless = recorderSources({ otdChApiKey: null, sncbApiKey: null }).filter((source) =>
      sncbIds.includes(source.id),
    );
    expect(keyless).toHaveLength(2);
    for (const source of keyless) {
      expect(source.skipReason, source.id).toMatch(/SNCB_API_KEY/);
      expect(source.headers).toEqual({});
      expect(source.secrets).toEqual([]);
    }
  });

  it("stays inside the Standard tier of 12,000 requests per day", () => {
    const perDay = sncb.reduce((sum, source) => sum + 86_400_000 / source.periodMs, 0);
    expect(perDay).toBeLessThanOrEqual(12_000);
  });
});

describe("dbApiSources", () => {
  const dbCredentials = {
    clientId: "made-up-db-client-id-0000",
    apiKey: "made-up-db-api-key-1111111",
  };
  const sources = dbApiSources({ dbCredentials });
  const iris = sources.filter((source) => source.provider === "db-timetables");

  it("polls the long-distance cover: full changes every 3 minutes, the next hour's plan hourly (D-041)", () => {
    expect(IRIS_LONG_DISTANCE_COVER.filter((station) => station.role === "cover")).toHaveLength(50);
    expect(IRIS_LONG_DISTANCE_COVER.map((station) => station.eva)).toContain(8098160);
    expect(new Set(IRIS_LONG_DISTANCE_COVER.map((station) => station.eva)).size).toBe(
      IRIS_LONG_DISTANCE_COVER.length,
    );
    expect(iris).toHaveLength(IRIS_LONG_DISTANCE_COVER.length * 2);
    expect(iris.some((source) => source.id.startsWith("db-iris-rchg-"))).toBe(false);
    for (const source of iris) {
      expect(source.periodMs, source.id).toBe(
        source.id.startsWith("db-iris-fchg-") ? 180_000 : 3_600_000,
      );
    }
    expect(new Set(sources.map((source) => source.id)).size).toBe(sources.length);
    expect(sources.map((source) => source.id)).toContain("db-iris-fchg-8000105");
    expect(sources.map((source) => source.id)).toContain("db-stada-stations");
    expect(sources.map((source) => source.id)).toContain("db-fasta-facilities");
  });

  it("sends the keys only as headers, over https, and redacts both everywhere", () => {
    const plan = sources.find((source) => source.id === "db-iris-plan-8000105");
    for (const source of sources) {
      const urls = [source.url ?? "", source.urlAt?.(Date.parse("2026-10-25T23:06:00Z")) ?? ""];
      for (const url of urls.filter((value) => value !== "")) {
        expect(new URL(url).protocol, source.id).toBe("https:");
        expect(url, source.id).not.toContain(dbCredentials.apiKey);
        expect(url, source.id).not.toContain(dbCredentials.clientId);
      }
      expect(source.headers["db-client-id"], source.id).toBe(dbCredentials.clientId);
      expect(source.headers["db-api-key"], source.id).toBe(dbCredentials.apiKey);
      expect(source.secrets, source.id).toEqual([dbCredentials.clientId, dbCredentials.apiKey]);
      const logged = `${JSON.stringify(source.headers)} at ${source.url}`;
      expect(redactText(logged, source.secrets)).not.toMatch(/made-up-db/);
      expect(source.skipReason).toBeNull();
    }
    const at = Date.parse("2026-10-25T23:06:00Z");
    const plans =
      "https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1/plan/8000105";
    expect(plan?.urlAt?.(at)).toBe(`${plans}/261026/03`);
    expect(plan?.catchUpUrlsAt?.(at)).toEqual([
      `${plans}/261026/00`,
      `${plans}/261026/01`,
      `${plans}/261026/02`,
    ]);
    for (const url of plan?.catchUpUrlsAt?.(at) ?? []) {
      expect(url).not.toContain(dbCredentials.apiKey);
    }
    const fchg = sources.find((source) => source.id === "db-iris-fchg-8000105");
    expect(fchg?.catchUpUrlsAt).toBeUndefined();
  });

  it("declares every IRIS source with the timetable root so a wrong answer is recorded as invalid", () => {
    for (const source of iris) expect(source.documentRoot, source.id).toBe("timetable");
  });

  it("keeps the IRIS cadence inside the shared bucket with 30 % headroom", () => {
    const perMinute = iris.reduce((sum, source) => sum + 60_000 / source.periodMs, 0);
    const limit = PROVIDER_LIMITS["db-timetables"];
    expect(limit).toBeDefined();
    const ceiling = limit ? bucketCeiling(limit) : Number.POSITIVE_INFINITY;
    expect(perMinute).toBeLessThanOrEqual(ceiling);
    expect(perMinute).toBeCloseTo((55 * 60_000) / 180_000 + 55 / 60, 5);
    expect(ceiling).toBeLessThanOrEqual(IRIS_PLAN_LIMIT_PER_MINUTE * 0.7);
    for (const source of iris) expect(source.offsetMs).toBeLessThan(source.periodMs);
  });

  it("checks StaDa's daily full list as a JSON document, so an HTML or error body is stored as invalid", () => {
    const stada = sources.find((source) => source.id === "db-stada-stations");
    expect(stada).toMatchObject({
      kind: "http-document",
      contentType: "application/json",
      periodMs: 86_400_000,
      segmentPeriod: "day",
      provider: "db-stada",
      url: "https://apis.deutschebahn.com/db-api-marketplace/apis/station-data/v2/stations",
    });
    expect(stada?.maxBytes).toBe(64 * 1024 * 1024);
    expect(stada?.totalTimeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it("holds an IRIS full-changes document to 2 MiB, four times the largest one seen", () => {
    const fchg = iris.filter((source) => source.id.startsWith("db-iris-fchg-"));
    for (const source of fchg) expect(source.maxBytes, source.id).toBe(2 * 1024 * 1024);
  });

  it("skips every DB source without both keys", () => {
    for (const source of dbApiSources({ dbCredentials: null })) {
      expect(source.skipReason, source.id).toMatch(/DB_CLIENT_ID/);
      expect(source.headers).toEqual({});
    }
  });
});
