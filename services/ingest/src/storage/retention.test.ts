import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifySource } from "../verify.ts";
import { readJsonLinesFile } from "./files.ts";
import { PayloadStore, type RecordDraft } from "./payload-store.ts";
import {
  applyRetention,
  CONFIGURED_GOLDEN_DAYS,
  loadArchiveEvidence,
  markGoldenDay,
  planRetention,
  RETENTION_JOURNAL,
  type RecoveryEvidence,
  readGoldenDays,
  readPrunedFiles,
} from "./retention.ts";
import type { Writer } from "./sidecar.ts";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-29T20:00:00Z");
const payload = (label: string) => Buffer.from(`payload ${label} `.repeat(200));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let root: string;
let manifests: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-retention-"));
  manifests = await mkdtemp(join(tmpdir(), "gerlines-retention-manifests-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(manifests, { recursive: true, force: true });
});

function draft(source: string, at: number, writer: Writer = "live"): RecordDraft {
  const iso = new Date(at).toISOString();
  return {
    v: 1,
    type: "fetch",
    source,
    run: "run",
    writer,
    url: "https://example.test/feed",
    method: "GET",
    startedAt: iso,
    observedAt: iso,
    durationMs: 1,
    status: 200,
    headers: {},
  };
}

/** Stores payloads of one source in time order through the real store, so sameAs and segments are genuine. */
async function record(
  source: string,
  items: readonly [string, Buffer][],
  writer: Writer = "live",
): Promise<void> {
  const store = new PayloadStore({
    root,
    source,
    writer,
    period: "hour",
    contentType: "application/x-protobuf",
  });
  for (const [iso, bytes] of items) {
    const at = Date.parse(iso);
    await store.storePayload(draft(source, at, writer), bytes, sha(bytes), at);
  }
  await store.close();
}

