import type Valkey from "iovalkey";

/**
 * Stable u32 trip keys (FORMAT.md 3.1): assigned once per trip instance in the order given (the
 * engine passes instance-id order), never reused.
 */
export interface KeyStore {
  /** Existing keys, and new ones for ids without a key, in the order of `instanceIds`. */
  keysFor(instanceIds: readonly string[]): Promise<Map<string, number>>;
  /** The instances the given keys stand for, where known. */
  instancesOf(keys: readonly number[]): Promise<Map<number, string>>;
}

const MAX_KEY = 0xffffffff;

/** Keys in memory, counting up from `first` (renders and tests: deterministic). */
export class MemoryKeyStore implements KeyStore {
  private next: number;
  private readonly byInstance = new Map<string, number>();
  private readonly byKey = new Map<number, string>();

  constructor(first = 1) {
    this.next = first;
  }

  async keysFor(instanceIds: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const id of instanceIds) {
      let key = this.byInstance.get(id);
      if (key === undefined) {
        if (this.next > MAX_KEY) throw new RangeError("trip keys exhausted");
        key = this.next++;
        this.byInstance.set(id, key);
        this.byKey.set(key, id);
      }
      result.set(id, key);
    }
    return result;
  }

  async instancesOf(keys: readonly number[]): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    for (const key of keys) {
      const id = this.byKey.get(key);
      if (id !== undefined) result.set(key, id);
    }
    return result;
  }
}

export const KEY_PREFIX = "live:key:";
export const INSTANCE_PREFIX = "live:inst:";
export const KEY_COUNTER = "live:keyseq";
/** Mappings expire three days after their last write; a key is never handed out twice anyway. */
export const KEY_TTL_S = 3 * 86_400;

/**
 * Keys in Valkey (design note §3): `live:key:<uuid>` → key and `live:inst:<key>` → uuid, counter
 * `live:keyseq` (outside the `live:key:` prefix, so a scan of the mappings never returns it). When the counter is missing (a new or lost Valkey), it starts at `floor`, which
 * the engine derives from the clock so keys of an earlier store are not handed out again.
 */
export class ValkeyKeyStore implements KeyStore {
  private readonly client: Valkey;
  private readonly floor: number;
  private readonly clockFloor: (() => number) | undefined;
  /** Key batches that ended above the clock-derived floor (keys outrun the clock). */
  aheadOfClock = 0;
  /** The highest key handed out by this process, 0 before the first. */
  lastKey = 0;

  /**
   * `clockFloor` is the floor a lost Valkey would restart from now (seconds since the sequence
   * epoch); a counter above it means a lost store could hand those keys out again.
   */
  constructor(client: Valkey, floor: number, clockFloor?: () => number) {
    this.client = client;
    this.floor = floor;
    this.clockFloor = clockFloor;
  }

  async keysFor(instanceIds: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (instanceIds.length === 0) return result;
    const existing = await this.client.mget(instanceIds.map((id) => `${KEY_PREFIX}${id}`));
    const missing: string[] = [];
    instanceIds.forEach((id, i) => {
      const value = existing[i];
      if (value === null || value === undefined) missing.push(id);
      else result.set(id, Number(value));
    });
    if (missing.length === 0) return result;
    await this.client.set(KEY_COUNTER, String(this.floor - 1), "NX");
    const last = await this.client.incrby(KEY_COUNTER, missing.length);
    if (last > MAX_KEY) throw new RangeError("trip keys exhausted");
    this.lastKey = last;
    if (this.clockFloor && last > this.clockFloor()) this.aheadOfClock++;
    const first = last - missing.length + 1;
    const pipeline = this.client.pipeline();
    missing.forEach((id, i) => {
      const key = first + i;
      result.set(id, key);
      pipeline.set(`${KEY_PREFIX}${id}`, String(key), "EX", KEY_TTL_S);
      pipeline.set(`${INSTANCE_PREFIX}${key}`, id, "EX", KEY_TTL_S);
    });
    await pipeline.exec();
    return result;
  }

  async instancesOf(keys: readonly number[]): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    if (keys.length === 0) return result;
    const values = await this.client.mget(keys.map((key) => `${INSTANCE_PREFIX}${key}`));
    keys.forEach((key, i) => {
      const id = values[i];
      if (id) result.set(key, id);
    });
    return result;
  }
}
