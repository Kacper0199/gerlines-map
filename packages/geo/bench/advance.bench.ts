import { cpus } from "node:os";
import { parseArgs } from "node:util";
import { Bench } from "tinybench";
import { CAR_POSE_STRIDE, conventionalConsist, placeCars } from "../src/consist.ts";
import { HEAD_STRIDE, MotionFleet } from "../src/fleet.ts";
import { buildMotionPlan, type MotionPlan, type PlanStop } from "../src/plan.ts";
import { CATEGORY_DYNAMICS, type TrainCategory } from "../src/profile.ts";
import { createShape, type Shape } from "../src/shape.ts";
import { seededRandom } from "../test/ice379.ts";

const { values } = parseArgs({
  options: {
    trips: { type: "string", default: "15000" },
    shapes: { type: "string", default: "800" },
    time: { type: "string", default: "5000" },
  },
});
const TRIPS = Number(values.trips);
const SHAPES = Number(values.shapes);
const BENCH_MS = Number(values.time);
const FRAME = 1 / 60;
const ORIGIN = { x: 1_100_000, y: 6_600_000 };
const CATEGORIES = Object.keys(CATEGORY_DYNAMICS) as TrainCategory[];
const random = seededRandom(20261024);
const between = (min: number, max: number) => min + random() * (max - min);
const out = (line = "") => process.stdout.write(`${line}\n`);

function railLikeShape(): Shape {
  const spacing = 50;
  const count = Math.round(between(20_000, 120_000) / spacing);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  let heading = between(-Math.PI, Math.PI);
  let curvature = 0;
  x[0] = ORIGIN.x + between(-300_000, 300_000);
  y[0] = ORIGIN.y + between(-400_000, 400_000);
  for (let i = 1; i < count; i++) {
    curvature = Math.max(-1 / 400, Math.min(1 / 400, curvature + between(-2e-4, 2e-4)));
    heading += curvature * spacing;
    x[i] = (x[i - 1] as number) + 1.55 * spacing * Math.cos(heading);
    y[i] = (y[i - 1] as number) + 1.55 * spacing * Math.sin(heading);
  }
  return createShape({ x, y });
}

interface TripSpec {
  readonly shape: Shape;
  readonly stops: PlanStop[];
  readonly category: TrainCategory;
}

function tripOn(shape: Shape, now: number): TripSpec {
  const category = CATEGORIES[Math.floor(random() * CATEGORIES.length)] ?? "reg";
  const vmax = CATEGORY_DYNAMICS[category].maxSpeed;
  const legs: { s: number; travel: number; dwell: number }[] = [];
  let s = 0;
  while (s < shape.length) {
    s = Math.min(shape.length, s + between(3000, 25_000));
    legs.push({ s, travel: 0, dwell: between(30, 180) });
  }
  let previous = 0;
  for (const leg of legs) {
    leg.travel = (leg.s - previous) / between(0.35 * vmax, 0.75 * vmax) + 60;
    previous = leg.s;
  }
  const total = legs.reduce((sum, leg) => sum + leg.travel + leg.dwell, 0);
  let t = now - between(-0.05, 0.95) * total;
  const stops: PlanStop[] = [{ s: 0, departure: t }];
  for (const leg of legs) {
    t += leg.travel;
    const arrival = t;
    t += leg.dwell;
    stops.push({ s: leg.s, arrival, departure: t });
  }
  return { shape, stops, category };
}

function planOf(trip: TripSpec, delay = 0, after = Number.NEGATIVE_INFINITY): MotionPlan {
  const shift = (time: number | undefined) =>
    time !== undefined && time > after ? time + delay : time;
  return buildMotionPlan({
    stops: trip.stops.map((stop) => ({
      s: stop.s,
      arrival: shift(stop.arrival),
      departure: shift(stop.departure),
    })),
    dynamics: CATEGORY_DYNAMICS[trip.category],
  });
}

