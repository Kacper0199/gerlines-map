import { createDatabase } from "@gerlines/db";
import { TrainDetail } from "@gerlines/schema";
import Valkey from "iovalkey";
import { afterAll, describe, expect, it } from "vitest";
import { DETAIL_HEARTBEAT_S } from "../engine/detail-feed.ts";
import { LiveEngine } from "../engine/engine.ts";
import { MemoryKeyStore } from "../engine/keys.ts";
import { newChainStart } from "../publish/restore.ts";
import { HistoryReader } from "../realtime/readers.ts";
import { detailPublisherFor, detailReadMode } from "../run.ts";
import { currentShapeEpoch } from "../shapes/packs.ts";
import { DatabaseTimetable } from "../timetable/loader.ts";
import {
  DETAIL_CONFIRMED_KEY,
  DETAIL_FEEDS_KEY,
  DETAIL_TTL_S,
  trainDetailKey,
  trainLeftKey,
} from "./keys.ts";
import type { DetailPort, LiveInstanceState, LiveTickUpdate } from "./port.ts";

/**
 * `live run`'s detail wiring on the real engine over a replay database
 * (GERLINES_DETAIL_DATABASE_URL, the window from GERLINES_WIRED_FROM) and a real Valkey
 * (VALKEY_TEST_URL); skipped without them. Removes every key it wrote.
 */
const databaseUrl = process.env.GERLINES_DETAIL_DATABASE_URL;
const valkeyUrl = process.env.VALKEY_TEST_URL;
const FROM = Date.parse(process.env.GERLINES_WIRED_FROM ?? "2026-10-27T02:40:00Z") / 1000;
const MINUTES = 5;
const HISTORY_LOOKBACK_S = 6 * 3600;

class Watch implements DetailPort {
  readonly running = new Set<string>();
  readonly left = new Map<string, LiveInstanceState>();
  readonly touched = new Set<string>();
  readonly inner: DetailPort;

  constructor(inner: DetailPort) {
    this.inner = inner;
  }

  async publish(update: LiveTickUpdate): Promise<void> {
    await this.inner.publish(update);
    for (const state of update.changed) {
      this.touched.add(state.tripInstanceId);
      this.running.add(state.tripInstanceId);
      this.left.delete(state.tripInstanceId);
    }
    for (const state of update.removed) {
      this.touched.add(state.tripInstanceId);
      this.running.delete(state.tripInstanceId);
      this.left.set(state.tripInstanceId, state);
    }
  }
}

interface Tally {
  reads: number;
  missing: number;
  invalid: number;
  lateConfirms: number;
}

/** Reads every running train's detail and the confirmation time as the API would at `now`. */
async function sample(valkey: Valkey, watch: Watch, now: number, tally: Tally): Promise<void> {
  const confirmed = Number(await valkey.get(DETAIL_CONFIRMED_KEY));
  if (confirmed < (now - DETAIL_HEARTBEAT_S) * 1000) tally.lateConfirms += 1;
  const ids = [...watch.running];
  if (ids.length === 0) return;
  for (const value of await valkey.mget(...ids.map(trainDetailKey))) {
    tally.reads += 1;
    if (value === null) tally.missing += 1;
    else if (!TrainDetail.safeParse(JSON.parse(value)).success) tally.invalid += 1;
  }
}

describe.skipIf(!databaseUrl || !valkeyUrl)("live run's detail writer on the engine", () => {
  const db = createDatabase({
    databaseUrl: databaseUrl ?? "postgres://unused/unused",
    applicationName: "gerlines-live-wired-test",
    maxConnections: 6,
  });
  const valkey = new Valkey(valkeyUrl ?? "redis://127.0.0.1:1", { lazyConnect: true });
  let watch: Watch | null = null;

  afterAll(async () => {
    const ids = [...(watch?.touched ?? [])];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      await valkey.del(...part.map(trainDetailKey), ...part.map(trainLeftKey));
    }
    await valkey.del(DETAIL_CONFIRMED_KEY, DETAIL_FEEDS_KEY);
    await valkey.quit();
    await db.destroy();
  });

  it("keeps a valid detail for every running train and confirms at least every heartbeat", async () => {
    await valkey.connect();
    const errors: string[] = [];
    const publisher = detailPublisherFor({
      db,
      valkey,
      mode: detailReadMode("replay:2026-10-27T02:40:00Z:1"),
      env: {},
      logger: { info: () => {}, error: (line) => void errors.push(line) },
    });
    expect(publisher).not.toBeNull();
    if (!publisher) return;
    watch = new Watch(publisher);
    const engine = new LiveEngine({
      timetable: new DatabaseTimetable(db),
      reader: new HistoryReader(db, FROM - HISTORY_LOOKBACK_S),
      keys: new MemoryKeyStore(newChainStart(FROM, 0)),
      sink: { object: async () => undefined, head: async () => undefined },
      shapeEpoch: await currentShapeEpoch(db),
      firstSequence: newChainStart(FROM, 0),
      detail: watch,
      onDetailError: (error) => void errors.push(String(error)),
      switchCoverage: 0.5,
    });
    const tally: Tally = { reads: 0, missing: 0, invalid: 0, lateConfirms: 0 };
    for (let now = FROM; now <= FROM + MINUTES * 60; now += 1) {
      await engine.tick(now);
      if (now === FROM || (now - FROM) % 60 !== 0) continue;
      await engine.detailIdle();
      await sample(valkey, watch, now, tally);
    }
    await engine.detailIdle();
    expect(errors).toEqual([]);
    expect(engine.detailStats).toMatchObject({ failed: 0, dropped: 0 });
    expect(tally.reads).toBeGreaterThan(100);
    expect(tally).toMatchObject({ missing: 0, invalid: 0, lateConfirms: 0 });
    const states = [...watch.left.values()];
    const recent = states.filter((state) => state.endsAt + DETAIL_TTL_S > state.at);
    const long = states.filter((state) => state.endsAt + DETAIL_TTL_S <= state.at);
    expect(recent.length).toBeGreaterThan(0);
    const marks = await valkey.mget(...recent.map((state) => trainLeftKey(state.tripInstanceId)));
    expect(marks.filter((mark) => mark === null)).toEqual([]);
    if (long.length > 0) {
      const kept = await valkey.mget(...long.map((state) => trainDetailKey(state.tripInstanceId)));
      expect(kept.filter((value) => value !== null)).toEqual([]);
    }
  });
});
