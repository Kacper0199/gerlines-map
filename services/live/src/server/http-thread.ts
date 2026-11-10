import { Worker } from "node:worker_threads";

export interface HttpThreadOptions {
  /** The published objects (`--out`). */
  readonly root: string;
  readonly host: string;
  /** 0 picks a free port (tests). */
  readonly port: number;
  /** `LIVE_PLAYBACK_DIR`, served read only beside the live routes, or null. */
  readonly playback: string | null;
  /** How long without an engine beat before `/healthz` fails (ENGINE_STALL_MS by default). */
  readonly engineStallMs?: number;
}

export interface HttpThread {
  readonly port: number;
  /** The thread's V8 heap limit (resourceLimits), as V8 reports it. */
  readonly heapLimitMb: number;
  /** Hands the newest head's bytes to the server; requests see them as soon as the thread takes the message. */
  postHead(bytes: Uint8Array): void;
  /** The engine finished a tick: `/healthz` passes for ENGINE_STALL_MS more. */
  beat(): void;
  /** Called once when the thread ends without being asked to. */
  onExit(listener: (error: Error) => void): void;
  close(): Promise<void>;
}

export type WorkerReport =
  | { readonly type: "listening"; readonly port: number; readonly heapLimitMb: number }
  | { readonly type: "failed"; readonly error: string };

export type WorkerCommand =
  | { readonly type: "head"; readonly bytes: Uint8Array }
  | { readonly type: "beat" }
  | { readonly type: "close" };

const CLOSE_WAIT_MS = 5_000;
/**
 * The thread holds a head, a router and request buffers: a small heap beside the engine's. The
 * young generation is capped too, since a worker's default (192 MB here) would dwarf the old one.
 */
export const HTTP_THREAD_HEAP_MB = 64;
const HTTP_THREAD_YOUNG_MB = 16;
const WORKER = new URL("./http-worker.ts", import.meta.url);

/**
 * `live run`'s HTTP server on a thread of its own: the engine's tick, frame encoding and
 * waits never hold a request back, and the head comes from a buffer the engine fills after each
 * tick instead of a file read through the thread pool that compresses frames. The engine beats
 * once a tick, so the health check sees an engine that hangs.
 */
export function startHttpThread(
  options: HttpThreadOptions,
  script: URL = WORKER,
): Promise<HttpThread> {
  const worker = new Worker(script, {
    workerData: options,
    resourceLimits: {
      maxOldGenerationSizeMb: HTTP_THREAD_HEAP_MB,
      maxYoungGenerationSizeMb: HTTP_THREAD_YOUNG_MB,
    },
  });
  let closing = false;
  let cause: string | undefined;
  let exitListener: ((error: Error) => void) | undefined;
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  const send = (command: WorkerCommand) => {
    if (!closing) worker.postMessage(command);
  };
  return new Promise((resolve, reject) => {
    const failedToStart = (error: Error) => reject(error);
    worker.once("error", failedToStart);
    worker.once("exit", (code) => reject(new Error(`live HTTP thread exited with code ${code}`)));
    worker.once("message", (report: WorkerReport) => {
      worker.off("error", failedToStart);
      if (report.type === "failed") {
        void worker.terminate();
        reject(new Error(`live HTTP server did not start: ${report.error}`));
        return;
      }
      worker.on("message", (later: WorkerReport) => {
        if (later.type === "failed") cause = later.error;
      });
      const ended = (error: Error) => {
        if (closing) return;
        closing = true;
        exitListener?.(error);
      };
      worker.on("error", (error) => {
        cause = String(error).slice(0, 200);
        ended(error);
      });
      worker.once("exit", (code) =>
        ended(new Error(`live HTTP thread exited with code ${code}${cause ? `: ${cause}` : ""}`)),
      );
      resolve({
        port: report.port,
        heapLimitMb: report.heapLimitMb,
        postHead: (bytes) => send({ type: "head", bytes }),
        beat: () => send({ type: "beat" }),
        onExit: (listener) => {
          exitListener = listener;
        },
        close: async () => {
          if (closing) return exited;
          closing = true;
          worker.postMessage({ type: "close" } satisfies WorkerCommand);
          const timer = setTimeout(() => void worker.terminate(), CLOSE_WAIT_MS);
          await exited;
          clearTimeout(timer);
        },
      });
    });
  });
}
