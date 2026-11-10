import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { sha256OfFile } from "../storage/reader.ts";

export interface SeedMatch {
  readonly path: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly fetchedAt: string | null;
}

interface SeedSidecar {
  readonly url?: unknown;
  readonly sha256?: unknown;
  readonly fetched_at?: unknown;
}

async function sidecarFiles(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => sidecarFiles(join(dir, entry.name), depth - 1)),
  );
  const own = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name));
  return [...own, ...nested.flat()];
}

async function readSidecar(path: string): Promise<SeedSidecar | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SeedSidecar;
  } catch {
    return null;
  }
}

/**
 * A file downloaded earlier from exactly this URL (a `<file>.json` sidecar with `url` and `sha256`),
 * accepted only when the file still hashes to the recorded sha256.
 */
export async function findSeed(seedDir: string | null, url: string): Promise<SeedMatch | null> {
  if (!seedDir) return null;
  for (const sidecarPath of await sidecarFiles(seedDir, 3)) {
    const sidecar = await readSidecar(sidecarPath);
    if (sidecar?.url !== url || typeof sidecar.sha256 !== "string") continue;
    const path = sidecarPath.slice(0, -".json".length);
    const actual = await sha256OfFile(path).catch(() => null);
    if (actual?.sha256 !== sidecar.sha256) continue;
    return {
      path,
      relativePath: relative(seedDir, path),
      sha256: actual.sha256,
      bytes: actual.bytes,
      fetchedAt:
        typeof sidecar.fetched_at === "string" ? new Date(sidecar.fetched_at).toISOString() : null,
    };
  }
  return null;
}

export async function copySeed(seed: SeedMatch, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(seed.path, target);
}
