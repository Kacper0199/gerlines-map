import { describe, expect, it } from "vitest";
import { capacityFor, SLACK_FLOOR, SlotLayout } from "./slot-layout.ts";

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function starts(layout: SlotLayout, counts: Record<string, number>) {
  const placed = layout.place(Object.entries(counts).map(([id, count]) => ({ id, count })));
  return {
    starts: Object.fromEntries(placed.starts.map((s, i) => [Object.keys(counts)[i], s])),
    total: placed.total,
  };
}

/** The counts of the next frame: each mesh's level wanders a little, and a mesh at zero is absent. */
function drift(
  ids: string[],
  level: Map<string, number>,
  random: () => number,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of ids) {
    const next = Math.max(
      0,
      Math.min(150, (level.get(id) as number) + Math.floor(random() * 5) - 2),
    );
    level.set(id, next);
    if (next > 0) counts[id] = next;
  }
  return counts;
}

/** The first pair of meshes that share an instance, or one that reaches past the arrays; undefined when there is none. */
function overlap(
  counts: Record<string, number>,
  at: Record<string, number>,
  total: number,
): string | undefined {
  const taken = Object.entries(counts)
    .map(([id, count]) => ({ id, start: at[id] as number, count }))
    .sort((x, y) => x.start - y.start);
  let end = 0;
  for (const slot of taken) {
    if (slot.start < end || slot.start + slot.count > total) return slot.id;
    end = slot.start + slot.count;
  }
  return undefined;
}

/** What the frame would take with every mesh given its room and nothing in between. */
function packedSize(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + capacityFor(count), 0);
}

describe("SlotLayout (slices that stay where they are)", () => {
  it("keeps every slot where it is while the counts stay within their room", () => {
    const layout = new SlotLayout();
    const first = starts(layout, { a: 10, b: 20, c: 5 });
    for (const counts of [
      { a: 11, b: 20, c: 5 },
      { a: 9, b: 18, c: 6 },
      { a: 12, b: 22, c: 7 },
    ]) {
      expect(starts(layout, counts).starts).toEqual(first.starts);
    }
  });

  it("puts a mesh that appears after the others and moves nothing", () => {
    const layout = new SlotLayout();
    const first = starts(layout, { a: 10, b: 20 });
    const next = starts(layout, { a: 10, b: 20, c: 4 });
    expect(next.starts.a).toBe(first.starts.a);
    expect(next.starts.b).toBe(first.starts.b);
    expect(next.starts.c).toBeGreaterThanOrEqual(first.total);
  });

  it("moves only the mesh that outgrew its room", () => {
    const layout = new SlotLayout();
    const first = starts(layout, { a: 10, b: 20, c: 5 });
    const next = starts(layout, { a: 10, b: 200, c: 5 });
    expect(next.starts.a).toBe(first.starts.a);
    expect(next.starts.c).toBe(first.starts.c);
    expect(next.starts.b).not.toBe(first.starts.b);
  });

  it("gives a mesh that was absent for a while its old slot back", () => {
    const layout = new SlotLayout();
    const first = starts(layout, { a: 10, b: 20 });
    starts(layout, { a: 10 });
    expect(starts(layout, { a: 10, b: 20 }).starts).toEqual(first.starts);
  });

  it("never lets two meshes share an instance", () => {
    const layout = new SlotLayout();
    const random = lcg(162);
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for (let frame = 0; frame < 300; frame++) {
      const top = frame % 50 < 25 ? 30 : 90;
      const counts: Record<string, number> = {};
      for (const id of ids) if (random() < 0.7) counts[id] = 1 + Math.floor(random() * top);
      const { starts: at, total } = starts(layout, counts);
      expect(overlap(counts, at, total), `frame ${frame}`).toBeUndefined();
    }
  });

  it("keeps the arrays within a small multiple of the instances in use, and rarely moves a slot when counts drift", () => {
    const layout = new SlotLayout();
    const random = lcg(5);
    const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const level = new Map(ids.map((id) => [id, Math.floor(random() * 120)]));
    let moves = 0;
    let previous: Record<string, number> = {};
    for (let frame = 0; frame < 3000; frame++) {
      const counts = drift(ids, level, random);
      const { starts: at, total } = starts(layout, counts);
      expect(total).toBeLessThanOrEqual(2 * packedSize(counts) + SLACK_FLOOR);
      moves += Object.keys(counts).filter(
        (id) => previous[id] !== undefined && previous[id] !== at[id],
      ).length;
      previous = { ...previous, ...at };
    }
    expect(moves).toBeLessThan(150);
  });

  it("sends no room at all for a frame without cars, and starts over after it", () => {
    const layout = new SlotLayout();
    starts(layout, { a: 10, b: 20 });
    expect(layout.place([]).total).toBe(0);
    expect(starts(layout, { b: 20 }).starts.b).toBe(0);
  });

  it("starts the first frame at zero and reports an empty frame as empty", () => {
    const layout = new SlotLayout();
    expect(starts(layout, { a: 3 }).starts.a).toBe(0);
    expect(new SlotLayout().place([]).total).toBe(0);
  });

  it("does not pack again in a hub scene of 60 to 120 meshes with one to three instances each", () => {
    for (const size of [60, 90, 120]) {
      const layout = new SlotLayout();
      const random = lcg(size);
      const ids = Array.from({ length: size }, (_, i) => `hub${i}`);
      const level = new Map(ids.map((id) => [id, 1 + Math.floor(random() * 3)]));
      let first: Record<string, number> = {};
      for (let frame = 0; frame < 600; frame++) {
        const counts: Record<string, number> = {};
        for (const id of ids) {
          const next = Math.max(
            1,
            Math.min(3, (level.get(id) as number) + Math.floor(random() * 3) - 1),
          );
          level.set(id, next);
          counts[id] = next;
        }
        const { starts: at, total } = starts(layout, counts);
        if (frame === 0) first = at;
        expect(at, `${size} ids, frame ${frame}`).toEqual(first);
        expect(total).toBeLessThanOrEqual(2 * packedSize(counts) + SLACK_FLOOR);
      }
    }
  });

  it("keeps the arrays near the instances in use when a hub scene changes its meshes", () => {
    const layout = new SlotLayout();
    const random = lcg(77);
    const pool = Array.from({ length: 200 }, (_, i) => `m${i}`);
    let ratio = 0;
    for (let frame = 0; frame < 800; frame++) {
      const counts: Record<string, number> = {};
      const from = Math.floor(frame / 40) * 7;
      for (let k = 0; k < 90; k++)
        counts[pool[(from + k) % pool.length] as string] = 1 + Math.floor(random() * 3);
      const { total } = starts(layout, counts);
      const live = Object.values(counts).reduce((sum, count) => sum + count, 0);
      expect(total).toBeLessThanOrEqual(2 * packedSize(counts) + SLACK_FLOOR);
      ratio = Math.max(ratio, total / live);
    }
    expect(ratio).toBeLessThan(8);
  });

  it("moves a mesh that ramps from 5 to 300 instances only a few times", () => {
    const layout = new SlotLayout();
    let moves = 0;
    let previous: number | undefined;
    for (let count = 5; count <= 300; count++) {
      const at = starts(layout, { other: 10, ramp: count, last: 4 }).starts.ramp as number;
      if (previous !== undefined && previous !== at) moves++;
      previous = at;
    }
    expect(moves).toBeLessThanOrEqual(6);
  });
});
