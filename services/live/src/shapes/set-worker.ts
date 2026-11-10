import { parentPort } from "node:worker_threads";
import { buildSetFiles, type SetJob, ShapeCache } from "./set-build.ts";

const port = parentPort;
if (!port) throw new Error("set-worker runs as a worker thread");
const cache = new ShapeCache();

port.on("message", (job: SetJob) => {
  try {
    port.postMessage({ ok: true, result: buildSetFiles(job, cache) });
  } catch (error) {
    port.postMessage({ ok: false, error: String(error).slice(0, 300) });
  }
});