async function manifest(source: string, day: string, payloads: readonly Buffer[]): Promise<void> {
  await mkdir(join(manifests, source), { recursive: true });
  const lines = [
    {
      type: "archive",
      v: 1,
      source,
      day,
      url: `https://mirror.test/${day}.tar.br`,
      bytes: 1,
      lastModified: null,
      snapshots: payloads.length,
      complete: true,
      completedAt: "2026-10-29T00:00:00Z",
    },
    ...payloads.map((bytes, index) => ({
      type: "snapshot",
      name: `${day}/${index}.gtfs-rt.pbf`,
      at: `${day}T00:0${index}:01.000Z`,
      sha256: sha(bytes),
      bytes: bytes.length,
    })),
  ];
  await writeFile(
    join(manifests, source, `${day}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

const A = payload("A");
const B = payload("B");
const C = payload("C");
const D = payload("D");
const E = payload("E");
const F = payload("F");
const G = payload("G");
const R = payload("recent");
const Z = payload("golden");
const P = payload("processed");

async function scenario(): Promise<void> {
  await record("delfi-gtfs-rt", [
    ["2026-10-20T10:01:20Z", A],
    ["2026-10-20T10:02:20Z", B],
    ["2026-10-20T11:01:20Z", C],
    ["2026-10-20T11:02:20Z", D],
    ["2026-10-20T12:01:20Z", E],
    ["2026-10-20T13:01:20Z", E],
    ["2026-10-20T13:02:20Z", F],
    ["2026-10-25T10:01:20Z", Z],
    ["2026-10-29T10:01:20Z", R],
    ["2026-10-29T19:01:20Z", G],
  ]);
  await record("gtfsde-rt", [
    ["2026-10-20T10:01:30Z", payload("gtfsde 1")],
    ["2026-10-21T10:01:30Z", P],
    ["2026-10-29T19:01:30Z", payload("gtfsde now")],
  ]);
  await manifest("delfi-gtfs-rt", "2026-10-20", [A, B, C, E]);
  await manifest("delfi-gtfs-rt", "2026-10-25", [Z]);
  await manifest("delfi-gtfs-rt", "2026-10-29", [R, G]);
}

async function evidence(processedIds: readonly string[] = []): Promise<RecoveryEvidence> {
  const archive = await loadArchiveEvidence([manifests]);
  return {
    archived: (source, sha256) => archive.archived(source, sha256),
    processed: async (ids) => new Set(ids.filter((id) => processedIds.includes(id))),
    describe: () => ({
      manifests: archive.manifests,
      database: processedIds.length > 0 ? "fake" : null,
    }),
  };
}

const golden = new Map([
  ["2026-10-25", "G1 window"],
  ["2026-10-26", "replays"],
]);

function reasonOf(
  plan: Awaited<ReturnType<typeof planRetention>>,
  file: string,
): string | undefined {
  return plan.units.find((unit) => unit.file === file)?.reason;
}

describe("planRetention", () => {
  it("deletes only old, non-golden segments whose every payload the archive holds", async () => {
    await scenario();
    const plan = await planRetention({
      root,
      now: NOW,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence(),
    });
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/10.seg.zst")).toBe("deletable");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/11.seg.zst")).toBe("not-recoverable");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/12.seg.zst")).toBe("same-as-target");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/13.seg.zst")).toBe("not-recoverable");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-25/10.seg.zst")).toBe("golden");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-29/10.seg.zst")).toBe("recent");
    expect(reasonOf(plan, "gtfsde-rt/2026-10-20/10.seg.zst")).toBe("not-recoverable");
    expect(plan.dryRun).toBe(true);
    const deletable = plan.units.filter((unit) => unit.reason === "deletable");
    expect(deletable.every((unit) => unit.evidence === "archive")).toBe(true);
    expect(plan.totals.deletableFiles).toBe(1);
    expect(plan.totals.deletableBytes).toBe(deletable.reduce((sum, unit) => sum + unit.bytes, 0));
    expect(plan.totals.bytes).toBeGreaterThan(plan.totals.deletableBytes);
  });

  it("keeps a sameAs target when the record that names it stays", async () => {
    await scenario();
    const plan = await planRetention({
      root,
      now: NOW,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence(),
    });
    const kept = plan.units.find((unit) => unit.file === "delfi-gtfs-rt/2026-10-20/12.seg.zst");
    expect(kept?.detail).toMatch(/13\.jsonl/);
  });

  it("lets a sameAs target go when the record naming it goes too and its bytes are archived", async () => {
    await record("delfi-gtfs-rt", [
      ["2026-10-20T10:01:20Z", A],
      ["2026-10-20T11:01:20Z", A],
      ["2026-10-20T11:02:20Z", B],
      ["2026-10-29T19:01:20Z", G],
    ]);
    await manifest("delfi-gtfs-rt", "2026-10-20", [A, B]);
    const plan = await planRetention({
      root,
      now: NOW,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence(),
    });
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/10.seg.zst")).toBe("deletable");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/11.seg.zst")).toBe("deletable");
  });

  it("accepts payloads processed into the database as recoverable", async () => {
    await scenario();
    const records = await readJsonLinesFile<{ object?: { id: string } }>(
      join(root, "gtfsde-rt/2026-10-21/10.jsonl"),
    );
    const id = records[0]?.object?.id ?? "";
    const plan = await planRetention({
      root,
      now: NOW,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence([id]),
    });
    const unit = plan.units.find(
      (candidate) => candidate.file === "gtfsde-rt/2026-10-21/10.seg.zst",
    );
    expect(unit?.reason).toBe("deletable");
    expect(unit?.evidence).toBe("processed");
  });

  it("never deletes the newest object of a source, which the live recorder dedups against", async () => {
    await record("delfi-gtfs-sa", [["2026-10-20T10:01:20Z", A]]);
    await manifest("delfi-gtfs-sa", "2026-10-20", [A]);
    const plan = await planRetention({
      root,
      now: NOW,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence(),
    });
    expect(reasonOf(plan, "delfi-gtfs-sa/2026-10-20/10.seg.zst")).toBe("newest");
  });

  it("protects a golden day in German local time too", async () => {
    await record("delfi-gtfs-rt", [
      ["2026-10-24T22:30:00Z", A],
      ["2026-10-29T19:00:00Z", G],
    ]);
    await manifest("delfi-gtfs-rt", "2026-10-25", [A, G]);
    const plan = await planRetention({
      root,
      now: NOW,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence(),
    });
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-24/22.seg.zst")).toBe("golden");
  });

  it("ignores a manifest that was not read to its end", async () => {
    await scenario();
    await writeFile(
      join(manifests, "delfi-gtfs-rt", "2026-10-20.jsonl"),
      `${JSON.stringify({ type: "snapshot", name: "x", at: "2026-10-20T10:01:01Z", sha256: sha(A), bytes: 1 })}\n`,
    );
    const plan = await planRetention({
      root,
      now: NOW,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence(),
    });
    expect(plan.totals.deletableFiles).toBe(0);
  });
});

async function editSidecar(file: string, edit: (lines: string[]) => string[]): Promise<void> {
  const path = join(root, file);
  const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
  await writeFile(path, `${edit(lines).join("\n")}\n`);
}

async function plainPlan(): Promise<Awaited<ReturnType<typeof planRetention>>> {
  return planRetention({
    root,
    now: NOW,
    keepDays: 3,
    goldenDays: golden,
    evidence: await evidence(),
  });
}

describe("planRetention with damaged or incomplete sidecars", () => {
  it("keeps every file of a sidecar hour that has an unreadable line", async () => {
    await record("delfi-gtfs-rt", [
      ["2026-10-20T10:01:20Z", A],
      ["2026-10-20T10:02:20Z", B],
      ["2026-10-20T10:03:20Z", C],
      ["2026-10-29T19:01:20Z", G],
    ]);
    await manifest("delfi-gtfs-rt", "2026-10-20", [A, B]);
    await editSidecar("delfi-gtfs-rt/2026-10-20/10.jsonl", (lines) =>
      lines.map((line, index) => (index === 2 ? "{not json" : line)),
    );
    const plan = await plainPlan();
    const unit = plan.units.find((u) => u.file === "delfi-gtfs-rt/2026-10-20/10.seg.zst");
    expect(unit?.reason).toBe("unindexed");
    expect(unit?.detail).toMatch(/damaged sidecar delfi-gtfs-rt\/2026-10-20\/10\.jsonl/);
    expect(plan.totals.deletableFiles).toBe(0);
  });

  it("keeps a segment whose frames are not all named by sidecar lines", async () => {
    await record("delfi-gtfs-rt", [
      ["2026-10-20T10:01:20Z", A],
      ["2026-10-20T10:02:20Z", B],
      ["2026-10-20T10:03:20Z", C],
      ["2026-10-29T19:01:20Z", G],
    ]);
    await manifest("delfi-gtfs-rt", "2026-10-20", [A, C]);
    await editSidecar("delfi-gtfs-rt/2026-10-20/10.jsonl", (lines) =>
      lines.filter((_, index) => index !== 1),
    );
    const plan = await plainPlan();
    const unit = plan.units.find((u) => u.file === "delfi-gtfs-rt/2026-10-20/10.seg.zst");
    expect(unit?.reason).toBe("unindexed");
    expect(unit?.detail).toMatch(/sidecar lines missing/);
  });

  it("keeps the object an unreadable sameAs line may name, in an earlier hour", async () => {
    await record("delfi-gtfs-rt", [
      ["2026-10-20T10:01:20Z", A],
      ["2026-10-20T11:00:20Z", A],
      ["2026-10-20T11:01:20Z", B],
      ["2026-10-29T19:01:20Z", G],
    ]);
    await manifest("delfi-gtfs-rt", "2026-10-20", [A, B]);
    await editSidecar("delfi-gtfs-rt/2026-10-20/11.jsonl", (lines) =>
      lines.map((line) => (line.includes('"sameAs"') ? line.slice(0, 40) : line)),
    );
    const plan = await plainPlan();
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/11.seg.zst")).toBe("unindexed");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/10.seg.zst")).toBe("same-as-target");
  });

  it("refuses to plan when the golden days file has an unreadable line", async () => {
    await markGoldenDay(root, "2026-11-02", "first week", new Date(NOW));
    await writeFile(join(root, "golden-days.jsonl"), '{"day":"2026-11-0', { flag: "a" });
    await writeFile(join(root, "golden-days.jsonl"), "\n", { flag: "a" });
    await expect(readGoldenDays(root)).rejects.toThrow(/golden-days\.jsonl.*line 2/);
  });
});

describe("planRetention keep rules", () => {
  it("judges sameAs lines after the newest object is kept, so its sidecar does not count as going", async () => {
    await record("delfi-gtfs-sa", [
      ["2026-10-20T10:01:20Z", A],
      ["2026-10-20T11:00:20Z", A],
      ["2026-10-20T11:01:20Z", B],
    ]);
    await manifest("delfi-gtfs-sa", "2026-10-20", [A, B]);
    const plan = await plainPlan();
    expect(reasonOf(plan, "delfi-gtfs-sa/2026-10-20/11.seg.zst")).toBe("newest");
    expect(reasonOf(plan, "delfi-gtfs-sa/2026-10-20/10.seg.zst")).toBe("same-as-target");
  });

  it("keeps a chain of sameAs targets until nothing changes", async () => {
    await record("delfi-gtfs-rt", [
      ["2026-10-20T10:01:20Z", A],
      ["2026-10-20T11:00:20Z", A],
      ["2026-10-20T11:01:20Z", B],
      ["2026-10-20T12:00:20Z", B],
      ["2026-10-20T12:01:20Z", C],
      ["2026-10-29T19:01:20Z", G],
    ]);
    await manifest("delfi-gtfs-rt", "2026-10-20", [A, B]);
    const plan = await plainPlan();
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/12.seg.zst")).toBe("not-recoverable");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/11.seg.zst")).toBe("same-as-target");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/10.seg.zst")).toBe("same-as-target");
  });

  it("keeps a file no sidecar line names", async () => {
    await record("delfi-gtfs-rt", [
      ["2026-10-20T10:01:20Z", A],
      ["2026-10-29T19:01:20Z", G],
    ]);
    await manifest("delfi-gtfs-rt", "2026-10-20", [A]);
    await writeFile(join(root, "delfi-gtfs-rt/2026-10-20/stray.bin"), "x");
    await writeFile(join(root, "delfi-gtfs-rt/2026-10-20/09.seg.zst"), "x");
    const plan = await plainPlan();
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/stray.bin")).toBe("unindexed");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/09.seg.zst")).toBe("unindexed");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/10.seg.zst")).toBe("deletable");
  });
});

describe("planRetention for writers, earlier applies and odd entries", () => {
  it("keeps archive and backfill writer files until they are processed", async () => {
    await record("delfi-gtfs-rt", [["2026-10-20T10:01:01Z", A]], "archive");
    await record("delfi-gtfs-rt", [["2026-10-20T11:01:01Z", B]], "backfill");
    await record("delfi-gtfs-rt", [["2026-10-29T19:01:20Z", G]]);
    await manifest("delfi-gtfs-rt", "2026-10-20", [A, B]);
    const plan = await plainPlan();
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/10.archive.seg.zst")).toBe("unprocessed");
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/11.backfill.seg.zst")).toBe("unprocessed");

    const ids: string[] = [];
    for (const name of ["10.archive.jsonl", "11.backfill.jsonl"]) {
      const lines = await readJsonLinesFile<{ object?: { id: string } }>(
        join(root, "delfi-gtfs-rt/2026-10-20", name),
      );
      ids.push(...lines.flatMap((line) => (line.object ? [line.object.id] : [])));
    }
    const done = await planRetention({
      root,
      now: NOW,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence(ids),
    });
    const unit = done.units.find((u) => u.file === "delfi-gtfs-rt/2026-10-20/10.archive.seg.zst");
    expect(unit).toMatchObject({ reason: "deletable", evidence: "processed" });
  });

  it("counts a file pruned by an earlier apply as gone when judging sameAs lines", async () => {
    await record("delfi-gtfs-rt", [
      ["2026-10-20T03:01:20Z", A],
      ["2026-10-20T04:00:20Z", A],
      ["2026-10-20T04:01:20Z", B],
      ["2026-10-29T19:01:20Z", G],
    ]);
    await manifest("delfi-gtfs-rt", "2026-10-20", [A, B]);
    await unlink(join(root, "delfi-gtfs-rt/2026-10-20/04.seg.zst"));
    await writeFile(
      join(root, RETENTION_JOURNAL),
      `${JSON.stringify({ v: 1, type: "pruned", file: "delfi-gtfs-rt/2026-10-20/04.seg.zst" })}\n`,
    );
    const plan = await plainPlan();
    expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/03.seg.zst")).toBe("deletable");
  });

  it("skips symlinked date folders and entries that are not regular files", async () => {
    await record("delfi-gtfs-rt", [
      ["2026-10-20T10:01:20Z", A],
      ["2026-10-29T19:01:20Z", G],
    ]);
    await manifest("delfi-gtfs-rt", "2026-10-20", [A]);
    const outside = await mkdtemp(join(tmpdir(), "gerlines-retention-outside-"));
    try {
      await writeFile(join(outside, "10.seg.zst"), "precious");
      await symlink(outside, join(root, "delfi-gtfs-rt/2026-10-19"));
      await mkdir(join(root, "delfi-gtfs-rt/2026-10-20/sub"));
      await symlink(join(outside, "10.seg.zst"), join(root, "delfi-gtfs-rt/2026-10-20/09.seg.zst"));
      const plan = await plainPlan();
      const files = plan.units.map((unit) => unit.file);
      expect(files.some((file) => file.includes("2026-10-19"))).toBe(false);
      expect(files).not.toContain("delfi-gtfs-rt/2026-10-20/sub");
      expect(files).not.toContain("delfi-gtfs-rt/2026-10-20/09.seg.zst");
      expect(reasonOf(plan, "delfi-gtfs-rt/2026-10-20/10.seg.zst")).toBe("deletable");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("applyRetention", () => {
  it("deletes exactly the planned segments, journals each first, and keeps every sidecar", async () => {
    await scenario();
    const plan = await planRetention({
      root,
      now: NOW,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence(),
    });
    const before = await readdir(join(root, "delfi-gtfs-rt/2026-10-20"));
    const result = await applyRetention(
      root,
      plan,
      new Date(NOW),
      "0199f000-0000-7000-8000-00000000aaaa",
    );
    expect(result.deleted.map((unit) => unit.file)).toEqual([
      "delfi-gtfs-rt/2026-10-20/10.seg.zst",
    ]);
    const after = await readdir(join(root, "delfi-gtfs-rt/2026-10-20"));
    expect(before.filter((name) => !after.includes(name))).toEqual(["10.seg.zst"]);
    expect(after.filter((name) => name.endsWith(".jsonl")).sort()).toEqual([
      "10.jsonl",
      "11.jsonl",
      "12.jsonl",
      "13.jsonl",
    ]);
    const journal = await readJsonLinesFile<{ file: string; sha256: string; objects: number }>(
      join(root, RETENTION_JOURNAL),
    );
    expect(journal.map((line) => line.file).sort()).toEqual(
      result.deleted.map((unit) => unit.file).sort(),
    );
    expect(await readPrunedFiles(root)).toEqual(new Set(journal.map((line) => line.file)));

    const verify = await verifySource(root, "delfi-gtfs-rt");
    expect(verify.errors).toEqual([]);
    expect(verify.mismatched).toEqual([]);
    expect(verify.pruned).toBe(2);
  });

  it("never deletes through a symlink that replaced a planned file", async () => {
    await scenario();
    const plan = await plainPlan();
    const outside = await mkdtemp(join(tmpdir(), "gerlines-retention-outside-"));
    try {
      const planned = join(root, "delfi-gtfs-rt/2026-10-20/10.seg.zst");
      const size = (await stat(planned)).size;
      await writeFile(join(outside, "victim"), Buffer.alloc(size));
      await unlink(planned);
      await symlink(join(outside, "victim"), planned);
      const result = await applyRetention(root, plan, new Date(NOW), "run");
      expect(result.deleted).toEqual([]);
      expect(result.skipped).toEqual([
        { file: "delfi-gtfs-rt/2026-10-20/10.seg.zst", why: "not a regular file" },
      ]);
      expect((await stat(join(outside, "victim"))).size).toBe(size);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a plan made for another time than now", async () => {
    await scenario();
    const plan = await planRetention({
      root,
      now: NOW + 3 * DAY_MS,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence(),
    });
    await expect(applyRetention(root, plan, new Date(NOW), "run")).rejects.toThrow(/as of/);
  });

  it("re-checks each file before deleting it and skips one that changed since the plan", async () => {
    await scenario();
    const plan = await planRetention({
      root,
      now: NOW,
      keepDays: 3,
      goldenDays: golden,
      evidence: await evidence(),
    });
    const changed = join(root, "delfi-gtfs-rt/2026-10-20/10.seg.zst");
    await writeFile(
      changed,
      Buffer.concat([Buffer.alloc((await stat(changed)).size), Buffer.from("x")]),
    );
    const result = await applyRetention(root, plan, new Date(NOW), "run");
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([
      { file: "delfi-gtfs-rt/2026-10-20/10.seg.zst", why: "size changed since the plan" },
    ]);
  });
});

describe("golden days", () => {
  it("are the configured G1 days plus the days marked in the recordings folder", async () => {
    expect(CONFIGURED_GOLDEN_DAYS.get("2026-10-25")).toMatch(/G1/);
    expect(CONFIGURED_GOLDEN_DAYS.get("2026-10-26")).toBeDefined();
    await markGoldenDay(root, "2026-11-02", "first week of WP-2.3b live", new Date(NOW));
    const days = await readGoldenDays(root);
    expect([...days.keys()].sort()).toEqual(["2026-10-25", "2026-10-26", "2026-11-02"]);
    await expect(markGoldenDay(root, "2026-13-40", "bad", new Date(NOW))).rejects.toThrow(
      /YYYY-MM-DD/,
    );
  });
});
