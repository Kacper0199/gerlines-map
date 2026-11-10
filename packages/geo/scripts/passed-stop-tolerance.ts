import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { DEFAULT_CONTROLLER } from "../src/motion.ts";
import { runStress, type StressResult } from "../test/stress-scenario.ts";

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "200" },
    window: { type: "string", default: "1800" },
    tolerances: { type: "string", default: "1,5,10,25,50,100" },
    jitters: { type: "string", default: "0,5,20" },
  },
});
const seeds = Number(values.seeds);
const windowSeconds = Number(values.window);
const out = (line = "") => process.stdout.write(`${line}\n`);

out(
  `Stress runs (test/stress-scenario.ts): ${seeds} seeds, ${windowSeconds} s each, updates every 20 to 60 s`,
);
out(
  "| stop s jitter m | tolerance m | updates | crossfades stop | crossfades distance | stop crossfades per 1000 updates | max drawn past the stop m | visible s past the stop | freeze s | jumps | stalls | backward | visible swaps |",
);
out("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const jitter of values.jitters.split(",").map(Number)) {
  for (const tolerance of values.tolerances.split(",").map(Number)) {
    const params = { ...DEFAULT_CONTROLLER, passedStopTolerance: tolerance };
    const started = performance.now();
    const results: StressResult[] = [];
    for (let seed = 1; seed <= seeds; seed++) {
      results.push(runStress({ seed, windowSeconds, params, stopJitter: jitter }));
    }
    const sum = (pick: (r: StressResult) => number) => results.reduce((t, r) => t + pick(r), 0);
    const updates = sum((r) => r.updates);
    const stops = sum((r) => r.crossfades.stop);
    out(
      `| ${jitter} | ${tolerance} | ${updates} | ${stops} | ${sum((r) => r.crossfades.distance)} | ${((1000 * stops) / updates).toFixed(1)} | ${Math.max(...results.map((r) => r.maxPastCap)).toFixed(2)} | ${sum((r) => r.pastCapSeconds).toFixed(1)} | ${sum((r) => r.freezeSeconds).toFixed(1)} | ${sum((r) => r.continuity.jumps)} | ${sum((r) => r.continuity.stalls)} | ${sum((r) => r.continuity.backwardSteps)} | ${sum((r) => r.continuity.visibleSwaps)} |`,
    );
    process.stderr.write(
      `jitter ${jitter} tolerance ${tolerance}: ${((performance.now() - started) / 1000).toFixed(1)} s\n`,
    );
  }
}
