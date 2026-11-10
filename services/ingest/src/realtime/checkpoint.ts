import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import { type CheckpointLine, type ProcessorSnapshot, snapshotFromLines } from "./processor.ts";

/** Largest decompressed checkpoint read back; a bigger file is not ours and is ignored. */
export const MAX_CHECKPOINT_BYTES = 2 * 1024 ** 3;

/**
 * Writes the processor's checkpoint as gzip-compressed JSON lines, streamed part by part, to a
 * temporary file of this process (owner-only) that replaces `path` only once complete.
 */
export async function writeCheckpoint(
  path: string,
  lines: Iterable<CheckpointLine>,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const gzip = createGzip({ level: 3 });
  const file = createWriteStream(temporary, { mode: 0o600 });
  const done = once(file, "close");
  const failed = new Promise<never>((_, reject) => {
    gzip.once("error", reject);
    file.once("error", reject);
  });
  gzip.pipe(file);
  try {
    for (const line of lines) {
      if (!gzip.write(`${JSON.stringify(line)}\n`))
        await Promise.race([once(gzip, "drain"), failed]);
    }
    gzip.end();
    await Promise.race([done, failed]);
    await rename(temporary, path);
  } catch (error) {
    gzip.destroy();
    file.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The checkpoint at `path`, or undefined when there is none, it cannot be read whole, or it inflates
 * past `maxBytes`.
 */
export async function readCheckpoint(
  path: string,
  maxBytes = MAX_CHECKPOINT_BYTES,
): Promise<ProcessorSnapshot | undefined> {
  try {
    const lines: CheckpointLine[] = [];
    const file = createReadStream(path);
    const input = createGunzip();
    let inflated = 0;
    input.on("data", (chunk: Buffer) => {
      inflated += chunk.length;
      if (inflated > maxBytes) input.destroy(new Error("checkpoint inflates past its cap"));
    });
    file.once("error", (error) => input.destroy(error));
    file.pipe(input);
    for await (const text of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
      if (text.trim() !== "") lines.push(JSON.parse(text) as CheckpointLine);
    }
    return snapshotFromLines(lines);
  } catch {
    return undefined;
  }
}
