import { mkdir, open, readdir, readFile, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ParsedLines, parseJsonLinesDetailed } from "./sidecar.ts";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function readJsonLinesFile<T>(path: string): Promise<T[]> {
  return (await readJsonLinesDetailed<T>(path)).values;
}

export async function readJsonLinesDetailed<T>(path: string): Promise<ParsedLines<T>> {
  const text = await readTextIfExists(path);
  return text === null ? { values: [], badLines: [] } : parseJsonLinesDetailed<T>(text);
}

export async function sizeIfExists(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function listDirIfExists(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Drops an interrupted last line (no trailing newline) left by a crash, once per file and writer. */
async function repairTail(path: string, repaired: Set<string>): Promise<void> {
  if (repaired.has(path)) return;
  const text = await readTextIfExists(path);
  if (text !== null && text !== "" && !text.endsWith("\n")) {
    await truncate(path, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
  }
  repaired.add(path);
}

/** Makes a created, renamed or removed entry of a directory durable. */
export async function syncDir(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Appends one JSON line and waits until it is on disk. After a failed append (disk full, I/O error) the
 * file may end in a torn line, so it is repaired again before the next append.
 */
export async function appendJsonLine(
  path: string,
  value: unknown,
  repaired: Set<string>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await repairTail(path, repaired);
  const created = (await sizeIfExists(path)) === null;
  try {
    const handle = await open(path, "a");
    try {
      await handle.write(`${JSON.stringify(value)}\n`);
      await handle.datasync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    repaired.delete(path);
    throw error;
  }
  if (created) await syncDir(dirname(path));
}

export function resolveInside(root: string, relative: string): string {
  if (relative.startsWith("/") || relative.split("/").includes("..")) {
    throw new Error(`path ${relative} escapes the recordings directory`);
  }
  return join(root, relative);
}
