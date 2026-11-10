import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LiveKeyLookup, liveKeyPath, TrainDetail, trainDetailPath } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import { type AppDependencies, createApp } from "../app.ts";
import { PhotoService } from "../photos/service.ts";
import { fixedWindowLimiter } from "../search/rate-limit.ts";
import { readGate } from "../stats/reads.ts";
import { composeDetail, etagOf, matchesEtag } from "./compose.ts";
import { LiveStoreUnavailableError, type TrainDetailReader, type TrainSnapshot } from "./reader.ts";
import {
  IDENTITY_DEADLINE_MS,
  LIVE_KEY_RATE_LIMIT,
  PHOTO_DEADLINE_MS,
  TRAIN_DETAIL_RATE_LIMIT,
} from "./routes.ts";

/** The live writer's fixtures (services/live/src/detail/fixtures), the one copy of them. */
const dir = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "services",
  "live",
  "src",
  "detail",
  "fixtures",
);
const fixtures = new Map(
  readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const doc = JSON.parse(readFileSync(join(dir, name), "utf8")) as { detail: TrainDetail };
      return [name.replace(/\.json$/, ""), doc.detail] as const;
    }),
);

function fixture(name: string): TrainDetail {
  const detail = fixtures.get(name);
  if (!detail) throw new Error(`no fixture ${name}`);
  return detail;
}

const ICE = fixture("ice-619-realtime");
const ICE_4 = {
  seriesId: "db-412",
  seriesName: "ICE 4",
  variant: null,
  units: null,
  cars: null,
  lengthMetres: null,
  layer: "L3" as const,
  confidence: 0.37,
  source: "wikipedia-de-intercity-express-fleet",
};
const CONFIRMED = "2026-10-27T02:57:45.000Z";
const KEY = 4711;

class FakeReader implements TrainDetailReader {
  readonly stored = new Map<string, string>(
    [...fixtures.values()].map((detail) => [detail.tripInstanceId, JSON.stringify(detail)]),
  );
  readonly keys = new Map<number, string>([[KEY, ICE.tripInstanceId]]);
  confirmed: string | null = CONFIRMED;
  feeds: Record<string, string> = { "gtfsde-rt": "2026-10-27T02:57:40.000Z" };
  failure: Error | null = null;

  async train(id: string): Promise<TrainSnapshot> {
    if (this.failure) throw this.failure;
    return { detail: this.stored.get(id) ?? null, confirmed: this.confirmed, feeds: this.feeds };
  }

  async instanceOfKey(key: number): Promise<string | null> {
    if (this.failure) throw this.failure;
    return this.keys.get(key) ?? null;
  }
}

function harness(
  reader: TrainDetailReader | null = new FakeReader(),
  now = () => Date.parse(CONFIRMED) + 5_000,
  predictions?: AppDependencies["predictions"],
) {
  const lines: string[] = [];
  const app = createApp({
    now,
    predictions,
    trains: reader ?? undefined,
    logger: { error: (line) => void lines.push(line) },
  });
  return { app, lines };
}

