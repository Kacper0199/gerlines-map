import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import {
  listSidecars,
  readFetchRecords,
  readSegmentPayloads,
} from "../../../services/ingest/src/storage/reader.ts";
import type { FetchRecord } from "../../../services/ingest/src/storage/sidecar.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    source: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    "every-min": { type: "string", default: "5" },
    out: { type: "string" },
  },
});

const root = values.root ?? "";
const source = values.source ?? "";
const from = Date.parse(values.from ?? "");
const to = Date.parse(values.to ?? "");
const everyMs = Number(values["every-min"]) * 60_000;
const out = join(values.out ?? "", source);
if (!root || !source || Number.isNaN(from) || Number.isNaN(to) || !values.out) {
  throw new Error("usage: --root DIR --source ID --from ISO --to ISO [--every-min N] --out DIR");
}

const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

const sinceDate = new Date(from - 86_400_000).toISOString().slice(0, 10);
const sidecars = await listSidecars(root, source, sinceDate);
const records = (await readFetchRecords(root, sidecars)).filter(
  (record) => record.object?.file && record.status === 200,
);
const usable = records
  .filter((record) => {
    const at = Date.parse(record.observedAt);
    return at >= from - everyMs && at < to + everyMs;
  })
  .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

const chosen = new Map<string, FetchRecord>();
for (let tick = from; tick < to; tick += everyMs) {
  const pick = usable.find((record) => {
    const at = Date.parse(record.observedAt);
    return at >= tick && at < tick + everyMs;
  });
  if (pick?.object?.key) chosen.set(pick.object.key, pick);
}

await mkdir(out, { recursive: true });
const lines = ["tick_observed_at,header_timestamp,bytes,sha256,key,file"];
const segments = [...new Set([...chosen.values()].map((record) => record.object?.file ?? ""))];
for (const segment of segments) {
  const inSegment = records.filter((record) => record.object?.file === segment);
  for await (const { record, payload } of readSegmentPayloads(root, segment, inSegment)) {
    const key = record.object?.key ?? "";
    if (!chosen.has(key)) continue;
    const name = `${stamp(record.observedAt)}.pb.gz`;
    await writeFile(join(out, name), gzipSync(payload, { level: 3 }));
    lines.push(
      [
        record.observedAt,
        record.feed?.headerTimestamp ?? "",
        payload.length,
        record.sha256 ?? "",
        key,
        name,
      ].join(","),
    );
    chosen.delete(key);
    if (![...chosen.values()].some((r) => r.object?.file === segment)) break;
  }
}
await writeFile(join(out, "index.csv"), `${lines.join("\n")}\n`);
process.stdout.write(`${source}: ${lines.length - 1} payloads written to ${out}\n`);
