import { describe, expect, it } from "vitest";
import { groundStepCm, predictedStepCm } from "../src/compact.ts";
import { MERCATOR_LIMIT_CM } from "../src/constants.ts";

/** mulberry32: a small seeded generator, so the inputs are the same on every machine. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const LIMIT = MERCATOR_LIMIT_CM - 1;

function integerIn(random: () => number, from: number, to: number): number {
  return Math.min(to, Math.max(from, from + Math.floor(random() * (to - from + 1))));
}

/** 100,000 vertex pairs: German track steps, steps anywhere, the Mercator edges and corners. */
function inputs(): [number, number, number, number][] {
  const random = generator(20261108);
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < 100_000; i++) {
    const kind = i % 10;
    let x0: number;
    let y0: number;
    let reach: number;
    if (kind < 6) {
      x0 = integerIn(random, 65_000_000, 167_000_000);
      y0 = integerIn(random, 590_000_000, 740_000_000);
      reach = 50_000;
    } else if (kind < 8) {
      x0 = integerIn(random, -LIMIT, LIMIT);
      y0 = integerIn(random, -LIMIT, LIMIT);
      reach = 1_000_000;
    } else {
      const edge = () => (random() < 0.5 ? -1 : 1) * integerIn(random, LIMIT - 2_000_000, LIMIT);
      x0 = kind === 8 ? integerIn(random, -LIMIT, LIMIT) : edge();
      y0 = edge();
      reach = kind === 8 ? 2 * LIMIT : 2_000_000;
    }
    const x1 = Math.min(LIMIT, Math.max(-LIMIT, x0 + integerIn(random, -reach, reach)));
    const y1 = Math.min(LIMIT, Math.max(-LIMIT, y0 + integerIn(random, -reach, reach)));
    out.push([x0, y0, x1, y1]);
  }
  return out;
}

/** German steps whose unrounded value lies within 1e-4 cm of a half centimetre. */
function halfEdges(count: number): [number, number, number, number][] {
  const random = generator(7);
  const out: [number, number, number, number][] = [];
  while (out.length < count) {
    const x0 = integerIn(random, 65_000_000, 167_000_000);
    const y0 = integerIn(random, 590_000_000, 740_000_000);
    const x1 = x0 + integerIn(random, -20_000, 20_000);
    const y1 = y0 + integerIn(random, -20_000, 20_000);
    const raw = groundStepCm(x0, y0, x1, y1);
    if (Math.abs(raw - Math.floor(raw) - 0.5) < 1e-4) out.push([x0, y0, x1, y1]);
  }
  return out;
}

/** FNV-1a over the bytes of each double, so a change of one ulp anywhere changes the digest. */
function digest(values: Iterable<number>): string {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  let hash = 0x811c9dc5;
  for (const value of values) {
    view.setFloat64(0, value, true);
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

describe("the frozen M prediction (FORMAT.md 5.4)", () => {
  it("computes the same bits for 100,000 seeded pairs as when format 1.4 was frozen", () => {
    const pairs = inputs();
    const raw = pairs.map(([x0, y0, x1, y1]) => groundStepCm(x0, y0, x1, y1));
    expect(raw.every(Number.isFinite)).toBe(true);
    expect(digest(raw)).toBe("19221613");
    expect(digest(pairs.map(([x0, y0, x1, y1]) => predictedStepCm(x0, y0, x1, y1)))).toBe(
      "c84777b0",
    );
  });

  it("rounds the same way at half centimetre edges", () => {
    const pairs = halfEdges(2_000);
    expect(digest(pairs.map(([x0, y0, x1, y1]) => groundStepCm(x0, y0, x1, y1)))).toBe("dee00b77");
    expect(digest(pairs.map(([x0, y0, x1, y1]) => predictedStepCm(x0, y0, x1, y1)))).toBe(
      "135e218c",
    );
  });
});