describe("GET /api/v1/trains/{id}", () => {
  it("serves every fixture as a schema-valid detail with a 5 s cache and an ETag", async () => {
    const { app } = harness();
    for (const detail of fixtures.values()) {
      const response = await app.request(trainDetailPath(detail.tripInstanceId));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=5");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const body = await response.text();
      expect(response.headers.get("etag")).toBe(etagOf(body));
      expect(TrainDetail.parse(JSON.parse(body)).tripInstanceId).toBe(detail.tripInstanceId);
    }
  });

  it("fills the vehicle identity with its source name, and keeps null when the identity service fails", async () => {
    const vehicle = {
      seriesId: "db-412",
      seriesName: "ICE 4",
      variant: null,
      units: null,
      cars: null,
      lengthMetres: null,
      layer: "L3" as const,
      confidence: 0.37,
      source: "wikipedia-de-intercity-express-fleet",
      sourceName: "Wikipedia (de), Intercity-Express",
    };
    const lines: string[] = [];
    let fail = false;
    const app = createApp({
      now: () => Date.parse(CONFIRMED) + 5_000,
      trains: new FakeReader(),
      identity: {
        identify: async () => {
          if (fail) throw new Error("db down");
          return vehicle;
        },
      },
      logger: { error: (line) => void lines.push(line) },
    });
    const served = TrainDetail.parse(
      await (await app.request(trainDetailPath(ICE.tripInstanceId))).json(),
    );
    expect(served.vehicle).toEqual(vehicle);
    fail = true;
    const kept = await app.request(trainDetailPath(ICE.tripInstanceId));
    expect(kept.status).toBe(200);
    expect(TrainDetail.parse(await kept.json()).vehicle).toBeNull();
    expect(lines).toEqual(["vehicle identity failed: Error"]);
  });

  it("fills the photo of the identified series, and keeps null when the photo lookup fails", async () => {
    const vehicle = {
      seriesId: "db-412",
      seriesName: "ICE 4",
      variant: null,
      units: null,
      cars: null,
      lengthMetres: null,
      layer: "L3" as const,
      confidence: 0.37,
      source: "wikipedia-de-intercity-express-fleet",
    };
    const photo = {
      photoId: "db-412-p1",
      seriesId: "db-412",
      small: { url: "/api/v1/photos/db-412-p1-330-0123456789ab.jpg", width: 330, height: 220 },
      large: { url: "/api/v1/photos/db-412-p1-960-0123456789ab.jpg", width: 960, height: 640 },
      focus: { x: 0.5, y: 0.5 },
      title: "ICE 4.jpg",
      author: "Rail Fan",
      authorUrl: null,
      licence: "CC BY-SA 4.0",
      licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:ICE_4.jpg",
    };
    const lines: string[] = [];
    const asked: string[] = [];
    let fail = false;
    const app = createApp({
      now: () => Date.parse(CONFIRMED) + 5_000,
      trains: new FakeReader(),
      identity: { identify: async () => vehicle },
      photos: {
        forSeries: async (seriesId: string) => {
          asked.push(seriesId);
          if (fail) throw new Error("disk gone");
          return photo;
        },
        credits: async () => [],
        file: async () => null,
      },
      logger: { error: (line) => void lines.push(line) },
    });
    const served = TrainDetail.parse(
      await (await app.request(trainDetailPath(ICE.tripInstanceId))).json(),
    );
    expect(served.photo).toEqual(photo);
    expect(asked).toEqual(["db-412"]);
    fail = true;
    const kept = TrainDetail.parse(
      await (await app.request(trainDetailPath(ICE.tripInstanceId))).json(),
    );
    expect(kept.vehicle).toEqual(vehicle);
    expect(kept.photo).toBeNull();
    expect(lines).toEqual(["vehicle photo failed: Error"]);
  });

  it("answers within the photo deadline with photo null when the photo lookup hangs", async () => {
    const lines: string[] = [];
    const app = createApp({
      now: () => Date.parse(CONFIRMED) + 5_000,
      trains: new FakeReader(),
      identity: { identify: async () => ICE_4 },
      photos: {
        forSeries: () => new Promise(() => {}),
        credits: async () => [],
        file: async () => null,
      },
      logger: { error: (line) => void lines.push(line) },
    });
    const started = performance.now();
    const response = await app.request(trainDetailPath(ICE.tripInstanceId));
    const elapsed = performance.now() - started;
    expect(response.status).toBe(200);
    const served = TrainDetail.parse(await response.json());
    expect(served.vehicle).toEqual(ICE_4);
    expect(served.photo).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(PHOTO_DEADLINE_MS - 5);
    expect(elapsed).toBeLessThan(1_000);
    expect(lines).toEqual([`vehicle photo took longer than ${PHOTO_DEADLINE_MS} ms`]);
  });

  it("asks a photo database that failed cold once per retry period and answers each detail at once", async () => {
    const lines: string[] = [];
    let calls = 0;
    const photos = new PhotoService({
      store: {
        photos: async () => {
          calls += 1;
          throw new Error("connect ETIMEDOUT");
        },
      },
      root: ".",
      logger: { error: (line) => void lines.push(line) },
    });
    const app = createApp({
      now: () => Date.parse(CONFIRMED) + 5_000,
      trains: new FakeReader(),
      identity: { identify: async () => ICE_4 },
      photos,
      logger: { error: (line) => void lines.push(line) },
    });
    for (let i = 0; i < 4; i += 1) {
      const started = performance.now();
      const served = TrainDetail.parse(
        await (await app.request(trainDetailPath(ICE.tripInstanceId))).json(),
      );
      expect(performance.now() - started).toBeLessThan(PHOTO_DEADLINE_MS);
      expect(served.photo).toBeNull();
    }
    expect(calls).toBe(1);
    expect(lines).toEqual([
      "photo catalogue load failed: Error",
      "vehicle photo failed: PhotoCatalogueUnavailableError",
    ]);
  });

  it("answers within the identity deadline with vehicle null when the identity service hangs", async () => {
    const lines: string[] = [];
    const app = createApp({
      now: () => Date.parse(CONFIRMED) + 5_000,
      trains: new FakeReader(),
      identity: { identify: () => new Promise(() => {}) },
      logger: { error: (line) => void lines.push(line) },
    });
    const started = performance.now();
    const response = await app.request(trainDetailPath(ICE.tripInstanceId));
    const elapsed = performance.now() - started;
    expect(response.status).toBe(200);
    expect(TrainDetail.parse(await response.json()).vehicle).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(IDENTITY_DEADLINE_MS - 5);
    expect(elapsed).toBeLessThan(1_000);
    expect(lines).toEqual([`vehicle identity took longer than ${IDENTITY_DEADLINE_MS} ms`]);
  });

  it("moves asOf to the confirmed tick and feedObservedAt to the source's newest payload", async () => {
    const { app } = harness();
    const served = TrainDetail.parse(
      await (await app.request(trainDetailPath(ICE.tripInstanceId))).json(),
    );
    expect(ICE.asOf).toBe("2026-10-27T02:57:40.000Z");
    expect(served.asOf).toBe(CONFIRMED);
    expect(ICE.provenance.feedObservedAt).toBe("2026-10-27T02:57:37.786Z");
    expect(served.provenance.feedObservedAt).toBe("2026-10-27T02:57:40.000Z");
    expect({ ...served, asOf: ICE.asOf, provenance: ICE.provenance }).toEqual({
      ...ICE,
      forecast: null,
    });
  });

  it("adds the forecast of the forecaster, and null when it has none or fails", async () => {
    const path = trainDetailPath(ICE.tripInstanceId);
    const forecast = {
      method: "b1-change",
      fromIndex: 17,
      fromDelayMinutes: 2,
      upperQuantile: 0.8,
      trainedFrom: "2026-08",
      trainedTo: "2026-10",
      sourceName: "piebro/deutsche-bahn-data",
      attribution:
        "Deutsche Bahn train data, collected and processed by piebro, data from Deutsche Bahn",
      licence: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
      stops: [
        {
          index: 18,
          stopsAhead: 1,
          expectedDelayMinutes: 3,
          upperDelayMinutes: 6,
          level: "train" as const,
          runs: 61,
        },
      ],
    };
    const { app } = harness(new FakeReader(), undefined, { forecast: () => forecast });
    const served = TrainDetail.parse(await (await app.request(path)).json());
    expect(served.forecast).toEqual(forecast);
    const failing = harness(new FakeReader(), undefined, {
      forecast: () => {
        throw new RangeError("broken table");
      },
    });
    const response = await failing.app.request(path);
    expect(response.status).toBe(200);
    expect(TrainDetail.parse(await response.json()).forecast).toBeNull();
    expect(failing.lines).toEqual(["forecast failed: RangeError"]);
  });

  it("answers 304 to a matching If-None-Match and a new ETag once the tick moves on", async () => {
    const reader = new FakeReader();
    const { app } = harness(reader);
    const path = trainDetailPath(ICE.tripInstanceId);
    const first = await app.request(path);
    const etag = first.headers.get("etag") ?? "";
    const again = await app.request(path, { headers: { "If-None-Match": `W/${etag}, "x"` } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    reader.confirmed = "2026-10-27T02:57:50.000Z";
    const moved = await app.request(path, { headers: { "If-None-Match": etag } });
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).not.toBe(etag);
  });

  it("answers 404 for a train the live engine does not keep", async () => {
    const { app } = harness();
    const response = await app.request(trainDetailPath("0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c6d"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("public, max-age=5");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("accepts an upper-case id and refuses anything that is no UUID", async () => {
    const { app } = harness();
    const upper = await app.request(trainDetailPath(ICE.tripInstanceId.toUpperCase()));
    expect(upper.status).toBe(200);
    for (const id of [
      "619",
      "07a1535f-17cf-5e2b-b9b2-de13d923ef9",
      "../../etc/passwd",
      "live:train:*",
    ]) {
      const response = await app.request(trainDetailPath(id));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("answers 503 with Retry-After when the live store is down, and logs no detail", async () => {
    const reader = new FakeReader();
    reader.failure = new LiveStoreUnavailableError("connect ECONNREFUSED 127.0.0.1:6379");
    const { app, lines } = harness(reader);
    const response = await app.request(trainDetailPath(ICE.tripInstanceId));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: "live_unavailable" });
    expect(lines).toHaveLength(1);
  });

  it("logs a flood of store failures once per ten seconds with the held-back count", async () => {
    const reader = new FakeReader();
    reader.failure = new LiveStoreUnavailableError("connect ECONNREFUSED 127.0.0.1:6379");
    let now = Date.parse(CONFIRMED);
    const { app, lines } = harness(reader, () => now);
    for (let i = 0; i < 50; i += 1) await app.request(trainDetailPath(ICE.tripInstanceId));
    expect(lines).toHaveLength(1);
    now += 10_000;
    await app.request(trainDetailPath(ICE.tripInstanceId));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("(49 more since the last report)");
  });

  it("answers 500 without the stored text when a stored detail breaks the contract", async () => {
    const reader = new FakeReader();
    reader.stored.set(ICE.tripInstanceId, JSON.stringify({ ...ICE, stops: [] }));
    const { app } = harness(reader);
    const response = await app.request(trainDetailPath(ICE.tripInstanceId));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });

  it("answers 503 not_configured without a live store", async () => {
    const { app } = harness(null);
    const response = await app.request(trainDetailPath(ICE.tripInstanceId));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });
});

describe("GET /api/v1/live/keys/{key}", () => {
  it("returns the trip instance of a frame key, cached for a day", async () => {
    const { app } = harness();
    const response = await app.request(liveKeyPath(KEY));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(LiveKeyLookup.parse(await response.json())).toEqual({
      tripInstanceId: ICE.tripInstanceId,
    });
  });

  it("answers 404 for an unknown key and 400 for anything outside u32", async () => {
    const { app } = harness();
    expect((await app.request(liveKeyPath(17))).status).toBe(404);
    for (const key of ["-1", "4294967296", "01", "1e3", "abc", "99999999999"]) {
      expect((await app.request(`/api/v1/live/keys/${key}`)).status).toBe(400);
    }
    expect((await app.request(liveKeyPath(0xffff_ffff))).status).toBe(404);
  });

  it("treats a stored value that is no UUID as unknown", async () => {
    const reader = new FakeReader();
    reader.keys.set(9, "not-a-uuid");
    const { app } = harness(reader);
    expect((await app.request(liveKeyPath(9))).status).toBe(404);
  });
});

describe("a silent live engine", () => {
  it("answers 503 when the last confirmation is older than 30 s or missing", async () => {
    const reader = new FakeReader();
    const late = harness(reader, () => Date.parse(CONFIRMED) + 31_000);
    const response = await late.app.request(trainDetailPath(ICE.tripInstanceId));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "live_unavailable" });
    reader.confirmed = null;
    const missing = await harness(reader).app.request(trainDetailPath(ICE.tripInstanceId));
    expect(missing.status).toBe(503);
  });
});

describe("per-client limits and the identity gate", () => {
  const at = Date.parse(CONFIRMED) + 5_000;
  const limitedApp = (
    peer: { current: string },
    options: Partial<Parameters<typeof createApp>[0]>,
  ) =>
    createApp({
      now: () => at,
      trains: new FakeReader(),
      logger: { error: () => undefined },
      peerAddress: () => peer.current,
      ...options,
    });

  it("limits train details per client with Retry-After, and other clients still pass", async () => {
    const peer = { current: "203.0.113.1" };
    const app = limitedApp(peer, {
      trainDetailLimiter: fixedWindowLimiter({ limit: 2, windowMs: 60_000, now: () => at }),
    });
    const path = trainDetailPath(ICE.tripInstanceId);
    expect((await app.request(path)).status).toBe(200);
    expect((await app.request(trainDetailPath("not-a-uuid"))).status).toBe(400);
    const refused = await app.request(path);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    peer.current = "203.0.113.2";
    expect((await app.request(path)).status).toBe(200);
  });

  it("limits live key lookups per client", async () => {
    const peer = { current: "203.0.113.1" };
    const app = limitedApp(peer, {
      liveKeyLimiter: fixedWindowLimiter({ limit: 1, windowMs: 60_000, now: () => at }),
    });
    expect((await app.request(liveKeyPath(KEY))).status).toBe(200);
    expect((await app.request(liveKeyPath(KEY + 1))).status).toBe(429);
    peer.current = "2001:db8::1";
    expect((await app.request(liveKeyPath(KEY))).status).toBe(200);
  });

  it("allows 120 detail requests and 120 key lookups a minute per client by default", async () => {
    expect(TRAIN_DETAIL_RATE_LIMIT).toBe(120);
    expect(LIVE_KEY_RATE_LIMIT).toBe(120);
    const app = limitedApp({ current: "203.0.113.1" }, {});
    const keys: number[] = [];
    const details: number[] = [];
    for (let index = 0; index <= LIVE_KEY_RATE_LIMIT; index += 1) {
      keys.push((await app.request(liveKeyPath(KEY))).status);
      details.push(
        (await app.request(trainDetailPath("00000000-0000-4000-8000-000000000000"))).status,
      );
    }
    expect(keys.filter((status) => status === 200)).toHaveLength(LIVE_KEY_RATE_LIMIT);
    expect(keys.at(-1)).toBe(429);
    expect(details.filter((status) => status === 404)).toHaveLength(TRAIN_DETAIL_RATE_LIMIT);
    expect(details.at(-1)).toBe(429);
  });

  it("tells the identity service which client asked, by its limiter key", async () => {
    const clients: (string | undefined)[] = [];
    const app = limitedApp(
      { current: "2001:db8:1:2::7" },
      {
        identity: {
          identify: async (_detail, client) => {
            clients.push(client);
            return ICE_4;
          },
        },
      },
    );
    expect((await app.request(trainDetailPath(ICE.tripInstanceId))).status).toBe(200);
    expect(clients).toEqual(["2001:db8:1:2::/64"]);
  });

  it("skips the identity while the identity reads are all taken, and asks again once one ends", async () => {
    const pending: Array<() => void> = [];
    let asked = 0;
    const app = limitedApp(
      { current: "203.0.113.1" },
      {
        identityReads: readGate(1),
        identity: {
          identify: () => {
            asked += 1;
            return new Promise((resolve) => pending.push(() => resolve(ICE_4)));
          },
        },
      },
    );
    const path = trainDetailPath(ICE.tripInstanceId);
    const first = TrainDetail.parse(await (await app.request(path)).json());
    expect(first.vehicle).toBeNull();
    const second = await app.request(path);
    expect(second.status).toBe(200);
    expect(TrainDetail.parse(await second.json()).vehicle).toBeNull();
    expect(asked).toBe(1);
    pending.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    await app.request(path);
    expect(asked).toBe(2);
    pending.shift()?.();
  });
});

describe("compose and ETag helpers", () => {
  it("keeps the stored times when the confirmation is older or unreadable", () => {
    const stored = JSON.stringify(ICE);
    for (const confirmed of ["2026-10-27T01:00:00Z", "not a date", null]) {
      expect(composeDetail({ detail: stored, confirmed, feeds: {} })?.asOf).toBe(ICE.asOf);
    }
  });

  it("recomputes progress at the served time so it never freezes between writes", () => {
    const served = composeDetail({
      detail: JSON.stringify(ICE),
      confirmed: "2026-10-27T03:50:00Z",
      feeds: {},
    });
    expect(ICE.progress).toEqual({ lastPassedIndex: 17, nextIndex: 18 });
    expect(served?.progress).toEqual({ lastPassedIndex: 18, nextIndex: 19 });
  });

  it("never serves progress behind the live engine's progress stored with the detail", () => {
    const ahead = { ...ICE, progress: { lastPassedIndex: 19, nextIndex: 20 } };
    const served = composeDetail({
      detail: JSON.stringify(ahead),
      confirmed: "2026-10-27T03:50:00Z",
      feeds: {},
    });
    expect(served?.progress).toEqual({ lastPassedIndex: 19, nextIndex: 20 });
  });

  it("stops moving asOf past the moment a train left the running set", () => {
    const served = composeDetail({
      detail: JSON.stringify(ICE),
      confirmed: "2026-10-27T05:30:00Z",
      left: "2026-10-27T05:04:00Z",
      feeds: {},
    });
    expect(served?.asOf).toBe("2026-10-27T05:04:00.000Z");
    expect(served?.progress).toEqual({ lastPassedIndex: 21, nextIndex: null });
  });

  it("passes fields of a newer live writer through and still refuses a broken detail", () => {
    const newer = { ...ICE, consist: { cars: 8 } };
    const served = composeDetail({ detail: JSON.stringify(newer), confirmed: null, feeds: {} });
    expect(served).toMatchObject({ consist: { cars: 8 } });
    const broken = { ...ICE, progress: { lastPassedIndex: 5, nextIndex: 2 } };
    expect(() =>
      composeDetail({ detail: JSON.stringify(broken), confirmed: null, feeds: {} }),
    ).toThrow();
  });

  it("serves platforms without the word the card prints, keeping a change's planned value", () => {
    const stops = ICE.stops.map((stop, index) =>
      index === 1
        ? { ...stop, platformScheduled: "Gl. 4", platformActual: "Gleis 5" }
        : index === 2
          ? { ...stop, platformScheduled: "Gl1", platformActual: null }
          : index === 3
            ? { ...stop, platformScheduled: "DB", platformActual: null }
            : stop,
    );
    const served = composeDetail({
      detail: JSON.stringify({ ...ICE, stops }),
      confirmed: null,
      feeds: {},
    });
    expect(served?.stops[1]).toMatchObject({ platformScheduled: "4", platformActual: "5" });
    expect(served?.stops[2]).toMatchObject({ platformScheduled: "1", platformActual: null });
    expect(served?.stops[3]).toMatchObject({ platformScheduled: null, platformActual: null });
    expect(served?.stops[0]).toMatchObject({
      platformScheduled: ICE.stops[0]?.platformScheduled,
      platformActual: ICE.stops[0]?.platformActual,
    });
  });

  it("leaves a timetable detail's provenance alone", () => {
    const timetable = fixture("ice-1540-timetable");
    const served = composeDetail({
      detail: JSON.stringify(timetable),
      confirmed: null,
      feeds: { "delfi-gtfs": "2026-10-27T02:59:00Z" },
    });
    expect(served?.provenance).toEqual(timetable.provenance);
  });

  it("compares entity tags weakly and accepts the star", () => {
    expect(matchesEtag('"a", W/"b"', '"b"')).toBe(true);
    expect(matchesEtag("*", '"b"')).toBe(true);
    expect(matchesEtag('"a"', '"b"')).toBe(false);
    expect(matchesEtag(undefined, '"b"')).toBe(false);
  });
});
