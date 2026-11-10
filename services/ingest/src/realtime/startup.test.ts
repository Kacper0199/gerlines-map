import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeWritable } from "./startup.ts";

describe("probeWritable", () => {
  it("passes in a writable directory and leaves nothing behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gerlines-probe-"));
    try {
      await probeWritable(join(dir, "live.checkpoint.gz"));
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a directory it cannot write", async () => {
    await expect(probeWritable(join(tmpdir(), "missing-dir-gerlines", "x.gz"))).rejects.toThrow(
      "checkpoint directory is not writable",
    );
  });
});
