import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { type LoadedFixture, prepareFixture, type RailFixture } from "./fixture.ts";
import { decodePolyline } from "./polyline.ts";
import { type Allocator, DEFAULT_SCENE_CONFIG, Scene } from "./scene.ts";
import { degreesToMetres } from "./shapes.ts";

const allocator: Allocator = {
  f64: (_name, length) => new Float64Array(length),
  f32: (_name, length) => new Float32Array(length),
  u8: (_name, length) => new Uint8Array(length),
  u32: (_name, length) => new Uint32Array(length),
};

const WORLD: { minLon: number; maxLon: number; minLat: number; maxLat: number } = {
  minLon: -180,
  maxLon: 180,
  minLat: -90,
  maxLat: 90,
};
const EVERYTHING = {
  west: WORLD.minLon,
  east: WORLD.maxLon,
  south: WORLD.minLat,
  north: WORLD.maxLat,
};

let raw: RailFixture;
let fixture: LoadedFixture;

beforeAll(() => {
  const bytes = readFileSync(new URL("../fixtures/rail-segments.json.gz", import.meta.url));
  raw = JSON.parse(gunzipSync(bytes).toString()) as RailFixture;
  fixture = prepareFixture(raw);
});

function makeScene(trainCount: number): Scene {
  return new Scene(fixture.store, fixture.durations, fixture.categories, fixture.categoryRgba, {
    ...DEFAULT_SCENE_CONFIG,
    trainCount,
  });
}

function distanceToPolylineMetres(lon: number, lat: number, polyline: Float64Array): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 3 < polyline.length; i += 2) {
    const [ax, ay] = degreesToMetres((polyline[i] ?? 0) - lon, (polyline[i + 1] ?? 0) - lat, lat);
    const [bx, by] = degreesToMetres(
      (polyline[i + 2] ?? 0) - lon,
      (polyline[i + 3] ?? 0) - lat,
      lat,
    );
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

function stepMetres(
  scene: Scene,
  previousX: Float64Array,
  previousY: Float64Array,
  i: number,
): number {
  const [dx, dy] = degreesToMetres(
    (scene.px[i] ?? 0) - (previousX[i] ?? 0),
    (scene.py[i] ?? 0) - (previousY[i] ?? 0),
    scene.py[i] ?? 0,
  );
  return Math.hypot(dx, dy);
}

function measureSteps(scene: Scene, trains: number, frames: number) {
  scene.advance(1000, 1 / 60);
  const previousX = Float64Array.from(scene.px);
  const previousY = Float64Array.from(scene.py);
  let worstStep = 0;
  let worstLegHandOver = 0;
  for (let frame = 1; frame < frames; frame++) {
    scene.advance(1000 + frame / 60, 1 / 60);
    for (let i = 0; i < trains; i++) {
      const moved = stepMetres(scene, previousX, previousY, i);
      if (moved < 20) worstStep = Math.max(worstStep, moved);
      else worstLegHandOver = Math.max(worstLegHandOver, moved);
      previousX[i] = scene.px[i] ?? 0;
      previousY[i] = scene.py[i] ?? 0;
    }
  }
  return { worstStep, worstLegHandOver };
}

describe("Scene", () => {
  it("keeps every train on its own segment polyline", () => {
    const trains = 60;
    const scene = makeScene(trains);
    const polylines = raw.segments.slice(0, trains).map((segment) => decodePolyline(segment.p));
    let worst = 0;
    for (let frame = 0; frame < 1200; frame++) {
      scene.advance(1000 + frame / 60, 1 / 60);
      if (frame % 100 !== 0) continue;
      for (let i = 0; i < trains; i++) {
        const polyline = polylines[i] as Float64Array;
        worst = Math.max(
          worst,
          distanceToPolylineMetres(scene.px[i] ?? 0, scene.py[i] ?? 0, polyline),
        );
      }
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("never moves faster than the catch-up clamp allows", () => {
    const { worstStep, worstLegHandOver } = measureSteps(makeScene(200), 200, 3000);
    expect(worstStep).toBeLessThan(1.5);
    expect(worstLegHandOver).toBeLessThan(60);
  });

  it("emits consistent buffers for every tier", () => {
    const scene = makeScene(400);
    scene.advance(1000, 1 / 60);
    scene.select(EVERYTHING, 0);
    expect(scene.visibleCount).toBe(400);

    const dots = scene.emitDots(allocator);
    expect(dots.count).toBe(400);
    expect(dots.arrays.position?.length).toBe(1200);

    const icons = scene.emitIcons(allocator);
    expect(icons.arrays.angle?.length).toBe(400);

    const slices = scene.emitSlices(allocator, 262);
    const startIndices = slices.arrays.startIndices as Uint32Array;
    expect(startIndices[400]).toBe(slices.vertexCount);
    expect(slices.arrays.position?.length).toBe((slices.vertexCount ?? 0) * 3);
    for (let k = 0; k < 400; k++)
      expect((startIndices[k + 1] ?? 0) - (startIndices[k] ?? 0)).toBeGreaterThanOrEqual(2);

    const cars = scene.emitCars(allocator);
    expect(cars.count).toBe(4000);
    expect(cars.arrays.matrix?.length).toBe(48000);
  });

  it("culls to the requested bounds", () => {
    const scene = makeScene(2000);
    scene.advance(1000, 1 / 60);
    const everything = scene.select(EVERYTHING, 0);
    const berlin = scene.select({ west: 13.2, south: 52.4, east: 13.6, north: 52.6 }, 0);
    expect(berlin).toBeGreaterThan(0);
    expect(berlin).toBeLessThan(everything);
  });
});
