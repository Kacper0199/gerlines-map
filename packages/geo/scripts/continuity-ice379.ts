import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { type ControllerParams, type CrossfadeReason, DEFAULT_CONTROLLER } from "../src/motion.ts";
import {
  DELAY_STEPS_SECONDS,
  type DelayStep,
  loadIce379,
  planFor,
  seededRandom,
} from "../test/ice379.ts";
import {
  baseStops,
  type LegPhase,
  phaseTime,
  runScenario,
  type ScenarioOptions,
  type ScenarioResult,
  type UpdateOutcome,
} from "../test/ice379-scenario.ts";

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "200" },
    steps: { type: "string", default: "6" },
    modes: { type: "string", default: "60fps,variable,10x" },
    controllers: { type: "string", default: "all" },
  },
});
const seedCount = Number(values.seeds);
const stepsPerRun = Number(values.steps);

type FrameMode = Pick<ScenarioOptions, "frameRate" | "jitter" | "timeScale">;

const FRAME_MODES: Record<string, { label: string; options: (seed: number) => FrameMode }> = {
  "60fps": { label: "60 fps", options: () => ({ frameRate: 60 }) },
  variable: {
    label: "variable frame interval 1/120 to 0.25 s (uniform, seeded)",
    options: (seed) => ({ jitter: { min: 1 / 120, max: 0.25, seed: 1000 + seed } }),
  },
  "10x": { label: "10x time scale at 60 fps wall clock", options: () => ({ timeScale: 10 }) },
};
const modes = values.modes.split(",").filter((mode) => mode in FRAME_MODES);