function percentile(sorted: ArrayLike<number>, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

function summary(bench: Bench, name: string): string {
  const task = bench.getTask(name);
  const result = task?.result;
  if (result?.state !== "completed") return `${name}: ${result?.state ?? "missing"}`;
  const { latency } = result;
  const sorted = latency.samples ?? [];
  return `| ${name} | ${latency.samplesCount} | ${latency.p50.toFixed(3)} | ${percentile(sorted, 95).toFixed(3)} | ${latency.p99.toFixed(3)} | ${latency.mean.toFixed(3)} | ${latency.max.toFixed(3)} |`;
}

const setupStarted = performance.now();
const shapes = Array.from({ length: SHAPES }, railLikeShape);
const now0 = 100_000;
const trips = Array.from({ length: TRIPS }, () =>
  tripOn(shapes[Math.floor(random() * shapes.length)] as Shape, now0),
);
const fleet = new MotionFleet();
for (const trip of trips) fleet.add(trip.shape, planOf(trip), now0 - 1);
trips.forEach((trip, slot) => {
  if (random() < 0.2) fleet.update(slot, planOf(trip, between(-300, 300), now0), now0 - 1);
});
const sortedFleet = new MotionFleet();
const byShape = trips
  .map((trip, i) => ({ trip, i }))
  .sort((a, b) => shapes.indexOf(a.trip.shape) - shapes.indexOf(b.trip.shape));
for (const { trip } of byShape) sortedFleet.add(trip.shape, planOf(trip), now0 - 1);
const vertexCount = shapes.reduce((sum, shape) => sum + shape.vertexCount, 0);
const setupSeconds = (performance.now() - setupStarted) / 1000;

const heads = new Float32Array(TRIPS * HEAD_STRIDE);
const sortedHeads = new Float32Array(TRIPS * HEAD_STRIDE);
const consist = conventionalConsist(
  Array.from({ length: 12 }, () => ({ length: 28.8, bogieInset: 4.2 })),
  0,
);
const carPoses = new Float64Array(consist.carCount * CAR_POSE_STRIDE);
const closeSlots = Array.from({ length: 500 }, (_, slot) => slot);
let now = now0;
let sortedNow = now0;
let rebuildIndex = 0;

const bench = new Bench({ time: BENCH_MS, warmupTime: 1000, retainSamples: true });
bench
  .add(`advance and write ${TRIPS} trips on ${SHAPES} shapes, random order`, () => {
    now += FRAME;
    fleet.advance(now);
    fleet.writeHeads(ORIGIN.x, ORIGIN.y, heads);
  })
  .add(`advance and write ${TRIPS} trips on ${SHAPES} shapes, slots sorted by shape`, () => {
    sortedNow += FRAME;
    sortedFleet.advance(sortedNow);
    sortedFleet.writeHeads(ORIGIN.x, ORIGIN.y, sortedHeads);
  })
  .add("place 12 cars for 500 trains", () => {
    for (const slot of closeSlots)
      placeCars(fleet.shapeOf(slot), fleet.s[slot] as number, consist, carPoses);
  })
  .add("rebuild 1000 plans and update", () => {
    for (let k = 0; k < 1000; k++) {
      const slot = rebuildIndex++ % TRIPS;
      fleet.update(slot, planOf(trips[slot] as TripSpec, 60, now), now);
    }
  });

await bench.run();

const moving = Array.from(fleet.v.subarray(0, fleet.count)).filter((v) => v > 0.1).length;
out(`node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ${process.arch}`);
out(
  `setup ${setupSeconds.toFixed(1)} s: ${SHAPES} shapes with ${vertexCount} vertices, ${TRIPS} trips, ${moving} moving at the end, simulated ${(now - now0).toFixed(1)} s`,
);
out();
out("| task | samples | p50 ms | p95 ms | p99 ms | mean ms | max ms |");
out("| --- | --- | --- | --- | --- | --- | --- |");
for (const task of bench.tasks) out(summary(bench, task.name));
