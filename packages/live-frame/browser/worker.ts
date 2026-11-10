import { decodeKeyframe, frameToObject } from "../src/index.ts";
import { atOddOffset, type DecodeOutcome, decodeVector, type VectorFile } from "../test/golden.ts";

interface VectorResult {
  readonly name: string;
  readonly pass: boolean;
  readonly outcome: string;
  readonly oddOffsetPass: boolean;
}

interface Timing {
  readonly name: string;
  readonly bytes: number;
  readonly decodeP50: number;
  readonly decodeP95: number;
  readonly objectsP50: number;
}

export interface WorkerReport {
  readonly pass: boolean;
  readonly inWorker: boolean;
  readonly userAgent: string;
  readonly vectors: readonly VectorResult[];
  readonly timings: readonly Timing[];
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );
}

async function fetchBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(path)).arrayBuffer());
}

async function checkVector(name: string): Promise<VectorResult> {
  const file = (await (await fetch(`../test-vectors/${name}.json`)).json()) as VectorFile;
  const bytes = await fetchBytes(`../test-vectors/${name}.bin`);
  let outcome: DecodeOutcome;
  let shifted: DecodeOutcome;
  try {
    outcome = decodeVector(file.decoder, bytes);
    shifted = decodeVector(file.decoder, atOddOffset(bytes));
  } catch (error) {
    return { name, pass: false, outcome: `threw ${String(error)}`, oddOffsetPass: false };
  }
  const expected = canonical(file.error ? { error: file.error } : { value: file.expected });
  const oddOffsetPass = canonical(shifted) === expected;
  const pass = bytes.length === file.byteLength && canonical(outcome) === expected && oddOffsetPass;
  return { name, pass, outcome: "error" in outcome ? outcome.error : "decoded", oddOffsetPass };
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
}

function time(run: () => unknown, runs: number): number[] {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return samples;
}

async function timing(name: string): Promise<Timing> {
  const bytes = await fetchBytes(`../bench/${name}.bin`);
  const decode = time(() => decodeKeyframe(bytes), 41);
  const objects = time(() => frameToObject(decodeKeyframe(bytes)), 11);
  return {
    name,
    bytes: bytes.length,
    decodeP50: percentile(decode, 0.5),
    decodeP95: percentile(decode, 0.95),
    objectsP50: percentile(objects, 0.5),
  };
}

async function run(): Promise<WorkerReport> {
  const names = (await (await fetch("../test-vectors/index.json")).json()) as string[];
  const vectors = await Promise.all(names.map(checkVector));
  const timings = [await timing("keyframe-3000"), await timing("keyframe-15000")];
  const inWorker = typeof (globalThis as { document?: unknown }).document === "undefined";
  return {
    pass: inWorker && vectors.length > 0 && vectors.every((vector) => vector.pass),
    inWorker,
    userAgent: navigator.userAgent,
    vectors,
    timings,
  };
}

addEventListener("message", () => {
  run().then(
    (report) => postMessage(report),
    (error: unknown) =>
      postMessage({
        pass: false,
        inWorker: true,
        userAgent: "",
        vectors: [],
        timings: [],
        error: String(error),
      }),
  );
});
