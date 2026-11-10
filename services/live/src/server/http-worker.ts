import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import { serve } from "@hono/node-server";
import { withPlayback } from "../playback/mount.ts";
import { FileStore } from "../publish/storage.ts";
import { createLiveApp, ENGINE_STALL_MS, EngineHeartbeat, HeadBuffer } from "./app.ts";
import type { HttpThreadOptions, WorkerCommand, WorkerReport } from "./http-thread.ts";

const options = workerData as HttpThreadOptions;
const port = parentPort;
if (!port) throw new Error("http-worker.ts runs only as a worker thread");

const store = new FileStore(options.root);
const head = new HeadBuffer();
const engine = new EngineHeartbeat();
let server: Server | undefined;
let posted = false;
let closeAsked = false;

function close(): void {
  closeAsked = true;
  if (!server) return;
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

port.on("message", (command: WorkerCommand) => {
  if (command.type === "head") {
    posted = true;
    head.set(command.bytes);
  } else if (command.type === "beat") engine.beat();
  else close();
});

const restored = await store.read("head");
if (restored && !posted) head.set(new Uint8Array(restored));

const report = (message: WorkerReport) => port.postMessage(message);
server = serve(
  {
    fetch: withPlayback(
      createLiveApp(store, {
        head,
        engine,
        engineStallMs: options.engineStallMs ?? ENGINE_STALL_MS,
      }),
      options.playback,
      () => Date.now() / 1000,
    ).fetch,
    hostname: options.host,
    port: options.port,
  },
  (info: AddressInfo) =>
    report({
      type: "listening",
      port: info.port,
      heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 1_048_576),
    }),
) as Server;
server.on("error", (error) => {
  report({ type: "failed", error: String(error).slice(0, 200) });
  process.exit(1);
});
if (closeAsked) close();
