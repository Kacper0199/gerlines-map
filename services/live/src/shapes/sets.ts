import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { PackSets } from "@gerlines/live-frame";
import {
  buildSetFiles,
  pruneSets,
  readBase,
  type SetJob,
  type SetResult,
  ShapeCache,
  setPaths,
} from "./set-build.ts";

/** Seconds of one pack set window (FORMAT.md 4.2): set `id` covers [id, id + 1) times this. */
export const PACK_SET_WINDOW_S = 600;
/** How long before its window a set is built, so clients hold it when the window starts. */
export const PACK_SET_LEAD_S = 120;
/** Sets kept behind the latest: an hour of increments for clients that fall behind. */
export const PACK_SETS_KEPT = 6;
/**
 * Vertices of one base set part: about 2 MB plain and 0.5 MB brotli, so a national set of about
 * 1,900,000 vertices comes in about 13 parts and the first trains appear after the first.
 */
export const PACK_SET_PART_VERTICES = 150_000;

export interface PackSetReport extends Omit<SetResult, "numbers"> {
  readonly shapes: number;
  readonly seconds: number;
  /** True when the base of this id was already published (a restart) and was adopted as it is. */
  readonly adopted: boolean;
}

/** Builds a set's files; the default runs `buildSetFiles` on a worker thread of its own. */
export type SetRunner = (job: SetJob) => Promise<SetResult>;

export interface PackSetOptions {
  readonly window?: number;
  readonly lead?: number;
  readonly kept?: number;
  readonly partVertices?: number;
  readonly runner?: SetRunner;
}

interface PublishedSet {
  readonly id: number;
  readonly parts: number;
  readonly shapes: ReadonlySet<number>;
}

/** The set whose window starts next after `now + lead`, or the current one. */
export function packSetDue(now: number, window = PACK_SET_WINDOW_S, lead = PACK_SET_LEAD_S) {
  return Math.floor((now + lead) / window);
}

/** Runs builds in the calling thread (tests, tools). */
export function inlineRunner(files?: Parameters<typeof buildSetFiles>[2]): SetRunner {
  const cache = new ShapeCache();
  return async (job) => buildSetFiles(job, cache, files);
}

/**
 * Runs builds on one worker thread: reading, decoding, encoding and compressing a set
 * take seconds of CPU, which would hold the tick and queue behind the libuv pool of the HTTP
 * thread's file reads. Compression there is synchronous, so it does not use that pool at all.
 */
export class WorkerRunner {
  #worker: Worker | null = null;
  #pending: { resolve: (result: SetResult) => void; reject: (error: Error) => void } | null = null;

  readonly run: SetRunner = (job) =>
    new Promise((resolve, reject) => {
      if (this.#pending) {
        reject(new Error("a pack set build is running"));
        return;
      }
      this.#pending = { resolve, reject };
      this.#start().postMessage(job);
    });

  #start(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL("./set-worker.ts", import.meta.url));
    worker.on("message", (message: { ok: boolean; result?: SetResult; error?: string }) => {
      const pending = this.#pending;
      this.#pending = null;
      if (message.ok && message.result) pending?.resolve(message.result);
      else pending?.reject(new Error(message.error ?? "pack set build failed"));
    });
    worker.on("error", (error) => this.#fail(error));
    worker.on("exit", (code) => this.#fail(new Error(`pack set worker exited with ${code}`)));
    worker.unref();
    this.#worker = worker;
    return worker;
  }

  #fail(error: Error): void {
    this.#worker = null;
    const pending = this.#pending;
    this.#pending = null;
    pending?.reject(error);
  }

  async close(): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    await worker?.terminate();
  }
}

/**
 * Publishes pack sets from the gated shape packs of one epoch (`s/<epoch>/<number>.bin`): for each
 * window a base set with every shape the frames name until the window ends, in parts of nearby
 * shapes, and an increment with the shapes the previous set lacks, each part one compact 1.4 pack
 * (FORMAT.md 4.2 and 5.4). Part 0 and the increment list the shape numbers without a pack (5.5),
 * so clients do not ask for them one by one; a single pack that does not decode counts as absent.
 * A build runs off the tick (`runner`), stages its files and moves them into place; a build that
 * fails is not tried again before the next window. Sets are immutable: after a restart the base
 * already published for an id is adopted as it is.
 */
