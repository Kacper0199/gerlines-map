import { describe, expect, it } from "vitest";
import type { ChainChanges } from "../chain.ts";
import { delta, keyframe, ObjectStore, TIME_BASE, trip } from "../test-frames.ts";
import {
  PlaybackDriver,
  type PlaybackHost,
  type PlaybackSink,
  type PlaybackState,
} from "./driver.ts";

const START = TIME_BASE;
const END = START + 3600;
const WALL0 = 1_000_000;

interface Window {
  readonly start: number;
  readonly store: ObjectStore;
  readonly index: unknown;
}

/** A window of keyframes every 6 sequences and a delta every 10 s: sequence n is published at start + 10 n. */
function makeWindow(
  start: number,
  sequences = 360,
  timetableVersion = 1,
  revision = "abcdef012345",
): Window {
  const store = new ObjectStore();
  const heads: number[][] = [];
  for (let sequence = 1; sequence <= sequences; sequence++) {
    const time = start + 10 * sequence;
    const base = Math.floor((sequence - 1) / 6) * 6 + 1;
    const frameTrips = [trip(1), trip(sequence + 100)];
    if (sequence === base) {
      store.putKeyframe({ ...keyframe(sequence, frameTrips, timetableVersion), timeBase: time });
    }
    if (sequence > 1) {
      store.putDelta({
        ...delta(sequence, [trip(sequence + 100)], [], timetableVersion),
        timeBase: time,
      });
    }
    heads.push([time, sequence, base, Math.max(2, base - 6 + 1), timetableVersion]);
  }
  return {
    start,
    store,
    index: {
      data: {
        format: 1,
        start,
        end: start + 3600,
        revision,
        shapeEpoch: 3,
        firstSequence: 1,
        lastSequence: sequences,
        deltaInterval: 10,
        keyframeInterval: 60,
        heads,
        objects: sequences,
        storedBytes: 1,
        renderedAt: "2026-11-08T00:00:00Z",
        renderSeconds: 1,
      },
    },
  };
}

class World {
  wall = WALL0;
  readonly windows = new Map<number, Window>();
  readonly enqueued: ChainChanges[] = [];
  readonly states: PlaybackState[] = [];
  readonly opacities: number[] = [];
  readonly speeds: number[] = [];
  clears = 0;
  leaves = 0;
  jsonCalls: string[] = [];
  packOk = true;
  packError = false;
  offline = false;
  missingStatus = 404;

  readonly host: PlaybackHost = {
    now: () => this.wall,
    json: async (path) => {
      this.jsonCalls.push(path);
      if (this.offline) throw new TypeError("network");
      const start = Number(path.slice(2));
      const window = this.windows.get(start);
      if (!window) {
        const code = this.missingStatus === 404 ? "NOT_RENDERED" : "TOO_OLD";
        return { status: this.missingStatus, body: { error: { code } } };
      }
      return { status: 200, body: window.index };
    },
    object: async (start, revision, path) => {
      if (this.offline) throw new TypeError("network");
      const window = this.windows.get(start);
      const current = (window?.index as { data: { revision: string } } | undefined)?.data.revision;
      if (revision !== current) return null;
      return (await window?.store.read(path)) ?? null;
    },
    packExists: async () => {
      if (this.packError) throw new TypeError("pack check failed");
      return this.packOk;
    },
  };

  readonly sink: PlaybackSink = {
    enqueue: (steps) => this.enqueued.push(...steps),
    clear: () => {
      this.clears++;
      this.enqueued.length = 0;
    },
    setSpeed: (speed) => this.speeds.push(speed),
    setOpacity: (opacity) => this.opacities.push(opacity),
    publish: (state) => this.states.push(state),
    leave: () => {
      this.leaves++;
    },
  };

  private current: PlaybackDriver | undefined;

  get state(): PlaybackState {
    return (this.current as PlaybackDriver).snapshot();
  }

