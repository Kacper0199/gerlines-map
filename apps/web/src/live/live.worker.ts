import type { WorkerMessage, WorkerRequest } from "../motion/protocol.ts";
import { createLiveRuntime } from "./live-runtime.ts";
import type { PushSocket } from "./push-channel.ts";

interface WorkerScope {
  postMessage(message: WorkerMessage, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const RESOURCE_BUFFER = 200_000;
let measuring = false;

/** A path or http url of the push server as a WebSocket url on the page's own origin. */
function socketUrl(url: string): string {
  const target = new URL(url, globalThis.location.href);
  if (target.protocol === "http:") target.protocol = "ws:";
  if (target.protocol === "https:") target.protocol = "wss:";
  return target.href;
}

function openSocket(url: string): PushSocket {
  const socket = new WebSocket(socketUrl(url));
  const push: PushSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };
  socket.onopen = () => push.onopen?.();
  socket.onmessage = (event) => push.onmessage?.({ data: event.data });
  socket.onclose = (event) => push.onclose?.({ code: event.code });
  socket.onerror = () => push.onerror?.();
  return push;
}

function measureTransfer(): void {
  measuring = true;
  performance.setResourceTimingBufferSize(RESOURCE_BUFFER);
}

function transferred(): { frames: number; packs: number } | null {
  if (!measuring) return null;
  const totals = { frames: 0, packs: 0 };
  for (const entry of performance.getEntriesByType("resource")) {
    const size = (entry as PerformanceResourceTiming).transferSize;
    if (entry.name.includes("/s/") || entry.name.includes("/sets/")) totals.packs += size;
    else totals.frames += size;
  }
  return totals;
}

const runtime = createLiveRuntime({
  now: () => performance.timeOrigin + performance.now(),
  perf: () => performance.now(),
  transferred,
  measureTransfer,
  post: (message, transfer) => scope.postMessage(message, transfer),
  fetch: (url, init) => fetch(url, init),
  setTimeout: (callback, ms) => Number(globalThis.setTimeout(callback, ms)),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  openSocket,
  random: () => Math.random(),
});

scope.addEventListener("message", (event) => runtime.handle(event.data));
