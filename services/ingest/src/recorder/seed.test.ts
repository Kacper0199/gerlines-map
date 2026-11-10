import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copySeed, findSeed } from "./seed.ts";

const url =
  "https://www.opendata-oepnv.de/fileadmin/datasets/delfi/20261019_fahrplaene_gesamtdeutschland_gtfs.zip";
const bytes = Buffer.from("PK seed timetable");
const sha = createHash("sha256").update(bytes).digest("hex");
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gerlines-seed-"));
  await mkdir(join(dir, "delfi/2026-10-19"), { recursive: true });
  await writeFile(join(dir, "delfi/2026-10-19/delfi-gtfs.zip"), bytes);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sidecar(content: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "delfi/2026-10-19/delfi-gtfs.zip.json"), JSON.stringify(content));
}

describe("findSeed", () => {
  it("finds an earlier download of the same URL whose bytes still match its sha256", async () => {
    await sidecar({ url, sha256: sha, fetched_at: "2026-10-23T22:58:46Z" });
    const seed = await findSeed(dir, url);
    expect(seed).toMatchObject({
      relativePath: "delfi/2026-10-19/delfi-gtfs.zip",
      sha256: sha,
      bytes: bytes.length,
      fetchedAt: "2026-10-23T22:58:46.000Z",
    });
    const target = join(dir, "copy.part");
    if (seed) await copySeed(seed, target);
    expect((await readFile(target)).equals(bytes)).toBe(true);
  });

  it("ignores a seed for another URL, a changed file and a missing seed folder", async () => {
    await sidecar({ url: `${url}?other`, sha256: sha });
    expect(await findSeed(dir, url)).toBeNull();
    await sidecar({ url, sha256: "0".repeat(64) });
    expect(await findSeed(dir, url)).toBeNull();
    expect(await findSeed(null, url)).toBeNull();
    expect(await findSeed(join(dir, "missing"), url)).toBeNull();
  });
});