  driver(at: number, speed = 1, playing = true, fadeMs = 200): PlaybackDriver {
    this.current = new PlaybackDriver(
      { host: this.host, sink: this.sink, fadeMs },
      at,
      speed,
      playing,
    );
    return this.current;
  }

  async settle(driver: PlaybackDriver, wallMs = 0, steps = 1): Promise<void> {
    for (let i = 0; i < steps; i++) {
      this.wall += wallMs / steps;
      driver.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

function worldWith(...starts: number[]): World {
  const world = new World();
  for (const start of starts) world.windows.set(start, makeWindow(start));
  return world;
}

describe("PlaybackDriver opening", () => {
  it("loads the window, clears the old state and queues a reload with the frames up to its lookahead", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    expect(world.jsonCalls[0]).toBe(`w/${START}`);
    expect(world.clears).toBe(1);
    expect(world.enqueued[0]?.reloaded).toBe(true);
    const times = world.enqueued.map((step) => step.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(Math.max(...times)).toBeLessThanOrEqual(START + 100 + 15);
    expect(Math.max(...times)).toBeGreaterThanOrEqual(START + 100);
    expect(world.state.phase).toBe("seeking");
  });

  it("starts the clock when the reload is on screen and then plays at the speed", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 100, 1, true);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    const at = driver.position;
    await world.settle(driver, 5_000);
    expect(driver.position - at).toBeCloseTo(5, 5);
    await world.settle(driver, 0, 1);
    expect(world.state.phase).toBe("playing");
  });

  it("stays paused when opened paused", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 100, 1, false);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 5_000);
    expect(driver.position).toBe(START + 100);
    expect(world.state.phase).toBe("paused");
  });
});

describe("PlaybackDriver playing", () => {
  async function playing(speed = 1): Promise<{ world: World; driver: PlaybackDriver }> {
    const world = worldWith(START, END);
    const driver = world.driver(START + 100, speed, true);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 0, 2);
    return { world, driver };
  }

  it("follows the head a lookahead ahead of the clock, frame by frame in order", async () => {
    const { world, driver } = await playing();
    world.enqueued.length = 0;
    await world.settle(driver, 30_000, 30);
    expect(world.enqueued.every((step) => !step.reloaded)).toBe(true);
    const times = world.enqueued.map((step) => step.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(Math.max(...times)).toBeLessThanOrEqual(driver.position + 15);
    expect(Math.max(...times)).toBeGreaterThan(driver.position);
  });

  it("looks further ahead at a higher speed", async () => {
    const { world, driver } = await playing(60);
    world.enqueued.length = 0;
    await world.settle(driver, 2_000, 4);
    expect(world.speeds.at(-1)).toBe(60);
    const ahead = Math.max(...world.enqueued.map((step) => step.time)) - driver.position;
    expect(ahead).toBeGreaterThan(100);
    expect(ahead).toBeLessThanOrEqual(240);
  });

  it("does not read a frame twice", async () => {
    const { world, driver } = await playing();
    const store = world.windows.get(START)?.store as ObjectStore;
    await world.settle(driver, 60_000, 60);
    const unique = new Set(store.requested);
    expect(unique.size).toBe(store.requested.length);
  });

  it("holds the position when paused and goes on from it", async () => {
    const { world, driver } = await playing();
    await world.settle(driver, 3_000, 3);
    driver.pause();
    const held = driver.position;
    await world.settle(driver, 10_000, 5);
    expect(driver.position).toBe(held);
    driver.play();
    await world.settle(driver, 2_000, 2);
    expect(driver.position - held).toBeCloseTo(2, 5);
  });

  it("stops the clock while the page is hidden and restarts it when it returns", async () => {
    const { world, driver } = await playing();
    driver.setHidden(true);
    const held = driver.position;
    await world.settle(driver, 60_000, 3);
    expect(driver.position).toBe(held);
    driver.setHidden(false);
    await world.settle(driver, 2_000, 2);
    expect(driver.position - held).toBeCloseTo(2, 5);
  });

  it("changes the speed without moving the position", async () => {
    const { world, driver } = await playing();
    await world.settle(driver, 2_000, 2);
    const before = driver.position;
    driver.setSpeed(10);
    expect(driver.position).toBe(before);
    await world.settle(driver, 1_000, 1);
    expect(driver.position - before).toBeCloseTo(10, 5);
  });
});

