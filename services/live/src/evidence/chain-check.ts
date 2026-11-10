import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { decodeKeyframe, frameToObject, type Head, type TripRecord } from "@gerlines/live-frame";
import type { HeadEntry } from "./continuity.ts";
import { ChainError, FrameClient, type ObjectReader, sameState } from "./frame-client.ts";

export interface ChainCheckResult {
  readonly clients: number;
  readonly follows: number;
  readonly reloads: number;
  readonly keyframeComparisons: number;
  readonly mismatches: number;
  readonly chainErrors: readonly string[];
  readonly finalStatesEqual: boolean;
}

function headOf(entry: HeadEntry): Head {
  const [timeBase, sequence, keyframeSequence, oldestSequence, timetableVersion] = entry;
  return { kind: "head", sequence, timetableVersion, timeBase, keyframeSequence, oldestSequence };
}

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

class KeyframeCache {
  readonly #read: ObjectReader;
  readonly #cache = new Map<number, Map<number, TripRecord> | null>();

  constructor(read: ObjectReader) {
    this.#read = read;
  }

  async at(sequence: number): Promise<Map<number, TripRecord> | null> {
    if (!this.#cache.has(sequence)) {
      const bytes = await this.#read(`k/${sequence}.bin`);
      const trips = bytes ? frameToObject(decodeKeyframe(bytes)).trips : null;
      this.#cache.set(sequence, trips ? new Map(trips.map((t) => [t.key, t])) : null);
    }
    return this.#cache.get(sequence) ?? null;
  }
}

interface ChainTally {
  follows: number;
  reloads: number;
  comparisons: number;
  mismatches: number;
}

function nextHead(at: number, count: number, random: () => number): number {
  const step = random() < 0.9 ? 1 + Math.floor(random() * 5) : 30 + Math.floor(random() * 1200);
  return at + step >= count && at < count - 1 ? count - 1 : at + step;
}

async function followClient(
  client: FrameClient,
  heads: readonly HeadEntry[],
  keyframes: KeyframeCache,
  tally: ChainTally,
  random: () => number,
): Promise<void> {
  let at = Math.floor(random() * heads.length);
  while (at < heads.length) {
    const result = await client.follow(headOf(heads[at] as HeadEntry));
    tally.follows++;
    if (result.reloaded) tally.reloads++;
    const expected = await keyframes.at(client.sequence ?? -1);
    if (expected) {
      tally.comparisons++;
      if (!sameState(client.state, expected)) tally.mismatches++;
    }
    at = nextHead(at, heads.length, random);
  }
}

/**
 * Simulated clients join at random heads and follow later heads with random gaps (a tab in the
 * background, a lost notice). After every step the client's state must equal the keyframe of its
 * sequence where one was published (keyframe k = state after delta k), and every client must end
 * in the same state.
 */
export async function checkChain(
  read: ObjectReader,
  heads: readonly HeadEntry[],
  options: { readonly clients: number; readonly seed: number },
): Promise<ChainCheckResult> {
  const random = seeded(options.seed);
  const keyframes = new KeyframeCache(read);
  const tally: ChainTally = { follows: 0, reloads: 0, comparisons: 0, mismatches: 0 };
  const chainErrors: string[] = [];
  const finals: Map<number, TripRecord>[] = [];
  for (let c = 0; c < options.clients; c++) {
    const client = new FrameClient(read);
    try {
      await followClient(client, heads, keyframes, tally, random);
      finals.push(new Map(client.state));
    } catch (error) {
      if (!(error instanceof ChainError)) throw error;
      if (chainErrors.length < 20) chainErrors.push(`client ${c}: ${error.message}`);
    }
  }
  const first = finals[0];
  return {
    clients: options.clients,
    follows: tally.follows,
    reloads: tally.reloads,
    keyframeComparisons: tally.comparisons,
    mismatches: tally.mismatches,
    chainErrors,
    finalStatesEqual: first !== undefined && finals.every((state) => sameState(state, first)),
  };
}

/** sha256 of every file under a directory, by relative path (determinism evidence). */
export async function digestTree(root: string): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if ((await stat(path)).isDirectory()) await walk(path);
      else
        digests.set(
          relative(root, path),
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        );
    }
  };
  await walk(root);
  return digests;
}

export interface TreeComparison {
  readonly files: number;
  readonly equal: number;
  readonly different: readonly string[];
  readonly onlyInOne: readonly string[];
}

export function compareTrees(a: Map<string, string>, b: Map<string, string>): TreeComparison {
  const different: string[] = [];
  const onlyInOne: string[] = [];
  let equal = 0;
  for (const [path, digest] of a) {
    const other = b.get(path);
    if (other === undefined) onlyInOne.push(path);
    else if (other === digest) equal++;
    else different.push(path);
  }
  for (const path of b.keys()) if (!a.has(path)) onlyInOne.push(path);
  return { files: new Set([...a.keys(), ...b.keys()]).size, equal, different, onlyInOne };
}
