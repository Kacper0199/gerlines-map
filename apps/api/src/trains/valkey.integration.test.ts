import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LiveKeyLookup, liveKeyPath, TrainDetail, trainDetailPath } from "@gerlines/schema";
import Valkey from "iovalkey";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import {
  DETAIL_CONFIRMED_KEY,
  DETAIL_FEEDS_KEY,
  FRAME_KEY_PREFIX,
  TRAIN_DETAIL_PREFIX,
  TRAIN_LEFT_PREFIX,
} from "./reader.ts";
import { liveStoreFromEnv } from "./valkey.ts";

/** Against a real Valkey (VALKEY_TEST_URL, a throwaway instance); skipped without one. */
const valkeyUrl = process.env.VALKEY_TEST_URL;
const KEY = 4_294_967_295;
const CONFIRMED = "2026-10-27T02:57:45.000Z";
const SERVER_NOW = Date.parse(CONFIRMED) + 5_000;

const ice = TrainDetail.parse(
  (
    JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../../services/live/src/detail/fixtures/ice-619-realtime.json",
        ),
        "utf8",
      ),
    ) as { detail: unknown }
  ).detail,
);

function app(url: string, now = SERVER_NOW) {
  const lines: string[] = [];
  const logger = { error: (line: string) => void lines.push(line) };
  const trains = liveStoreFromEnv({ VALKEY_URL: url }, logger);
  return {
    lines,
    app: createApp({
      trains,
      logger,
      now: () => now,
    }),
  };
}

describe.skipIf(!valkeyUrl)("train routes against Valkey", () => {
  const seed = new Valkey(valkeyUrl ?? "redis://127.0.0.1:1", { lazyConnect: true });
  const detailKey = `${TRAIN_DETAIL_PREFIX}${ice.tripInstanceId}`;
  const leftKey = `${TRAIN_LEFT_PREFIX}${ice.tripInstanceId}`;

  beforeAll(async () => {
    await seed.set(detailKey, JSON.stringify(ice), "EX", 900);
    await seed.set(DETAIL_CONFIRMED_KEY, CONFIRMED, "EX", 900);
    await seed.hset(DETAIL_FEEDS_KEY, { "gtfsde-rt": "2026-10-27T02:57:40.000Z" });
    await seed.set(`${FRAME_KEY_PREFIX}${KEY}`, ice.tripInstanceId);
  });

  afterAll(async () => {
    await seed.del(
      detailKey,
      leftKey,
      DETAIL_CONFIRMED_KEY,
      DETAIL_FEEDS_KEY,
      `${FRAME_KEY_PREFIX}${KEY}`,
    );
    await seed.quit();
  });

  it("serves the stored detail with the confirmed tick, then 304 for its ETag", async () => {
    const { app: api } = app(valkeyUrl ?? "");
    const first = await api.request(trainDetailPath(ice.tripInstanceId));
    expect(first.status).toBe(200);
    const served = TrainDetail.parse(await first.json());
    expect(served.asOf).toBe(CONFIRMED);
    expect(served.provenance.feedObservedAt).toBe("2026-10-27T02:57:40.000Z");
    const again = await api.request(trainDetailPath(ice.tripInstanceId), {
      headers: { "If-None-Match": first.headers.get("etag") ?? "" },
    });
    expect(again.status).toBe(304);
    expect(
      (await api.request(trainDetailPath("0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c6d"))).status,
    ).toBe(404);
  });

  it("caps asOf at the left marker read in the same transaction", async () => {
    const left = new Date(Date.parse(CONFIRMED) - 60_000).toISOString();
    await seed.set(leftKey, left, "EX", 900);
    try {
      const { app: api } = app(valkeyUrl ?? "");
      const response = await api.request(trainDetailPath(ice.tripInstanceId));
      expect(response.status).toBe(200);
      expect(TrainDetail.parse(await response.json()).asOf <= left).toBe(true);
    } finally {
      await seed.del(leftKey);
    }
  });

  it("answers 503 no-store while the engine has not confirmed for 30 s", async () => {
    const { app: api } = app(valkeyUrl ?? "", Date.parse(CONFIRMED) + 31_000);
    const response = await api.request(trainDetailPath(ice.tripInstanceId));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("resolves a frame key", async () => {
    const { app: api } = app(valkeyUrl ?? "");
    const response = await api.request(liveKeyPath(KEY));
    expect(response.status).toBe(200);
    expect(LiveKeyLookup.parse(await response.json()).tripInstanceId).toBe(ice.tripInstanceId);
  });

  it("answers 503 quickly when the store does not answer", async () => {
    const { app: api, lines } = app("redis://127.0.0.1:1");
    const began = Date.now();
    const response = await api.request(trainDetailPath(ice.tripInstanceId));
    expect(response.status).toBe(503);
    expect(Date.now() - began).toBeLessThan(3000);
    expect(lines.join("\n")).not.toContain("redis://");
  });
});
