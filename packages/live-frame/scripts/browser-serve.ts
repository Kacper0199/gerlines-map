import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { encodeKeyframe } from "../src/index.ts";
import { syntheticKeyframe } from "./synthetic.ts";

const HELP = `Usage: node scripts/browser-serve.ts [--port 4317]

Serves browser/index.html, which decodes every golden vector in a module Web Worker and times
keyframe decoding there. Open http://127.0.0.1:<port>/ in Chromium and read #result or the title.`;

const { values } = parseArgs({
  options: { port: { type: "string", default: "4317" }, help: { type: "boolean", default: false } },
});
if (values.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const SERVED = ["browser", "src", "test", "test-vectors"];
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".bin": "application/octet-stream",
  ".ts": "text/javascript; charset=utf-8",
};
const TIME_BASE = Date.UTC(2026, 9, 27, 7, 0, 0) / 1000;
const bench = new Map(
  [3000, 15000].map((trips) => [
    `/bench/keyframe-${trips}.bin`,
    encodeKeyframe(
      syntheticKeyframe({ trips, seed: 20261025, timeBase: TIME_BASE, numbered: true }),
    ),
  ]),
);

async function body(path: string): Promise<Uint8Array | string | undefined> {
  const generated = bench.get(path);
  if (generated) return generated;
  const file = normalize(path === "/" ? "browser/index.html" : path.slice(1));
  if (file.startsWith("..") || !SERVED.includes(file.split(sep)[0] ?? "")) return undefined;
  const source = await readFile(`${root}${file}`).catch(() => undefined);
  if (!source || extname(file) !== ".ts") return source;
  return stripTypeScriptTypes(source.toString("utf8"));
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  body(path).then(
    (content) => {
      if (content === undefined) {
        response.writeHead(404).end();
        return;
      }
      const type = path.startsWith("/bench/") ? ".bin" : extname(path) || ".html";
      response.writeHead(200, { "content-type": TYPES[type] ?? "application/octet-stream" });
      response.end(content);
    },
    () => response.writeHead(500).end(),
  );
});
server.listen(Number(values.port), "127.0.0.1", () => {
  process.stdout.write(`http://127.0.0.1:${values.port}/\n`);
});