describe("PlaybackDriver seek", () => {
  it("fades out, swaps the state at the new instant, and fades in once the reload is on screen", async () => {
    const world = worldWith(START, END);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 1_000, 2);
    world.opacities.length = 0;
    world.clears = 0;
    driver.seek(START + 1800);
    await world.settle(driver, 0, 2);
    expect(world.state.position).toBe(START + 1800);
    expect(world.state.phase).toBe("seeking");
    await world.settle(driver, 300, 6);
    expect(world.opacities).toContain(0);
    expect(world.clears).toBe(1);
    expect(world.enqueued[0]?.reloaded).toBe(true);
    expect(world.enqueued[0]?.time).toBeLessThanOrEqual(START + 1800 + 15);
    expect(driver.position).toBe(START + 1800);
    driver.frameApplied(true);
    await world.settle(driver, 300, 6);
    expect(world.opacities.at(-1)).toBe(1);
    await world.settle(driver, 0, 2);
    expect(world.state.phase).toBe("playing");
    await world.settle(driver, 1_000, 2);
    expect(driver.position).toBeGreaterThan(START + 1800);
  });

  it("swaps at once and never dims with zero fade (reduced motion)", async () => {
    const world = worldWith(START, END);
    const driver = world.driver(START + 100, 1, true, 0);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    world.clears = 0;
    driver.seek(START + 2000);
    await world.settle(driver, 0, 4);
    expect(world.clears).toBe(1);
    expect(world.opacities.every((opacity) => opacity === 1)).toBe(true);
  });

  it("the last seek wins when several come at once", async () => {
    const world = worldWith(START, END);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    driver.seek(START + 500);
    driver.seek(START + 900);
    driver.seek(START + 1300);
    await world.settle(driver, 400, 8);
    expect(driver.position).toBe(START + 1300);
  });

  it("crosses into another hour with a seek", async () => {
    const world = worldWith(START, END);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    driver.seek(END + 600);
    await world.settle(driver, 400, 8);
    expect(driver.position).toBe(END + 600);
    expect(world.state.windowStart).toBe(END);
  });

  it("keeps playing and says so when the hour asked for is not rendered", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    driver.seek(START - 3000);
    await world.settle(driver, 500, 4);
    expect(world.state.notice).toBe("not_rendered");
    expect(world.state.phase).not.toBe("error");
    const at = driver.position;
    await world.settle(driver, 2_000, 2);
    expect(driver.position - at).toBeCloseTo(2, 5);
  });
});

describe("PlaybackDriver seam", () => {
  it("starts the next hour's chain as a reload when the clock reaches the end", async () => {
    const world = worldWith(START, END);
    const driver = world.driver(END - 40, 1, true);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 0, 3);
    expect(world.jsonCalls).toContain(`w/${END}`);
    world.enqueued.length = 0;
    await world.settle(driver, 45_000, 45);
    const reloads = world.enqueued.filter((step) => step.reloaded);
    expect(reloads).toHaveLength(1);
    expect(reloads[0]?.time).toBeGreaterThanOrEqual(END);
    expect(world.state.windowStart).toBe(END);
    expect(world.clears).toBe(1);
  });

  it("ends at the last window when the next hour is not rendered", async () => {
    const world = worldWith(START);
    const driver = world.driver(END - 20, 1, true);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 40_000, 40);
    expect(driver.position).toBe(END);
    expect(world.state.phase).toBe("ended");
  });

  it("goes on when the next hour turns up later", async () => {
    const world = worldWith(START);
    const driver = world.driver(END - 20, 1, true);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 40_000, 40);
    world.windows.set(END, makeWindow(END));
    await world.settle(driver, 16_000, 16);
    expect(world.state.windowStart).toBe(END);
    expect(driver.position).toBeGreaterThan(END);
  });
});

