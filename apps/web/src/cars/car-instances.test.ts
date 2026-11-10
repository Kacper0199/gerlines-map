import {
  CAR_POSE_STRIDE,
  createShape,
  lonLatToMercator,
  placeCars,
  type Shape,
} from "@gerlines/geo";
import { describe, expect, it } from "vitest";
import {
  CAR_BLEND_S,
  CarBlend,
  type CarTrain,
  type CarView,
  carFade,
  carWidthPx,
  chooseCarTrains,
  LAMP_HEAD,
  LAMP_NONE,
  LAMP_TAIL,
  lampStates,
  lodFor,
  type MeshInstances,
  markerFade,
  writeCars,
} from "./car-instances.ts";
import { type CarModel, parseCatalog } from "./catalog.ts";
import { testManifest } from "./test-catalog.ts";

const LAT = 50.11;
const ORIGIN = lonLatToMercator(8.68, LAT);
/** Web Mercator metres per ground metre at the test latitude. */
const K = 1 / Math.cos((LAT * Math.PI) / 180);
const catalog = parseCatalog(testManifest());
const REG = catalog.models.get("generic-reg-emu") as CarModel;
const SBAHN = catalog.models.get("generic-sbahn") as CarModel;

function eastShape(length: number): Shape {
  return createShape({
    x: [ORIGIN.x, ORIGIN.x + K * length],
    y: [ORIGIN.y, ORIGIN.y],
    s: [0, length],
  });
}

/** A left-hand arc of `radius` ground metres, polyline vertices every `spacing` metres. */
function arcShape(radius: number, spacing: number): Shape {
  const count = Math.ceil((1.5 * Math.PI * radius) / spacing) + 1;
  const x: number[] = [];
  const y: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i * spacing) / radius;
    x.push(ORIGIN.x + K * radius * Math.sin(angle));
    y.push(ORIGIN.y + K * radius * (1 - Math.cos(angle)));
    const step = i === 0 ? 0 : 2 * radius * Math.sin(spacing / (2 * radius));
    s.push(i === 0 ? 0 : (s[i - 1] as number) + step);
  }
  return createShape({ x, y, s });
}

function train(model: CarModel, shape: Shape, headS: number, key = 1): CarTrain {
  return { key, model, shape, headS, x: ORIGIN.x, y: ORIGIN.y, alpha: 1, color: [10, 20, 30] };
}

const VIEW: CarView = {
  zoom: 17,
  centerX: ORIGIN.x,
  centerY: ORIGIN.y,
  radiusM: 2_000,
  fineRadiusM: 2_000,
};

/** Yaw in degrees of instance `i`, read back from its model matrix. */
function yawOf(instances: MeshInstances, i: number): number {
  return (
    (Math.atan2(instances.matrices[12 * i + 1] as number, instances.matrices[12 * i] as number) *
      180) /
    Math.PI
  );
}

function meshOf(frame: { meshes: readonly MeshInstances[] }, mesh: string): MeshInstances {
  const found = frame.meshes.find((entry) => entry.mesh === mesh);
  if (!found) throw new Error(`no ${mesh}`);
  return found;
}

/** Ground metres between an instance position and the arc's centre line. */
function offArc(instances: MeshInstances, index: number, radius: number): number {
  const p = lonLatToMercator(
    instances.positions[3 * index] as number,
    instances.positions[3 * index + 1] as number,
  );
  const dx = (p.x - ORIGIN.x) / K;
  const dy = (p.y - ORIGIN.y) / K - radius;
  return Math.abs(Math.hypot(dx, dy) - radius);
}

