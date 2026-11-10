import { describe, expect, it } from "vitest";
import { ChainError, ChainFollower } from "./chain.ts";
import { delta, head, keyframe, ObjectStore, trip } from "./test-frames.ts";

function chain(): ObjectStore {
  const store = new ObjectStore();
  store.putKeyframe(keyframe(10, [trip(1), trip(2)]));
  store.putDelta(delta(11, [trip(3)]));
  store.putDelta(delta(12, [trip(2, { line: "RE 2" })], [1]));
  return store;
}

describe("ChainFollower", () => {
  it("joins with the keyframe and the deltas after it", async () => {
    const store = chain();
    const follower = new ChainFollower(store.read);
    const changes = await follower.follow(head(12, 10, 11));
    expect(changes.reloaded).toBe(true);
    expect(store.requested).toEqual(["k/10.bin", "d/11.bin", "d/12.bin"]);
    expect(changes.changed.map((t) => t.key).sort()).toEqual([2, 3]);
    expect(changes.changed.find((t) => t.key === 2)?.line).toBe("RE 2");
    expect(changes.removed).toEqual([1]);
    expect(follower.sequence).toBe(12);
    expect([...follower.state.keys()].sort()).toEqual([2, 3]);
  });

  it("follows with deltas only while the head keeps its state", async () => {
    const store = chain();
    const follower = new ChainFollower(store.read);
    await follower.follow(head(12, 10, 11));
    store.putDelta(delta(13, [trip(4)]));
    store.requested.length = 0;
    const changes = await follower.follow(head(13, 10, 11));
    expect(changes.reloaded).toBe(false);
    expect(store.requested).toEqual(["d/13.bin"]);
    expect(changes.changed.map((t) => t.key)).toEqual([4]);
  });

  it("follows one step per frame, each with its own time, so a caller can apply them in time", async () => {
    const store = chain();
    const follower = new ChainFollower(store.read);
    const steps = await follower.followSteps(head(12, 10, 11));
    expect(steps.map((step) => [step.reloaded, step.time])).toEqual([
      [true, keyframe(10, []).timeBase],
      [false, delta(11, []).timeBase],
      [false, delta(12, []).timeBase],
    ]);
    expect([...(steps[0]?.keys ?? [])].sort()).toEqual([1, 2]);
    expect(steps[1]?.keys).toBeNull();
    expect(steps[1]?.changed.map((t) => t.key)).toEqual([3]);
    expect(steps[2]?.removed).toEqual([1]);
    expect(steps[2]?.changed.map((t) => t.key)).toEqual([2]);
  });

  it("returns no steps when the head is the state", async () => {
    const store = chain();
    const follower = new ChainFollower(store.read);
    await follower.follow(head(12, 10, 11));
    expect(await follower.followSteps(head(12, 10, 11))).toEqual([]);
  });

  it("reports the publication time of the newest frame it applied", async () => {
    const store = chain();
    const follower = new ChainFollower(store.read);
    const changes = await follower.follow(head(12, 10, 11));
    expect(changes.time).toBe(delta(12, []).timeBase);
    expect(follower.timeBase).toBe(delta(12, []).timeBase);
  });

  it("fetches nothing when the head is the state", async () => {
    const store = chain();
    const follower = new ChainFollower(store.read);
    await follower.follow(head(12, 10, 11));
    store.requested.length = 0;
    const changes = await follower.follow(head(12, 10, 11));
    expect(store.requested).toEqual([]);
    expect(changes).toEqual({
      time: keyframe(10, []).timeBase + 2,
      shapeEpoch: 3,
      reloaded: false,
      keys: null,
      changed: [],
      removed: [],
    });
  });

  it("reloads the keyframe after a gap and reports trips that vanished", async () => {
    const store = chain();
    const follower = new ChainFollower(store.read);
    await follower.follow(head(12, 10, 11));
    store.putKeyframe(keyframe(30, [trip(3), trip(9)]));
    store.putDelta(delta(31, [trip(9, { line: "S 1" })]));
    const changes = await follower.follow(head(31, 30, 31));
    expect(changes.reloaded).toBe(true);
    expect([...changes.removed].sort()).toEqual([2]);
    expect(changes.changed.map((t) => t.key).sort()).toEqual([3, 9]);
    expect(follower.sequence).toBe(31);
  });

  it("reloads when the timetable version changes, keeping trips by key", async () => {
    const store = chain();
    const follower = new ChainFollower(store.read);
    await follower.follow(head(12, 10, 11));
    store.putKeyframe(keyframe(20, [trip(2), trip(5)], 2));
    const changes = await follower.follow(head(20, 20, 21, 2));
    expect(changes.reloaded).toBe(true);
    expect(changes.removed).toEqual([3]);
    expect(follower.timetableVersion).toBe(2);
  });

  it("a delta that does not apply resets the state and raises ChainError", async () => {
    const store = chain();
    const follower = new ChainFollower(store.read);
    await follower.follow(head(12, 10, 11));
    store.putRaw("d/14.bin", new Uint8Array(0));
    store.putDelta(delta(14, [trip(8)]));
    await expect(follower.follow(head(14, 10, 11))).rejects.toBeInstanceOf(ChainError);
    expect(follower.sequence).toBeNull();
  });

  it("a missing object raises ChainError and the next follow starts from the keyframe", async () => {
    const store = chain();
    store.drop("d/11.bin");
    const follower = new ChainFollower(store.read);
    await expect(follower.follow(head(12, 10, 11))).rejects.toBeInstanceOf(ChainError);
    store.putDelta(delta(11, [trip(3)]));
    const changes = await follower.follow(head(12, 10, 11));
    expect(changes.reloaded).toBe(true);
    expect(follower.sequence).toBe(12);
  });

  it("rejects a keyframe whose timetable differs from the head's", async () => {
    const store = new ObjectStore();
    store.putKeyframe(keyframe(10, [trip(1)], 5));
    const follower = new ChainFollower(store.read);
    await expect(follower.follow(head(10, 10, 11, 1))).rejects.toBeInstanceOf(ChainError);
  });

  it("raises ChainError for bytes that do not decode", async () => {
    const store = new ObjectStore();
    store.putRaw("k/10.bin", Uint8Array.from([1, 2, 3, 4]));
    const follower = new ChainFollower(store.read);
    await expect(follower.follow(head(10, 10, 11))).rejects.toBeInstanceOf(ChainError);
  });

  it("keeps its state through a network failure and goes on from the last frame", async () => {
    const store = chain();
    const follower = new ChainFollower(async (path) => {
      if (path === "d/12.bin" && !store.requested.includes("late")) {
        store.requested.push("late");
        throw new TypeError("network");
      }
      return store.read(path);
    });
    const steps = await follower.followSteps(head(12, 10, 11));
    expect(steps.map((step) => step.reloaded)).toEqual([true, false]);
    expect(follower.sequence).toBe(11);
    const later = await follower.followSteps(head(12, 10, 11));
    expect(later.map((step) => step.reloaded)).toEqual([false]);
    expect(follower.sequence).toBe(12);
    expect([...follower.state.keys()].sort()).toEqual([2, 3]);
  });

  it("throws a network failure that read nothing and does not reset the state", async () => {
    const store = chain();
    let fail = false;
    const follower = new ChainFollower(async (path) => {
      if (fail) throw new TypeError("network");
      return store.read(path);
    });
    await follower.follow(head(12, 10, 11));
    store.putDelta(delta(13, [trip(4)]));
    fail = true;
    await expect(follower.followSteps(head(13, 10, 11))).rejects.toBeInstanceOf(TypeError);
    expect(follower.sequence).toBe(12);
    expect(follower.state.size).toBe(2);
    fail = false;
    const steps = await follower.followSteps(head(13, 10, 11));
    expect(steps.map((step) => step.reloaded)).toEqual([false]);
  });

  it("is not corrupted by a failed attempt that already applied a keyframe", async () => {
    const store = new ObjectStore();
    store.putKeyframe(keyframe(10, [trip(1), trip(2)]));
    const follower = new ChainFollower(store.read);
    await expect(follower.follow(head(11, 10, 11))).rejects.toBeInstanceOf(ChainError);
    expect(follower.sequence).toBeNull();
    expect(follower.state.size).toBe(0);
    store.putDelta(delta(11, [trip(3)]));
    const changes = await follower.follow(head(11, 10, 11));
    expect(changes.changed.map((t) => t.key).sort()).toEqual([1, 2, 3]);
  });
});