describe("PlaybackDriver leave", () => {
  it("fades out, hands over to the live source and is done once the live trains faded in", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 1_000, 2);
    world.clears = 0;
    driver.leave();
    expect(driver.isLeaving).toBe(true);
    await world.settle(driver, 300, 6);
    expect(world.clears).toBe(1);
    expect(world.leaves).toBe(1);
    expect(world.opacities).toContain(0);
    expect(driver.done).toBe(false);
    driver.frameApplied(true);
    await world.settle(driver, 300, 6);
    expect(driver.done).toBe(true);
    expect(world.opacities.at(-1)).toBe(1);
  });

  it("ignores play, pause and seek once leaving", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    driver.leave();
    driver.seek(START + 900);
    driver.play();
    await world.settle(driver, 400, 6);
    expect(world.leaves).toBe(1);
    expect(world.clears).toBe(2);
  });

  it("enters from running trains with a fade before the first swap", async () => {
    const world = worldWith(START);
    const driver = new PlaybackDriver(
      { host: world.host, sink: world.sink, fadeMs: 200 },
      START + 100,
      1,
      true,
      true,
    );
    await world.settle(driver, 0, 3);
    expect(world.clears).toBe(0);
    await world.settle(driver, 300, 6);
    expect(world.clears).toBe(1);
    expect(world.opacities).toContain(0);
  });
});

describe("PlaybackDriver errors", () => {
  it("stops with not_rendered when the first hour is missing", async () => {
    const world = worldWith();
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 3);
    expect(world.state.phase).toBe("error");
    expect(world.state.error).toBe("not_rendered");
  });

  it("names a window that is too old", async () => {
    const world = worldWith();
    world.missingStatus = 400;
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 3);
    expect(world.state.error).toBe("too_old");
  });

  it("refuses a window whose shape epoch the packs do not serve", async () => {
    const world = worldWith(START);
    world.packOk = false;
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 6);
    expect(world.state.error).toBe("epoch_mismatch");
    expect(world.enqueued).toHaveLength(0);
  });

  it("refuses a window whose frames carry another epoch than its index", async () => {
    const world = worldWith(START);
    const window = world.windows.get(START) as Window;
    (window.index as { data: { shapeEpoch: number } }).data.shapeEpoch = 9;
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 6);
    expect(world.state.error).toBe("epoch_mismatch");
  });

  it("reports offline after repeated failures and recovers when the network returns", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 0, 2);
    world.offline = true;
    await world.settle(driver, 60_000, 60);
    expect(world.state.error).toBe("offline");
    expect(world.state.phase).toBe("error");
    world.offline = false;
    await world.settle(driver, 6_000, 6);
    expect(world.state.error).toBeNull();
    driver.play();
    await world.settle(driver, 2_000, 2);
    expect(world.state.phase).toBe("playing");
  });

  it("reports offline at the opening when the index cannot be read", async () => {
    const world = worldWith(START);
    world.offline = true;
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 3);
    expect(world.state.error).toBe("offline");
  });
});