const train = loadIce379();
const out = (line = "") => process.stdout.write(`${line}\n`);
const fixed = (value: number, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : "n/a";

const CONTROLLERS: Record<string, ControllerParams> = {
  default: DEFAULT_CONTROLLER,
  linear: { ...DEFAULT_CONTROLLER, catchUpDeceleration: Number.POSITIVE_INFINITY },
  "ahead floor 0.5": { ...DEFAULT_CONTROLLER, aheadSpeedFraction: 0.5 },
};

function describeFixture(): void {
  out("## Fixture");
  out(
    `route points ${train.shape.vertexCount}, ground length ${fixed(train.shape.length / 1000, 3)} km`,
  );
  out(
    `dynamics hsr capped by vehicle: vmax ${fixed(train.dynamics.maxSpeed * 3.6)} km/h, a ${train.dynamics.acceleration} m/s2, b ${train.dynamics.deceleration} m/s2`,
  );
  out();
  out("| leg | L km | T min | kind | cruise km/h | a m/s2 | b m/s2 |");
  out("| --- | --- | --- | --- | --- | --- | --- |");
  const plan = planFor(train, baseStops(train));
  plan.legs.forEach((leg, k) => {
    const from = train.stops[k]?.name ?? "";
    const to = train.stops[k + 1]?.name ?? "";
    out(
      `| ${from} to ${to} | ${fixed((leg.s1 - leg.s0) / 1000)} | ${fixed((leg.tArr - leg.tDep) / 60)} | ${leg.kind} | ${fixed(leg.cruiseSpeed * 3.6)} | ${fixed(leg.acceleration, 2)} | ${fixed(leg.deceleration, 2)} |`,
    );
  });
  out(`plan adjustments ${plan.adjustments}`);
  out(
    `stop projection distance max ${fixed(Math.max(...train.stops.map((s) => s.projectionDistance)))} m`,
  );
  out();
}

function gridTable(name: string, params: ControllerParams): void {
  out(`## Single steps on Frankfurt to Mannheim, controller ${name}`);
  out(
    "| step min | phase | error at update m | crossfade | convergence s | overshoot m | freeze s | max ratio | min ratio | jumps | stalls |",
  );
  out("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const phases: LegPhase[] = ["accelerating", "cruising", "decelerating", "dwelling"];
  for (const delay of DELAY_STEPS_SECONDS) {
    for (const phase of phases) {
      const time = phaseTime(train, 5, phase);
      const r = runScenario(train, [{ time, delay }], {
        from: time - 120,
        until: time + 1500,
        params,
      });
      const u = r.updates[0] as UpdateOutcome;
      out(
        `| ${delay / 60} | ${phase} | ${fixed(u.error)} | ${u.crossfade ?? "no"} | ${fixed(u.convergenceTime ?? Number.NaN)} | ${fixed(u.overshoot, 2)} | ${fixed(r.freezeSeconds)} | ${fixed(r.continuity.maxRatio, 4)} | ${fixed(r.continuity.minRatio, 4)} | ${r.continuity.jumps} | ${r.continuity.stalls} |`,
      );
    }
  }
  out();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

function randomRuns(name: string, params: ControllerParams, mode: string): void {
  const frameMode = FRAME_MODES[mode] as (typeof FRAME_MODES)[string];
  const first = train.stops[0]?.departure ?? 0;
  const last = train.stops[train.stops.length - 1]?.arrival ?? 0;
  const started = performance.now();
  const results: ScenarioResult[] = [];
  for (let seed = 1; seed <= seedCount; seed++) {
    const random = seededRandom(seed);
    const steps: DelayStep[] = Array.from({ length: stepsPerRun }, () => ({
      time: first + random() * (last - first),
      delay: DELAY_STEPS_SECONDS[Math.floor(random() * DELAY_STEPS_SECONDS.length)] ?? 120,
    }));
    results.push(
      runScenario(train, steps, {
        from: first - 60,
        until: last + 1200,
        params,
        ...frameMode.options(seed),
      }),
    );
  }
  const elapsed = (performance.now() - started) / 1000;
  const updates = results.flatMap((r) => r.updates);
  const blended = updates.filter((u) => u.crossfade === undefined);
  const superseded = blended.filter((u) => u.superseded).length;
  const unconverged = blended.filter(
    (u) => !u.superseded && u.convergenceTime === undefined,
  ).length;
  const convergence = blended
    .flatMap((u) => (u.convergenceTime === undefined ? [] : [u.convergenceTime]))
    .sort((a, b) => a - b);
  const crossfades: Record<CrossfadeReason, number> = {
    start: 0,
    distance: 0,
    shape: 0,
    stop: 0,
    gap: 0,
    invalid: 0,
  };
  for (const r of results)
    for (const key of Object.keys(crossfades) as CrossfadeReason[])
      crossfades[key] += r.crossfades[key];
  const sum = (pick: (r: ScenarioResult) => number) =>
    results.reduce((total, r) => total + pick(r), 0);
  const max = (pick: (r: ScenarioResult) => number) =>
    results.reduce((m, r) => Math.max(m, pick(r)), Number.NEGATIVE_INFINITY);
  const min = (pick: (r: ScenarioResult) => number) =>
    results.reduce((m, r) => Math.min(m, pick(r)), Number.POSITIVE_INFINITY);
  out(`## Random delay steps over the whole trip, controller ${name}, ${frameMode.label}`);
  out(
    `runs ${seedCount} (seeds 1 to ${seedCount}), ${stepsPerRun} steps each from {-15,-5,-2,+2,+5,+15} min at uniform random times, ${fixed(elapsed)} s wall time`,
  );
  out(
    `frames ${sum((r) => r.continuity.frames)}, judged pairs ${sum((r) => r.continuity.judgedPairs)}, hidden frames ${sum((r) => r.continuity.hiddenFrames)}`,
  );
  out(
    `jumps ${sum((r) => r.continuity.jumps)}, stalls ${sum((r) => r.continuity.stalls)}, backward steps ${sum((r) => r.continuity.backwardSteps)}, swaps drawn above opacity 0 ${sum((r) => r.continuity.visibleSwaps)}, overspeed steps ${sum((r) => r.continuity.overspeedSteps)} (max speed ${fixed(
      max((r) => r.continuity.maxSpeed),
      2,
    )} m/s), frames off the track ${sum((r) => r.continuity.offTrackFrames)} (max distance ${max(
      (r) => r.continuity.maxTrackDistance,
    ).toExponential(2)} m)`,
  );
  out(
    `max ratio ${fixed(
      max((r) => r.continuity.maxRatio),
      4,
    )}, min ratio ${fixed(
      min((r) => r.continuity.minRatio),
      4,
    )}, max observed acceleration ${fixed(
      max((r) => r.continuity.maxAcceleration),
      3,
    )} m/s2, max frame step ${fixed(
      max((r) => r.continuity.maxStep),
      3,
    )} m`,
  );
  out(
    `updates ${updates.length}: blended ${blended.length}, crossfaded ${updates.length - blended.length} (distance ${crossfades.distance}, passed stop ${crossfades.stop}, gap ${crossfades.gap}, shape ${crossfades.shape}, invalid ${crossfades.invalid})`,
  );
  out(
    `blended convergence s: p50 ${fixed(percentile(convergence, 50))}, p95 ${fixed(percentile(convergence, 95))}, max ${fixed(percentile(convergence, 100))} (superseded by the next step before converging ${superseded}, not converged ${unconverged})`,
  );
  out(
    `max overshoot after catch-up ${fixed(Math.max(0, ...blended.map((u) => u.overshoot)), 2)} m`,
  );
  out(
    `freeze (display stopped while target moves) total ${fixed(sum((r) => r.freezeSeconds))} s over ${fixed(sum((r) => r.simulatedSeconds) / 3600)} h, longest ${fixed(max((r) => r.longestFreeze))} s`,
  );
  out(
    `head beyond shape max ${max((r) => r.maxHeadBeyondShape)} m, speed rise above ceiling max ${fixed(
      max((r) => r.maxSpeedOverCeiling),
      6,
    )} m/s`,
  );
  out();
}

describeFixture();
for (const [name, params] of Object.entries(CONTROLLERS)) {
  if (values.controllers !== "all" && name !== "default") continue;
  gridTable(name, params);
  for (const mode of name === "default" ? modes : ["60fps"]) randomRuns(name, params, mode);
}
