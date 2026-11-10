import type { TrainDetail } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import {
  DETAIL_CONFIRMED_KEY,
  DETAIL_FEEDS_KEY,
  frameKeyKey,
  trainChannel,
  trainDetailKey,
  trainLeftKey,
} from "./keys.ts";
import { runTtlSeconds, StoreWriteError, ValkeyDetailStore, type ValkeyPipeline } from "./store.ts";

class FakePipeline implements ValkeyPipeline {
  readonly commands: unknown[][] = [];
  private readonly fail: boolean;
  constructor(fail = false) {
    this.fail = fail;
  }
  set(key: string, value: string, mode: "EX", seconds: number) {
    this.commands.push(["set", key, value, mode, seconds]);
    return this;
  }
  hset(key: string, values: Record<string, string>) {
    this.commands.push(["hset", key, values]);
    return this;
  }
  del(...keys: string[]) {
    this.commands.push(["del", ...keys]);
    return this;
  }
  expire(key: string, seconds: number) {
    this.commands.push(["expire", key, seconds]);
    return this;
  }
  async exec(): Promise<[Error | null, unknown][]> {
    return this.commands.map((_, i) => [this.fail && i === 0 ? new Error("OOM") : null, "OK"]);
  }
}

function fakeClient(fail = false) {
  const pipelines: FakePipeline[] = [];
  return {
    pipelines,
    pipeline() {
      const pipeline = new FakePipeline(fail);
      pipelines.push(pipeline);
      return pipeline;
    },
  };
}

const detail = { tripInstanceId: "07a1535f-17cf-5e2b-b9b2-de13d923ef94" } as TrainDetail;

describe("detail keys", () => {
  it("use the names of the design note and the live engine", () => {
    expect(trainDetailKey(detail.tripInstanceId)).toBe(
      "live:train:07a1535f-17cf-5e2b-b9b2-de13d923ef94",
    );
    expect(frameKeyKey(4711)).toBe("live:inst:4711");
    expect(trainChannel(detail.tripInstanceId)).toBe("train:07a1535f-17cf-5e2b-b9b2-de13d923ef94");
    expect(DETAIL_CONFIRMED_KEY).toBe("live:detail:confirmed");
    expect(DETAIL_FEEDS_KEY).toBe("live:detail:feeds");
  });
});

describe("ValkeyDetailStore", () => {
  it("writes each detail as JSON with a 15 minute TTL in one round trip", async () => {
    const client = fakeClient();
    await new ValkeyDetailStore(client).write([detail]);
    expect(client.pipelines).toHaveLength(1);
    expect(client.pipelines[0]?.commands).toEqual([
      ["set", trainDetailKey(detail.tripInstanceId), JSON.stringify(detail), "EX", 900],
      ["del", trainLeftKey(detail.tripInstanceId)],
    ]);
  });

  it("keeps a detail for the rest of its run plus 15 minutes", async () => {
    const client = fakeClient();
    await new ValkeyDetailStore(client).write([detail], new Map([[detail.tripInstanceId, 4500]]));
    expect(client.pipelines[0]?.commands[0]?.[4]).toBe(4500);
    expect(runTtlSeconds(1_000 + 3_600, 1_000)).toBe(4_500);
    expect(runTtlSeconds(1_000 + 60, 1_000)).toBe(960);
    expect(runTtlSeconds(1_000 - 3_600, 1_000)).toBe(900);
  });

  it("marks when a train left the running set beside its final detail", async () => {
    const client = fakeClient();
    const left = Date.parse("2026-10-27T05:04:00Z");
    await new ValkeyDetailStore(client).write(
      [detail],
      new Map([[detail.tripInstanceId, 900]]),
      new Map([[detail.tripInstanceId, left]]),
    );
    expect(client.pipelines[0]?.commands[1]).toEqual([
      "set",
      trainLeftKey(detail.tripInstanceId),
      "2026-10-27T05:04:00.000Z",
      "EX",
      900,
    ]);
    expect(trainLeftKey(detail.tripInstanceId)).toBe(
      "live:left:07a1535f-17cf-5e2b-b9b2-de13d923ef94",
    );
  });

  it("discards the details of trains that could not be rebuilt", async () => {
    const client = fakeClient();
    await new ValkeyDetailStore(client).discard([detail.tripInstanceId]);
    expect(client.pipelines[0]?.commands).toEqual([
      ["del", trainDetailKey(detail.tripInstanceId), trainLeftKey(detail.tripInstanceId)],
    ]);
    await new ValkeyDetailStore(client).discard([]);
    expect(client.pipelines).toHaveLength(1);
  });

  it("skips the round trip when nothing changed", async () => {
    const client = fakeClient();
    await new ValkeyDetailStore(client).write([]);
    expect(client.pipelines).toHaveLength(0);
  });

  it("confirms the tick and the newest payload per source", async () => {
    const client = fakeClient();
    const at = Date.parse("2026-10-26T22:00:00Z");
    await new ValkeyDetailStore(client).confirm(
      at,
      new Map([["gtfsde-rt", Date.parse("2026-10-26T21:59:30Z")]]),
    );
    expect(client.pipelines[0]?.commands).toEqual([
      ["set", DETAIL_CONFIRMED_KEY, "2026-10-26T22:00:00.000Z", "EX", 900],
      ["hset", DETAIL_FEEDS_KEY, { "gtfsde-rt": "2026-10-26T21:59:30.000Z" }],
      ["expire", DETAIL_FEEDS_KEY, 900],
    ]);
  });

  it("reports a refused write", async () => {
    await expect(new ValkeyDetailStore(fakeClient(true)).write([detail])).rejects.toBeInstanceOf(
      StoreWriteError,
    );
  });
});
