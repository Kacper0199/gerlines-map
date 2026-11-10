import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Head } from "@gerlines/live-frame";
import type { FrameSink } from "../engine/engine.ts";
import { recordDuration } from "../metrics.ts";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** The two encodings of FORMAT.md section 7: brotli quality 11 and gzip level 9. */
export async function compressBoth(bytes: Uint8Array): Promise<{ br: Buffer; gz: Buffer }> {
  const started = performance.now();
  const [br, gz] = await Promise.all([
    brotli(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
    gzipAsync(bytes, { level: 9 }),
  ]);
  recordDuration("compress", performance.now() - started);
  return { br, gz };
}

export interface StoredSizes {
  readonly plain: number;
  readonly br: number;
  readonly gz: number;
}

/** The marker `packs build` writes last into `s/<epoch>/`. */
export const PACKS_COMPLETE = "complete.json";

/** Per timetable version: the shapes a full build wrote or kept, and when it finished. */
interface PacksMarker {
  epoch: number;
  versions: Record<string, { shapes: number; completedAt: string } & Record<string, unknown>>;
}

let temporaryCounter = 0;

/** Writes through a temporary name and a rename, so readers never see a partial file. */
async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  temporaryCounter++;
  const temporary = `${path}.tmp-${process.pid}-${temporaryCounter}`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export type ObjectListener = (event: {
  path: string;
  kind: "k" | "d" | "head" | "s";
  sizes: StoredSizes;
}) => void;

/**
 * The published objects under `root` (`data/live/v1`): `head`, `k/<seq>.bin`, `d/<seq>.bin` and
 * `s/<epoch>/<number>.bin`, each immutable object with `.br` and `.gz` beside it. Objects are written
 * before the head that names them; an existing object is never replaced by other bytes.
 */
export class FileStore implements FrameSink {
  readonly root: string;
  private readonly listener: ObjectListener | undefined;

  constructor(root: string, listener?: ObjectListener) {
    this.root = root;
    this.listener = listener;
  }

  async object(kind: "k" | "d", sequence: number, bytes: Uint8Array): Promise<void> {
    await this.immutable(join(kind, `${sequence}.bin`), kind, bytes);
  }

  async pack(epoch: number, number: number, bytes: Uint8Array): Promise<StoredSizes | null> {
    return this.immutable(join("s", String(epoch), `${number}.bin`), "s", bytes);
  }

  async head(bytes: Uint8Array, _head: Head): Promise<void> {
    await writeAtomic(join(this.root, "head"), bytes);
    this.listener?.({
      path: "head",
      kind: "head",
      sizes: { plain: bytes.length, br: bytes.length, gz: bytes.length },
    });
  }

  async read(relative: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.root, relative));
    } catch {
      return null;
    }
  }

  /**
   * Whether a complete set of packs of a shape epoch is published here (`live run` waits for
   * it), for one timetable version or any: `packs build` marks a version in `s/<epoch>/complete.json`
   * last, after a full build of more than 0 shapes without failures that passed its gate, and drops
   * the mark when that version's build starts again, so a build that died, failed or still runs does
   * not count. A mark naming more shapes than packs on disk does not count.
   */
  async hasPacks(epoch: number, timetableVersion?: number): Promise<boolean> {
    const marker = await this.#packsMarker(epoch);
    if (!marker) return false;
    const entries =
      timetableVersion === undefined
        ? Object.values(marker.versions)
        : [marker.versions[String(timetableVersion)]].filter((entry) => entry !== undefined);
    if (entries.length === 0) return false;
    const packs = await this.#packCount(epoch);
    return entries.some((entry) => entry.shapes > 0 && entry.shapes <= packs);
  }

  /** Marks a timetable version's packs of an epoch complete (no secrets: the file sits beside the packs). */
  async markPacksComplete(
    epoch: number,
    timetableVersion: number,
    summary: { readonly shapes: number } & Record<string, unknown>,
  ): Promise<void> {
    if (!(summary.shapes > 0)) throw new Error(`no shapes to mark complete in epoch ${epoch}`);
    const marker = (await this.#packsMarker(epoch)) ?? { epoch, versions: {} };
    marker.versions[String(timetableVersion)] = {
      ...summary,
      completedAt: new Date().toISOString(),
    };
    await this.#writeMarker(epoch, marker);
  }

  /** Drops a timetable version's mark (the file goes with the last one). */
  async clearPacksComplete(epoch: number, timetableVersion: number): Promise<void> {
    const marker = await this.#packsMarker(epoch);
    if (!marker) return;
    delete marker.versions[String(timetableVersion)];
    if (Object.keys(marker.versions).length > 0) await this.#writeMarker(epoch, marker);
    else await rm(join(this.root, "s", String(epoch), PACKS_COMPLETE), { force: true });
  }

  async #writeMarker(epoch: number, marker: PacksMarker): Promise<void> {
    await writeAtomic(
      join(this.root, "s", String(epoch), PACKS_COMPLETE),
      Buffer.from(JSON.stringify(marker)),
    );
  }

  async #packsMarker(epoch: number): Promise<PacksMarker | null> {
    const bytes = await this.read(join("s", String(epoch), PACKS_COMPLETE));
    if (!bytes) return null;
    try {
      const parsed = JSON.parse(String(bytes)) as Partial<PacksMarker>;
      return parsed.versions && typeof parsed.versions === "object"
        ? { epoch, versions: parsed.versions }
        : null;
    } catch {
      return null;
    }
  }

  async #packCount(epoch: number): Promise<number> {
    try {
      const names = await readdir(join(this.root, "s", String(epoch)));
      return names.filter((name) => name.endsWith(".bin")).length;
    } catch {
      return 0;
    }
  }

  /** The highest sequence of any delta or keyframe on disk, 0 when there is none. */
  async highestSequence(): Promise<number> {
    let highest = 0;
    for (const kind of ["d", "k"]) {
      let names: string[];
      try {
        names = await readdir(join(this.root, kind));
      } catch {
        continue;
      }
      for (const name of names) {
        const sequence = Number.parseInt(name, 10);
        if (Number.isInteger(sequence) && sequence > highest) highest = sequence;
      }
    }
    return highest;
  }

  /**
   * Deletes deltas and keyframes below `belowSequence` (objects no head names any more, kept a
   * while for clients and the CDN by the caller's choice of bound); returns the files removed.
   */
  async prune(belowSequence: number): Promise<number> {
    let removed = 0;
    for (const kind of ["d", "k"]) {
      let names: string[];
      try {
        names = await readdir(join(this.root, kind));
      } catch {
        continue;
      }
      for (const name of names) {
        const sequence = Number.parseInt(name, 10);
        if (Number.isInteger(sequence) && sequence < belowSequence) {
          await rm(join(this.root, kind, name), { force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  private async immutable(
    relative: string,
    kind: "k" | "d" | "s",
    bytes: Uint8Array,
  ): Promise<StoredSizes | null> {
    const path = join(this.root, relative);
    if (await exists(path)) {
      const held = await readFile(path);
      if (Buffer.compare(held, bytes) !== 0) {
        throw new Error(`refusing to replace ${relative}: published objects are immutable`);
      }
      return null;
    }
    const { br, gz } = await compressBoth(bytes);
    await writeAtomic(`${path}.br`, br);
    await writeAtomic(`${path}.gz`, gz);
    await writeAtomic(path, bytes);
    const sizes = { plain: bytes.length, br: br.length, gz: gz.length };
    this.listener?.({ path: relative, kind, sizes });
    return sizes;
  }
}
