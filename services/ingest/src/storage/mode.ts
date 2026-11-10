import { mkdir, rename, writeFile } from "node:fs/promises";
import { readTextIfExists, resolveInside, syncDir } from "./files.ts";
import { TMP_DIR } from "./paths.ts";

export type RecorderMode = "full" | "travel" | "paused";

export const RECORDER_MODES: readonly RecorderMode[] = ["full", "travel", "paused"];
export const MODE_PATH = ".recorder-mode.json";

export interface ModeSetting {
  readonly mode: RecorderMode;
  readonly at: string | null;
  readonly reason: string | null;
}

export const FULL: ModeSetting = { mode: "full", at: null, reason: null };

export function isRecorderMode(value: unknown): value is RecorderMode {
  return typeof value === "string" && (RECORDER_MODES as readonly string[]).includes(value);
}

/**
 * The mode the recordings folder asks for. A missing or unreadable file means `full`: recording is the default,
 * so a broken switch can never stop it.
 */
export async function readMode(root: string): Promise<ModeSetting> {
  const text = await readTextIfExists(resolveInside(root, MODE_PATH)).catch(() => null);
  if (text === null) return FULL;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!isRecorderMode(parsed.mode)) return FULL;
    return {
      mode: parsed.mode,
      at: typeof parsed.at === "string" ? parsed.at : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
  } catch {
    return FULL;
  }
}

/** Writes the mode atomically (temporary file, then rename) so a running recorder never reads half a file. */
export async function writeMode(
  root: string,
  mode: RecorderMode,
  at: Date,
  reason: string | null,
): Promise<ModeSetting> {
  const setting: ModeSetting = { mode, at: at.toISOString(), reason };
  const temp = resolveInside(root, `${TMP_DIR}/mode-${process.pid}-${at.getTime()}.json`);
  await mkdir(resolveInside(root, TMP_DIR), { recursive: true });
  await writeFile(temp, `${JSON.stringify({ v: 1, ...setting })}\n`, { flush: true });
  await rename(temp, resolveInside(root, MODE_PATH));
  await syncDir(root);
  return setting;
}