describe("PlaybackDriver first frame", () => {
  it("opens on the state published at or before the instant, never a later keyframe", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 125);
    await world.settle(driver, 0, 2);
    const reloads = world.enqueued.filter((step) => step.reloaded);
    expect(reloads).toHaveLength(1);
    expect(reloads[0]?.time).toBeLessThanOrEqual(START + 125);
  });

  it("seeks to the state published at or before the instant, and the lookahead follows after", async () => {
    const world = worldWith(START, END);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 1_000, 2);
    world.enqueued.length = 0;
    driver.seek(START + 1805);
    await world.settle(driver, 300, 4);
    const first = world.enqueued[0];
    expect(first?.reloaded).toBe(true);
    expect(first?.time).toBeLessThanOrEqual(START + 1805);
    driver.frameApplied(true);
    await world.settle(driver, 300, 8);
    const later = world.enqueued.filter((step) => !step.reloaded).map((step) => step.time);
    expect(Math.max(...later)).toBeGreaterThan(START + 1805);
  });

  it("starts the next hour at its first state and then looks ahead", async () => {
    const world = worldWith(START, END);
    const driver = world.driver(END - 10);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 20_000, 40);
    const reloads = world.enqueued.filter((step) => step.reloaded);
    expect(reloads.length).toBeGreaterThan(0);
    expect(reloads.at(-1)?.time).toBeGreaterThanOrEqual(END);
  });
});

describe("PlaybackDriver pack check failure", () => {
  it("resets the follower so the reload is read again and the seek completes", async () => {
    const world = worldWith(START);
    world.packError = true;
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 3);
    expect(world.enqueued).toHaveLength(0);
    world.packError = false;
    await world.settle(driver, 0, 3);
    expect(world.enqueued.some((step) => step.reloaded)).toBe(true);
    expect(world.state.phase).toBe("seeking");
    driver.frameApplied(true);
    await world.settle(driver, 0, 2);
    expect(world.state.phase).toBe("playing");
    expect(world.state.error).toBeNull();
  });
});

describe("PlaybackDriver clock ownership", () => {
  it("owns the clock only from the swap to the swap back to live", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 100);
    expect(driver.ownsClock).toBe(false);
    await world.settle(driver, 0, 4);
    expect(driver.ownsClock).toBe(true);
    driver.frameApplied(true);
    await world.settle(driver, 1_000, 2);
    driver.leave();
    expect(driver.ownsClock).toBe(true);
    await world.settle(driver, 80, 2);
    expect(driver.ownsClock).toBe(true);
    await world.settle(driver, 300, 6);
    expect(world.leaves).toBe(1);
    expect(driver.ownsClock).toBe(false);
  });

  it("does not own the clock during the fade out before the first swap when entering from trains", async () => {
    const world = worldWith(START);
    const driver = new PlaybackDriver(
      { host: world.host, sink: world.sink, fadeMs: 200 },
      START + 100,
      1,
      true,
      true,
    );
    await world.settle(driver, 0, 3);
    expect(driver.ownsClock).toBe(false);
    await world.settle(driver, 300, 6);
    expect(driver.ownsClock).toBe(true);
  });
});

describe("PlaybackDriver revision change", () => {
  it("rereads the index when an object is gone and seeks again when the revision changed", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 0, 2);
    world.windows.set(START, makeWindow(START, 360, 1, "bbbbbbbbbbbb"));
    world.enqueued.length = 0;
    world.jsonCalls.length = 0;
    await world.settle(driver, 20_000, 40);
    expect(world.jsonCalls).toContain(`w/${START}`);
    expect(world.enqueued.some((step) => step.reloaded)).toBe(true);
    driver.frameApplied(true);
    await world.settle(driver, 1_000, 6);
    expect(world.state.error).toBeNull();
    expect(world.state.phase).toBe("playing");
  });

  it("ends as unreadable when the revision is the same and the object stays missing", async () => {
    const world = worldWith(START);
    const driver = world.driver(START + 100);
    await world.settle(driver, 0, 4);
    driver.frameApplied(true);
    await world.settle(driver, 0, 2);
    const window = world.windows.get(START) as Window;
    world.windows.set(START, { ...window, store: new ObjectStore() });
    await world.settle(driver, 20_000, 40);
    expect(world.state.error).toBe("unreadable");
  });
});
