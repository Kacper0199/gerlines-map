import type Valkey from "iovalkey";
import { describe, expect, it } from "vitest";
import {
  INSTANCE_PREFIX,
  KEY_COUNTER,
  KEY_PREFIX,
  KEY_TTL_S,
  MemoryKeyStore,
  ValkeyKeyStore,
} from "./keys.ts";

/** The few Valkey commands the key store uses, in memory. */
class FakeValkey {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((key) => this.values.get(key) ?? null);
  }

  async set(key: string, value: string, mode?: string, ttl?: number): Promise<"OK" | null> {
    if (mode === "NX" && this.values.has(key)) return null;
    this.values.set(key, value);
    if (mode === "EX" && ttl !== undefined) this.ttls.set(key, ttl);
    return "OK";
  }

  async incrby(key: string, by: number): Promise<number> {
    const next = Number(this.values.get(key) ?? "0") + by;
    this.values.set(key, String(next));
    return next;
  }

  pipeline() {
    const queued: (() => Promise<unknown>)[] = [];
    const chain = {
      set: (key: string, value: string, mode?: string, ttl?: number) => {
        queued.push(() => this.set(key, value, mode, ttl));
        return chain;
      },
      exec: async () => {
        for (const run of queued) await run();
        return [];
      },
    };
    return chain;
  }
}

const asValkey = (fake: FakeValkey) => fake as unknown as Valkey;

describe("ValkeyKeyStore", () => {
  it("starts a missing counter at the floor and maps both ways with a TTL", async () => {
    const fake = new FakeValkey();
    const store = new ValkeyKeyStore(asValkey(fake), 1000);
    const keys = await store.keysFor(["a", "b"]);
    expect([...keys]).toEqual([
      ["a", 1000],
      ["b", 1001],
    ]);
    expect(fake.values.get(KEY_COUNTER)).toBe("1001");
    expect(fake.values.get(`${KEY_PREFIX}a`)).toBe("1000");
    expect(fake.values.get(`${INSTANCE_PREFIX}1001`)).toBe("b");
    expect(fake.ttls.get(`${KEY_PREFIX}b`)).toBe(KEY_TTL_S);
    expect([...(await store.instancesOf([1000, 1001, 5]))]).toEqual([
      [1000, "a"],
      [1001, "b"],
    ]);
  });

  it("keeps existing keys and continues above the counter after a restart with a lower floor", async () => {
    const fake = new FakeValkey();
    await new ValkeyKeyStore(asValkey(fake), 1000).keysFor(["a"]);
    const restarted = new ValkeyKeyStore(asValkey(fake), 10);
    const keys = await restarted.keysFor(["a", "c"]);
    expect(keys.get("a")).toBe(1000);
    expect(keys.get("c")).toBe(1001);
  });

  it("counts batches whose keys outrun the clock floor", async () => {
    const fake = new FakeValkey();
    const store = new ValkeyKeyStore(asValkey(fake), 100, () => 101);
    await store.keysFor(["a", "b"]);
    expect(store.aheadOfClock).toBe(0);
    await store.keysFor(["c"]);
    expect(store.aheadOfClock).toBe(1);
    expect(store.lastKey).toBe(102);
  });
});

describe("MemoryKeyStore", () => {
  it("never hands a key out twice", async () => {
    const store = new MemoryKeyStore(7);
    expect((await store.keysFor(["x", "y"])).get("y")).toBe(8);
    expect((await store.keysFor(["y", "z"])).get("z")).toBe(9);
  });
});