describe("car placement on the shape", () => {
  it("puts every bogie at its arc length behind the front and every body between its bogies", () => {
    const frame = writeCars([train(REG, eastShape(500), 100)], VIEW);
    const bogies = meshOf(frame, "generic-reg-emu/bogie-a");
    const cars = meshOf(frame, "generic-reg-emu/end");
    expect(bogies.count).toBe(4);
    expect(cars.count).toBe(2);
    const xAt = (i: number, list: MeshInstances) =>
      (lonLatToMercator(list.positions[3 * i] as number, LAT).x - ORIGIN.x) / K;
    [97, 83, 76.5, 62.5].forEach((s, i) => {
      expect(xAt(i, bogies)).toBeCloseTo(s, 6);
    });
    expect(xAt(0, cars)).toBeCloseTo(90, 6);
    expect(xAt(1, cars)).toBeCloseTo(69.5, 6);
    expect(yawOf(cars, 0)).toBeCloseTo(0, 9);
    expect(Math.abs(yawOf(cars, 1))).toBeCloseTo(180, 9);
  });

  it("shares a Jacobs bogie between two bodies and keeps the unit length", () => {
    const frame = writeCars([train(SBAHN, eastShape(500), 100)], VIEW);
    expect(meshOf(frame, "generic-sbahn/bogie-a").count).toBe(2);
    expect(meshOf(frame, "generic-sbahn/bogie-j").count).toBe(1);
    expect(SBAHN.consist.length).toBe(30);
    const cars = meshOf(frame, "generic-sbahn/end");
    const x0 = (lonLatToMercator(cars.positions[0] as number, LAT).x - ORIGIN.x) / K;
    expect(x0).toBeCloseTo(100 - 7.5, 6);
  });

  it("bends the train through a 150 m curve: bogies on the track, bodies within the chord error", () => {
    const radius = 150;
    const spacing = 2;
    const frame = writeCars([train(REG, arcShape(radius, spacing), 200)], VIEW);
    const bogies = meshOf(frame, "generic-reg-emu/bogie-a");
    const polylineError = (spacing * spacing) / (8 * radius);
    for (let i = 0; i < bogies.count; i++) {
      expect(offArc(bogies, i, radius)).toBeLessThanOrEqual(polylineError + 1e-6);
    }
    const cars = meshOf(frame, "generic-reg-emu/end");
    const span = 14;
    const sagitta = (span * span) / (8 * radius);
    for (let i = 0; i < cars.count; i++) {
      const error = offArc(cars, i, radius);
      expect(error).toBeLessThanOrEqual(sagitta + polylineError + 1e-6);
      expect(error).toBeGreaterThan(sagitta / 2);
    }
    const heading0 = yawOf(cars, 0);
    const heading1 = yawOf(cars, 1) + 180;
    expect(heading0).toBeGreaterThan(heading1);
    expect(heading0 - heading1).toBeCloseTo((20.5 / radius) * (180 / Math.PI), 1);
  });

  it("agrees with @gerlines/geo placeCars for centres and headings", () => {
    const shape = arcShape(300, 5);
    const frame = writeCars([train(SBAHN, shape, 400)], VIEW);
    const poses = new Float64Array(SBAHN.consist.carCount * CAR_POSE_STRIDE);
    placeCars(shape, 400, SBAHN.consist, poses);
    const cars = meshOf(frame, "generic-sbahn/end");
    for (let c = 0; c < SBAHN.consist.carCount; c++) {
      const p = lonLatToMercator(
        cars.positions[3 * c] as number,
        cars.positions[3 * c + 1] as number,
      );
      expect(p.x).toBeCloseTo(poses[c * CAR_POSE_STRIDE] as number, 4);
      expect(p.y).toBeCloseTo(poses[c * CAR_POSE_STRIDE + 1] as number, 4);
      const yaw = ((poses[c * CAR_POSE_STRIDE + 3] as number) * 180) / Math.PI;
      const reversed = SBAHN.cars[c]?.reversed ? 180 : 0;
      const delta = ((((yawOf(cars, c) - yaw - reversed) % 360) + 540) % 360) - 180;
      expect(delta).toBeCloseTo(0, 3);
    }
  });
});

describe("lamps by direction (D-053)", () => {
  it("lights white at the leading end and red at the trailing end", () => {
    expect(lampStates(REG, 0)).toEqual([LAMP_HEAD, LAMP_NONE]);
    expect(lampStates(REG, 1)).toEqual([LAMP_TAIL, LAMP_NONE]);
    const single: CarModel = { ...REG, cars: [{ carType: "end", reversed: false }] };
    expect(lampStates(single, 0)).toEqual([LAMP_HEAD, LAMP_TAIL]);
  });
});

