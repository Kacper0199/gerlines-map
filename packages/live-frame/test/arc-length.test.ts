import {
  buildMotionPlan,
  CATEGORY_DYNAMICS,
  createShape,
  createShapeSample,
  createTargetState,
  evaluatePlan,
  groundDistance,
  lonLatToMercator,
  sampleShape,
} from "@gerlines/geo";
import { describe, expect, it } from "vitest";
import {
  decodeKeyframe,
  decodeShapePack,
  encodeKeyframe,
  encodeShapePack,
  type ShapeRecord,
  shapePolyline,
  tripStopArcs,
  tripTimes,
} from "../src/index.ts";
import { stop, TIME_BASE, trip } from "./fixtures.ts";

const VERTEX_SPACING_DEGREES = 0.00048;
const VERTICES = 4300;
const STOP_EVERY = 600;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const cm = (metres: number) => Math.round(metres * 100) / 100;

/**
 * 304 km of track east of Hanover with a vertex about every 70 m (WP-2.2 densifies to at most
 * 200 m) and elevation like a z12 DEM: a smooth profile plus up to 3 m of noise per vertex. M is
 * the flat ground length of the vertices, as WP-2.2 stores it.
 */
function noisyShape(): ShapeRecord {
  const next = seeded(20261026);
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < VERTICES; i++) {
    const heading = 0.6 + 0.4 * Math.sin(i / 700);
    const point = lonLatToMercator(
      9.73 + i * VERTEX_SPACING_DEGREES * Math.cos(heading) * 1.6,
      52.37 + i * VERTEX_SPACING_DEGREES * Math.sin(heading),
    );
    x.push(cm(point.x));
    y.push(cm(point.y));
    z.push(Math.fround(cm(60 + 40 * Math.sin(i / 450) + (next() - 0.5) * 6)));
    const step = i === 0 ? 0 : groundDistance(x[i - 1] ?? 0, y[i - 1] ?? 0, x[i] ?? 0, y[i] ?? 0);
    m.push(cm((m[i - 1] ?? 0) + step));
  }
  const stops = m.filter((_, i) => i % STOP_EVERY === 0 || i === VERTICES - 1);
  return {
    hash: "5e".repeat(32),
    number: null,
    x,
    y,
    z,
    m,
    length: m.at(-1) ?? 0,
    stops,
    tunnels: [],
  };
}

const SHAPE = noisyShape();
const STOP_VERTICES = SHAPE.m.flatMap((s, i) => (SHAPE.stops.includes(s) ? [i] : []));

function polyline() {
  const pack = encodeShapePack({
    kind: "shapePack",
    timetableVersion: 7,
    shapeEpoch: 0,
    shapes: [SHAPE],
  });
  return shapePolyline(decodeShapePack(pack), 0);
}

function offTrack(shape: ReturnType<typeof createShape>, s: number, vertex: number): number {
  const sample = createShapeSample();
  sampleShape(shape, s, sample);
  return Math.hypot(sample.x - (SHAPE.x[vertex] ?? 0), sample.y - (SHAPE.y[vertex] ?? 0));
}

describe("arc length from the shape pack", () => {
  it("places every stop arc on its stop vertex when the kernel takes s from the pack", () => {
    const line = polyline();
    const shape = createShape(line);
    expect(shape.hasElevation).toBe(true);
    expect(shape.length).toBe(SHAPE.length);
    STOP_VERTICES.forEach((vertex, j) => {
      expect(offTrack(shape, line.stops[j] ?? -1, vertex)).toBeLessThan(0.01);
    });
  });

  it("drifts by about 200 m when the kernel measures the noisy z itself", () => {
    const { x, y, z, stops } = polyline();
    const shape = createShape(z ? { x, y, z } : { x, y });
    const drift = shape.length - SHAPE.length;
    expect(drift).toBeGreaterThan(150);
    const last = STOP_VERTICES.length - 1;
    expect(offTrack(shape, stops[last] ?? -1, STOP_VERTICES[last] ?? -1)).toBeGreaterThan(150);
  });

  it("gives a motion plan that dwells on each stop vertex", () => {
    const line = polyline();
    const shape = createShape(line);
    const count = SHAPE.stops.length;
    const run = 1200;
    const dwell = 120;
    const frame = encodeKeyframe({
      kind: "keyframe",
      sequence: 1,
      timetableVersion: 7,
      shapeEpoch: 0,
      timeBase: TIME_BASE,
      trips: [
        trip(1, {
          shapeId: SHAPE.hash.slice(0, 16),
          category: "hsr",
          firstStop: 0,
          stops: Array.from({ length: count }, (_, j) =>
            stop(TIME_BASE + j * (run + dwell), TIME_BASE + j * (run + dwell) + dwell),
          ),
        }),
      ],
    });
    const view = decodeKeyframe(frame);
    const arcs = new Float64Array(count);
    const arrival = new Float64Array(count);
    const departure = new Float64Array(count);
    tripStopArcs(view, 0, line.stops, arcs);
    tripTimes(view, 0, arrival, departure);
    const plan = buildMotionPlan({
      stops: Array.from(arcs, (s, j) => ({ s, arrival: arrival[j], departure: departure[j] })),
      dynamics: CATEGORY_DYNAMICS.hsr,
      shapeLength: shape.length,
    });
    expect(plan.adjustments).toBe(0);
    const target = createTargetState();
    STOP_VERTICES.forEach((vertex, j) => {
      evaluatePlan(plan, (arrival[j] ?? 0) + dwell / 2, target);
      expect(target.s).toBe(arcs[j]);
      expect(offTrack(shape, target.s, vertex)).toBeLessThan(0.01);
    });
  });
});
