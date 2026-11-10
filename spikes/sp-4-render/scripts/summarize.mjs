import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mapDrawsPerSecondOf } from "../src/draws.ts";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDirectory = resolve(here, "../results");
const tags = process.argv.slice(2);
if (tags.length === 0) {
  process.stderr.write("usage: node scripts/summarize.mjs <tag> [<tag> ...]\n");
  process.exit(1);
}

const results = readdirSync(resultsDirectory)
  .filter((name) => name.endsWith(".ndjson") && tags.some((tag) => name.startsWith(`${tag}.`)))
  .map((name) => JSON.parse(readFileSync(resolve(resultsDirectory, name), "utf8")))
  .sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      a.env.localeCompare(b.env) ||
      a.id.localeCompare(b.id) ||
      a.repetition - b.repetition,
  );

const cell = (value, digits = 1) =>
  value === null || value === undefined || Number.isNaN(value)
    ? "-"
    : Number(value).toFixed(digits);

function row(result) {
  const { measured, cdp } = result;
  const renderer = measured.renderer;
  const instances = renderer
    ? Object.values(renderer.instances)
        .map((summary) => Math.round(summary.mean))
        .join("+")
    : "-";
  return [
    result.env,
    result.id,
    `r${result.repetition}`,
    cell(measured.probe.fps),
    cell(mapDrawsPerSecondOf(measured)),
    cell(renderer?.repliesPerSecond),
    cell(measured.probe.frameMs.p50),
    cell(measured.probe.frameMs.p95),
    cell(measured.probe.frameMs.p99),
    cell(measured.probe.frameMs.max),
    measured.probe.framesOver34Ms,
    measured.probe.longTasks,
    cell(renderer?.workerMs.total.p50),
    cell(renderer?.workerMs.total.p95),
    cell(renderer?.workerMs.advance.p50),
    cell(renderer?.workerMs.emit.p50),
    cell(renderer?.roundTripMs.p50),
    cell(renderer?.roundTripMs.p95),
    cell(renderer?.transferredKilobytesPerFrame.mean),
    cell(cdp.mainThreadBusyPercent),
    cell(measured.gpuMs?.p50, 2),
    cell(measured.gpuMs?.p95, 2),
    cell(cdp.gpuProcessCpuPercent),
    cell(renderer ? renderer.visibleTrains.mean : null, 0),
    instances,
    cell(cdp.heapLiveAfterGcMB),
  ];
}

const header = [
  "env",
  "scenario",
  "rep",
  "fps",
  "map draws/s",
  "data updates/s",
  "frame p50",
  "frame p95",
  "frame p99",
  "frame max",
  "frames >34 ms",
  "long tasks",
  "worker p50",
  "worker p95",
  "advance p50",
  "emit p50",
  "round trip p50",
  "round trip p95",
  "KB/frame",
  "main busy %",
  "gpu p50",
  "gpu p95",
  "gpu proc cpu %",
  "trains in view",
  "instances",
  "heap MB",
];

process.stdout.write(
  "map draws/s counts MapLibre render events; results recorded before the counter existed use GPU timer samples per second, which equal map draws. advance and emit are worker milliseconds as reported (scaled by the slowdown factor on the phone profile).\n\n",
);

const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
for (const result of results) lines.push(`| ${row(result).join(" | ")} |`);
process.stdout.write(`${lines.join("\n")}\n`);

const zoomResults = results.filter((result) => (result.measured.probe.byZoom?.length ?? 0) > 3);
for (const result of zoomResults) {
  const renderer = result.measured.renderer;
  const zones = new Map((renderer?.byZoom ?? []).map((zone) => [zone.zoomFrom, zone]));
  process.stdout.write(
    `\n${result.env} ${result.id} r${result.repetition}, frames and worker per half zoom level\n\n`,
  );
  process.stdout.write(
    "| zoom from | frames | frame p50 | frame p95 | frame max | frames >34 ms | worker p50 | worker p95 | trains in view | instances |\n",
  );
  process.stdout.write("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
  for (const zone of result.measured.probe.byZoom) {
    const data = zones.get(zone.zoomFrom);
    process.stdout.write(
      `| ${zone.zoomFrom.toFixed(1)} | ${zone.frames} | ${cell(zone.p50)} | ${cell(zone.p95)} | ${cell(zone.max)} | ${zone.over34} | ${cell(data?.workerP50)} | ${cell(data?.workerP95)} | ${data?.visibleMean ?? "-"} | ${data?.instancesMean ?? "-"} |\n`,
    );
  }
}
