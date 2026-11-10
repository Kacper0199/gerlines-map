import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const DIST = resolve(
  process.env.DIST ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist"),
);
const html = readFileSync(join(DIST, "index.html"), "utf8");
const paths = [
  ...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g),
  ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g),
].map((match) => match[1]);

const total = { raw: 0, gzip: 0, brotli: 0 };
const rows = [];
for (const path of paths) {
  const raw = readFileSync(join(DIST, path));
  const row = {
    file: path.replace(/^\/assets\//, ""),
    raw: raw.length,
    gzip: gzipSync(raw, { level: 9 }).length,
    brotli: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
  rows.push(row);
  for (const key of Object.keys(total)) total[key] += row[key];
}
rows.sort((a, b) => b.gzip - a.gzip);
for (const row of rows) {
  process.stdout.write(
    `${String(row.gzip).padStart(8)} gzip ${String(row.brotli).padStart(8)} br ${String(row.raw).padStart(8)} raw  ${row.file}\n`,
  );
}
process.stdout.write(
  `${rows.length} files: raw ${total.raw}, gzip ${total.gzip}, brotli ${total.brotli}\n`,
);