describe("tiers and culling", () => {
  it("sizes the car tier by the on-screen width of a car, not by a fixed zoom", () => {
    expect(carWidthPx(16, 50)).toBeCloseTo(3.78, 1);
    expect(carWidthPx(17, 50)).toBeCloseTo(2 * carWidthPx(16, 50), 9);
    expect(carWidthPx(16, 60)).toBeGreaterThan(carWidthPx(16, 40));
    expect(carFade(14.5, 50)).toBe(0);
    expect(carFade(15.7, 50)).toBe(0);
    expect(carFade(16, 50)).toBeGreaterThan(0);
    expect(carFade(16, 50)).toBeLessThan(0.3);
    expect(carFade(16.6, 50)).toBe(1);
    expect(carFade(16, 60)).toBeGreaterThan(carFade(16, 40));
    const fades = [15.8, 16, 16.2, 16.4, 16.6].map((zoom) => carFade(zoom, 50));
    expect(fades).toEqual([...fades].sort((a, b) => a - b));
    expect(writeCars([train(REG, eastShape(500), 100)], { ...VIEW, zoom: 14 }).meshes).toEqual([]);
  });

  it("keeps the selected marker until its cars are wide enough to see", () => {
    expect(markerFade(16, 50)).toBe(0);
    expect(markerFade(16.5, 50)).toBeLessThan(0.1);
    expect(markerFade(17, 50)).toBeGreaterThan(0.8);
    expect(markerFade(17.2, 50)).toBe(1);
    expect(markerFade(16.4, 50)).toBeLessThan(carFade(16.4, 50));
  });

  it("steps the level of detail by zoom and one coarser beyond the fine radius", () => {
    expect(lodFor(14.6, 0, 100)).toBe(2);
    expect(lodFor(15.5, 0, 100)).toBe(1);
    expect(lodFor(17, 0, 100)).toBe(0);
    expect(lodFor(17, 200, 100)).toBe(1);
    expect(lodFor(15, 200, 100)).toBe(2);
  });

  it("keeps the nearest trains within the radius, at most the cap", () => {
    const shape = eastShape(500);
    const at = (key: number, east: number): CarTrain => ({
      ...train(REG, shape, 100, key),
      x: ORIGIN.x + K * east,
    });
    const trains = [at(1, 900), at(2, 100), at(3, 5_000), at(4, 300)];
    const chosen = chooseCarTrains(trains, { ...VIEW, radiusM: 1_000 }, 2);
    expect(chosen.map((entry) => entry.train.key)).toEqual([2, 4]);
    expect(chooseCarTrains(trains, { ...VIEW, radiusM: 1_000 }).map((e) => e.train.key)).toEqual([
      2, 4, 1,
    ]);
  });
});

describe("chevron hand-over", () => {
  it("counts a train as drawn only when every mesh it needs at its level is loaded", () => {
    const shape = eastShape(500);
    const ready = new Set(["generic-reg-emu/end@0", "generic-reg-emu/bogie-a@0"]);
    const frame = writeCars([train(REG, shape, 100, 1), train(SBAHN, shape, 200, 2)], {
      ...VIEW,
      ready,
    });
    expect([...frame.trainKeys].sort()).toEqual([1, 2]);
    expect([...frame.drawnKeys]).toEqual([1]);
    expect([...writeCars([train(REG, shape, 100, 1)], VIEW).drawnKeys]).toEqual([]);
  });
});

describe("pattern ends (D-055)", () => {
  const all = new Set(
    ["end", "bogie-a"].flatMap((part) => [0, 1, 2].map((lod) => `generic-reg-emu/${part}@${lod}`)),
  );
  const count = (frame: { meshes: readonly MeshInstances[] }, mesh: string): number =>
    frame.meshes.find((entry) => entry.mesh === mesh)?.count ?? 0;

  it("places a train only when its whole consist lies on the shape, else it stays a chevron", () => {
    const shape = eastShape(500);
    for (const headS of [0, 30, 37.4]) {
      const frame = writeCars([train(REG, shape, headS)], { ...VIEW, ready: all });
      expect(frame.meshes).toEqual([]);
      expect([...frame.trainKeys]).toEqual([]);
      expect([...frame.drawnKeys]).toEqual([]);
    }
    const clear = writeCars([train(REG, shape, 37.5)], { ...VIEW, ready: all });
    expect(count(clear, "generic-reg-emu/end")).toBe(2);
    expect(count(clear, "generic-reg-emu/bogie-a")).toBe(4);
    expect([...clear.trainKeys]).toEqual([1]);
    expect([...clear.drawnKeys]).toEqual([1]);
  });

  it("draws no train that overshoots the end of the shape", () => {
    const shape = eastShape(500);
    const arrived = writeCars([train(REG, shape, 500)], { ...VIEW, ready: all });
    expect(count(arrived, "generic-reg-emu/end")).toBe(2);
    expect([...arrived.drawnKeys]).toEqual([1]);
    const overshoot = writeCars([train(REG, shape, 504)], { ...VIEW, ready: all });
    expect(overshoot.meshes).toEqual([]);
  });

  it("draws nothing on a shape shorter than the consist", () => {
    const short = writeCars([train(REG, eastShape(20), 20)], { ...VIEW, ready: all });
    expect(short.meshes).toEqual([]);
    expect([...short.trainKeys]).toEqual([]);
  });

  it("keeps a whole articulated train with its shared Jacobs bogie", () => {
    const frame = writeCars([train(SBAHN, eastShape(500), 40)], VIEW);
    expect(count(frame, "generic-sbahn/end")).toBe(2);
    expect(count(frame, "generic-sbahn/bogie-j")).toBe(1);
    expect(count(frame, "generic-sbahn/bogie-a")).toBe(2);
    expect(writeCars([train(SBAHN, eastShape(500), 20)], VIEW).meshes).toEqual([]);
  });
});