export class PackSetPublisher {
  readonly #root: string;
  readonly #epoch: number;
  readonly #window: number;
  readonly #lead: number;
  readonly #kept: number;
  readonly #partVertices: number;
  readonly #runner: SetRunner;
  #latest: PublishedSet | null = null;
  #first = 0;
  #building = false;
  #failed: number | null = null;

  constructor(root: string, epoch: number, options: PackSetOptions = {}) {
    this.#root = root;
    this.#epoch = epoch;
    this.#window = options.window ?? PACK_SET_WINDOW_S;
    this.#lead = options.lead ?? PACK_SET_LEAD_S;
    this.#kept = options.kept ?? PACK_SETS_KEPT;
    this.#partVertices = options.partVertices ?? PACK_SET_PART_VERTICES;
    this.#runner = options.runner ?? inlineRunner();
  }

  /** The head section: null until the first set is published. */
  current(): PackSets | null {
    if (!this.#latest) return null;
    const { id, parts } = this.#latest;
    return { epoch: this.#epoch, latest: id, first: this.#first, parts };
  }

  /** The id to build at `now`, or null when it is published, failed in this window or one runs. */
  due(now: number): number | null {
    if (this.#building) return null;
    const id = packSetDue(now, this.#window, this.#lead);
    if (id === this.#failed) return null;
    return this.#latest && this.#latest.id >= id ? null : id;
  }

  /**
   * Builds and publishes set `id` from the shape numbers the frames will name until its window
   * ends (`shapesUntil((id + 1) * window)`), then makes it the head's latest. On failure the id is
   * not due again and the head keeps the set it named.
   */
  async build(
    id: number,
    shapesUntil: (until: number) => readonly number[],
    timetableVersion: number,
  ): Promise<PackSetReport> {
    this.#building = true;
    const started = performance.now();
    const seconds = () => Math.round((performance.now() - started) / 100) / 10;
    try {
      const previous = this.#latest ?? readBase(this.#root, this.#epoch, id - 1);
      const held = readBase(this.#root, this.#epoch, id);
      if (held) {
        const chained = previous?.id === id - 1 && existsSync(this.#incrementOf(id));
        this.#publish(held, chained);
        return { ...ADOPTED, id, shapes: held.shapes.size, parts: held.parts, seconds: seconds() };
      }
      const chained = previous !== null && previous.id === id - 1;
      const result = await this.#runner({
        root: this.#root,
        epoch: this.#epoch,
        id,
        timetableVersion,
        wanted: shapesUntil((id + 1) * this.#window),
        previous: chained ? [...previous.shapes] : null,
        partVertices: this.#partVertices,
      });
      const { numbers, ...report } = result;
      this.#publish({ id, parts: result.parts, shapes: new Set(numbers) }, chained);
      pruneSets(this.#root, this.#epoch, id - this.#kept, id);
      return { ...report, shapes: numbers.length, seconds: seconds(), adopted: false };
    } catch (error) {
      this.#failed = id;
      throw error;
    } finally {
      this.#building = false;
    }
  }

  #incrementOf(id: number): string {
    return setPaths(this.#root, this.#epoch, id).increment;
  }

  /**
   * The chain of increments reaches back to the oldest kept set after which every increment is on
   * disk; after a restart it walks back through them.
   */
  #publish(set: PublishedSet, chained: boolean): void {
    if (!chained) this.#first = set.id;
    else if (!this.#latest) {
      let first = set.id - 1;
      while (first > set.id - this.#kept && existsSync(this.#incrementOf(first))) first--;
      this.#first = first;
    }
    this.#first = Math.max(this.#first, set.id - this.#kept);
    this.#latest = set;
  }
}

const ADOPTED = {
  parts: 0,
  increment: 0,
  absent: 0,
  corrupt: [],
  plainBytes: 0,
  brBytes: 0,
  incrementBrBytes: 0,
  encodeMs: 0,
  compressMs: 0,
  adopted: true,
};
