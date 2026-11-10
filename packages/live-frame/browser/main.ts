import type { WorkerReport } from "./worker.ts";

const output = document.getElementById("result") as HTMLElement;
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

worker.addEventListener("message", (event: MessageEvent<WorkerReport>) => {
  const report = event.data;
  output.textContent = JSON.stringify(report, null, 2);
  document.title = `live-frame worker check: ${report.pass ? "PASS" : "FAIL"}`;
});
worker.addEventListener("error", (event) => {
  output.textContent = `worker error: ${event.message}`;
  document.title = "live-frame worker check: FAIL";
});
worker.postMessage("start");