describe("chevron to cars blend (D-055)", () => {
  const all = new Set(
    ["end", "bogie-a"].flatMap((part) => [0, 1, 2].map((lod) => `generic-reg-emu/${part}@${lod}`)),
  );
  const alphaOf = (frame: { meshes: readonly MeshInstances[] }): number =>
    meshOf(frame, "generic-reg-emu/end").colors[3] as number;

  it("fades a train in over the blend time instead of switching in one frame", () => {
    const blend = new CarBlend();
    const shape = eastShape(500);
    const view = { ...VIEW, ready: all };
    blend.begin(0);
    writeCars([], view, undefined, blend);
    const frames = [0.1, 0.2, 0.3, 0.4].map((now) => {
      blend.begin(now);
      return writeCars([train(REG, shape, 100)], view, undefined, blend);
    });
    expect(frames.map((frame) => Math.round(100 * (frame.blends[0] as number)))).toEqual([
      33, 67, 100, 100,
    ]);
    expect(frames.map(alphaOf)).toEqual([85, 170, 255, 255]);
    expect(CAR_BLEND_S).toBe(0.3);
  });

  it("keeps a train whose meshes are still loading invisible and starts at 0 once they arrive", () => {
    const blend = new CarBlend();
    const shape = eastShape(500);
    blend.begin(5);
    const loading = writeCars([train(REG, shape, 100)], VIEW, undefined, blend);
    expect([...loading.drawnKeys]).toEqual([]);
    expect(alphaOf(loading)).toBe(0);
    blend.begin(5.1);
    const arrived = writeCars([train(REG, shape, 100)], { ...VIEW, ready: all }, undefined, blend);
    expect(arrived.blends[0]).toBeCloseTo(1 / 3, 5);
  });

  it("keeps a train with only some of its meshes loaded invisible next to its chevron", () => {
    const blend = new CarBlend();
    const shape = eastShape(500);
    const partly = new Set([
      "generic-reg-emu/end@0",
      "generic-reg-emu/end@1",
      "generic-reg-emu/end@2",
    ]);
    blend.begin(5);
    const loading = writeCars(
      [train(REG, shape, 100)],
      { ...VIEW, ready: partly },
      undefined,
      blend,
    );
    expect([...loading.drawnKeys]).toEqual([]);
    expect([...loading.trainKeys]).toEqual([1]);
    expect(meshOf(loading, "generic-reg-emu/end").count).toBeGreaterThan(0);
    expect(alphaOf(loading)).toBe(0);
    expect(meshOf(loading, "generic-reg-emu/bogie-a").colors[3]).toBe(0);
    blend.begin(5.1);
    const rest = writeCars([train(REG, shape, 100)], { ...VIEW, ready: all }, undefined, blend);
    expect(rest.blends[0]).toBeCloseTo(1 / 3, 5);
  });

  it("forgets trains that left the view", () => {
    const blend = new CarBlend();
    const shape = eastShape(500);
    const view = { ...VIEW, ready: all };
    blend.begin(0);
    writeCars([train(REG, shape, 100)], view, undefined, blend);
    blend.begin(1);
    writeCars([], view, undefined, blend);
    blend.begin(1.1);
    const back = writeCars([train(REG, shape, 100)], view, undefined, blend);
    expect(back.blends[0]).toBeCloseTo(1 / 3, 5);
  });
});

describe("level of detail by the nearest pivot", () => {
  const all = new Set(
    ["end", "bogie-a"].flatMap((part) => [0, 1, 2].map((lod) => `generic-reg-emu/${part}@${lod}`)),
  );

  it("gives a long train the fine level when any part of it is within the fine radius", () => {
    const shape = eastShape(500);
    const head = { ...train(REG, shape, 60), x: ORIGIN.x + K * 60 };
    const view = { ...VIEW, fineRadiusM: 30, ready: all };
    const frame = writeCars([head], view);
    expect(frame.meshes.every((entry) => entry.lod === 0)).toBe(true);
    const far = writeCars([{ ...head, headS: 200, x: ORIGIN.x + K * 200 }], view);
    expect(far.meshes.every((entry) => entry.lod === 1)).toBe(true);
  });
});

