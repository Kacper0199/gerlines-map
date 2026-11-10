import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TrainDetail } from "@gerlines/schema";
import Valkey from "iovalkey";
import { afterAll, describe, expect, it } from "vitest";
import { CentrifugoClient } from "./centrifugo.ts";
import {
  DETAIL_CONFIRMED_KEY,
  DETAIL_FEEDS_KEY,
  trainChannel,
  trainDetailKey,
  trainLeftKey,
} from "./keys.ts";
import { pushDetails } from "./publisher.ts";
import { ValkeyDetailStore } from "./store.ts";

/**
 * Against a real Valkey (VALKEY_TEST_URL) and Centrifugo (CENTRIFUGO_TEST_URL with
 * CENTRIFUGO_TEST_API_KEY); skipped without them. Uses its own keys only.
 */
const valkeyUrl = process.env.VALKEY_TEST_URL;
const centrifugoUrl = process.env.CENTRIFUGO_TEST_URL;
const centrifugoKey = process.env.CENTRIFUGO_TEST_API_KEY;

const ice = TrainDetail.parse(
  (
    JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures", "ice-619-realtime.json"), "utf8"),
    ) as { detail: unknown }
  ).detail,
);

describe.skipIf(!valkeyUrl)("ValkeyDetailStore against Valkey", () => {
  const client = new Valkey(valkeyUrl ?? "redis://127.0.0.1:1", { lazyConnect: true });
  afterAll(async () => {
    await client.del(
      trainDetailKey(ice.tripInstanceId),
      trainLeftKey(ice.tripInstanceId),
      DETAIL_CONFIRMED_KEY,
      DETAIL_FEEDS_KEY,
    );
    await client.quit();
  });

  it("keeps the run TTL, marks a train that left, clears the mark when it runs again", async () => {
    const store = new ValkeyDetailStore(client);
    const id = ice.tripInstanceId;
    const left = Date.parse("2026-10-27T03:10:00Z");
    await store.write([ice], new Map([[id, 4_500]]), new Map([[id, left]]));
    expect(await client.ttl(trainDetailKey(id))).toBeGreaterThan(4_490);
    expect(await client.get(trainLeftKey(id))).toBe("2026-10-27T03:10:00.000Z");
    expect(await client.ttl(trainLeftKey(id))).toBeGreaterThan(4_490);
    await store.write([ice]);
    expect(await client.exists(trainLeftKey(id))).toBe(0);
    await store.write([ice], undefined, new Map([[id, left]]));
    await store.discard([id]);
    expect(await client.exists(trainDetailKey(id), trainLeftKey(id))).toBe(0);
  });

  it("writes the detail with its TTL and confirms the tick", async () => {
    const store = new ValkeyDetailStore(client);
    await store.write([ice]);
    await store.confirm(Date.parse("2026-10-27T02:57:45Z"), new Map([["gtfsde-rt", 1]]));
    const stored = await client.get(trainDetailKey(ice.tripInstanceId));
    expect(TrainDetail.parse(JSON.parse(stored ?? "null"))).toEqual(ice);
    expect(await client.ttl(trainDetailKey(ice.tripInstanceId))).toBeGreaterThan(890);
    expect(await client.get(DETAIL_CONFIRMED_KEY)).toBe("2026-10-27T02:57:45.000Z");
    expect(await client.hgetall(DETAIL_FEEDS_KEY)).toEqual({
      "gtfsde-rt": "1970-01-01T00:00:00.001Z",
    });
  });
});

interface Push {
  push?: { channel: string; pub?: { data: unknown } };
}

async function subscriber(url: string, channel: string) {
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/connection/websocket`);
  const pushes: Push[] = [];
  let subscribed: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    subscribed = resolve;
  });
  socket.addEventListener("message", (event) => {
    for (const line of String(event.data).split("\n").filter(Boolean)) {
      const frame = JSON.parse(line) as Push & { id?: number };
      if (frame.id === 2) subscribed();
      if (frame.push) pushes.push(frame);
      if (Object.keys(frame).length === 0) socket.send("{}");
    }
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  socket.send(JSON.stringify({ id: 1, connect: {} }));
  socket.send(JSON.stringify({ id: 2, subscribe: { channel } }));
  await ready;
  return { socket, pushes };
}

describe.skipIf(!centrifugoUrl || !centrifugoKey)("pushDetails against Centrifugo", () => {
  it("delivers each detail on its own channel and drops the one nobody follows", async () => {
    const centrifugo = new CentrifugoClient({
      baseUrl: centrifugoUrl ?? "",
      apiKey: centrifugoKey ?? "",
    });
    const { socket, pushes } = await subscriber(
      centrifugoUrl ?? "",
      trainChannel(ice.tripInstanceId),
    );
    try {
      const other = { ...ice, tripInstanceId: "0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c6d" };
      const { pushed, error } = await pushDetails(centrifugo, [ice, other]);
      expect(error).toBeNull();
      expect(pushed).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pushes.map((frame) => frame.push?.channel)).toEqual([
        trainChannel(ice.tripInstanceId),
      ]);
      expect(TrainDetail.parse(pushes[0]?.push?.pub?.data)).toEqual(ice);
    } finally {
      socket.close();
    }
  });
});