describe("keeping the previous level of detail while a new one loads", () => {
  const only = (lod: number) =>
    new Set(["end", "bogie-a"].map((part) => `generic-reg-emu/${part}@${lod}`));

  it("draws a neighbouring loaded level and asks for the wanted one", () => {
    const frame = writeCars([train(REG, eastShape(500), 100)], { ...VIEW, ready: only(1) });
    expect([...frame.drawnKeys]).toEqual([1]);
    expect(frame.meshes.every((entry) => entry.lod === 1)).toBe(true);
    expect([...frame.wanted].sort()).toEqual([
      "generic-reg-emu/bogie-a@0",
      "generic-reg-emu/end@0",
    ]);
  });

  it("asks for nothing when the wanted level is loaded", () => {
    const frame = writeCars([train(REG, eastShape(500), 100)], { ...VIEW, ready: only(0) });
    expect(frame.wanted).toEqual([]);
    expect(frame.meshes.every((entry) => entry.lod === 0)).toBe(true);
  });

  it("places and wants the wanted level when no level is loaded", () => {
    const frame = writeCars([train(REG, eastShape(500), 100)], VIEW);
    expect([...frame.drawnKeys]).toEqual([]);
    expect(frame.meshes.every((entry) => entry.lod === 0)).toBe(true);
    expect([...frame.wanted].sort()).toEqual([
      "generic-reg-emu/bogie-a@0",
      "generic-reg-emu/end@0",
    ]);
  });
});

describe("selected train flag", () => {
  it("marks only the selected train's instances", () => {
    const shape = eastShape(500);
    const frame = writeCars(
      [
        { ...train(REG, shape, 100, 1), selected: true },
        { ...train(REG, shape, 300, 2), x: ORIGIN.x + K * 300 },
      ],
      VIEW,
    );
    const cars = meshOf(frame, "generic-reg-emu/end");
    expect([...cars.selected].sort()).toEqual([0, 0, 1, 1]);
    expect(cars.trainKeys.filter((_, i) => cars.selected[i] === 1).every((key) => key === 1)).toBe(
      true,
    );
  });
});

describe("stable instance order (T-5.2-a)", () => {
  it("writes the trains in key order whichever is nearer, so the unmoving attributes stay equal", () => {
    const shape = eastShape(800);
    const a = { ...train(REG, shape, 100, 1), x: ORIGIN.x + K * 100, color: [1, 2, 3] as const };
    const b = { ...train(REG, shape, 300, 2), x: ORIGIN.x + K * 300, color: [4, 5, 6] as const };
    const first = writeCars([a, b], { ...VIEW, centerX: ORIGIN.x + K * 90 });
    const second = writeCars([a, b], { ...VIEW, centerX: ORIGIN.x + K * 310 });
    expect([...first.trainKeys]).toEqual([1, 2]);
    expect([...second.trainKeys]).toEqual([1, 2]);
    const colors = (frame: ReturnType<typeof writeCars>) =>
      meshOf(frame, "generic-reg-emu/end").colors;
    expect([...colors(first)]).toEqual([...colors(second)]);
  });
});

describe("culling to the visible ground (T-5.2-a)", () => {
  const shape = eastShape(40_000);
  const at = (key: number, metres: number): CarTrain => ({
    ...train(REG, shape, metres, key),
    x: ORIGIN.x + K * metres,
  });
  const box = {
    minX: ORIGIN.x - K * 300,
    maxX: ORIGIN.x + K * 300,
    minY: ORIGIN.y - 400,
    maxY: ORIGIN.y + 400,
  };
  const wide = { ...VIEW, radiusM: 100_000 };

  it("places no train that cannot reach the box and every train that can", () => {
    const trains = [at(1, 0), at(2, 250), at(3, 3000), at(4, 30_000)];
    const kept = chooseCarTrains(trains, { ...wide, visible: box }).map((c) => c.train.key);
    expect(kept.sort()).toEqual([1, 2]);
    expect(
      chooseCarTrains(trains, wide)
        .map((c) => c.train.key)
        .sort(),
    ).toEqual([1, 2, 3, 4]);
  });

  it("keeps a train whose head is just outside but whose tail is inside", () => {
    const head = at(5, 300 + REG.consist.length / 2);
    expect(chooseCarTrains([head], { ...wide, visible: box })).toHaveLength(1);
  });

  it("culls before the cap, so the cap is spent on trains that can be seen", () => {
    const near = [at(1, 100), at(2, 150)];
    const far = Array.from({ length: 6 }, (_, i) => at(10 + i, 5_000 + 10 * i));
    const frame = writeCars([...far, ...near], { ...wide, visible: box }, 3);
    expect([...frame.trainKeys].sort()).toEqual([1, 2]);
  });
});
