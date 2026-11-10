import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createSecureServer } from "node:http2";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync, zstdCompressSync } from "node:zlib";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(process.env.DIST ?? join(HERE, "..", "dist"));
const PORT = Number(process.env.PORT ?? 5193);
const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 8813);
const PROTOCOL = process.env.PROTOCOL ?? "h2";
const ENCODING = process.env.ENCODING ?? "zstd3";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
};
const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".css",
  ".json",
  ".geojson",
  ".svg",
  ".map",
  ".wasm",
]);
const compressed = new Map();

function accepts(accept, kind) {
  return accept.split(",").some((entry) => {
    const [name, ...parameters] = entry.trim().split(";");
    if (name?.trim().toLowerCase() !== kind) return false;
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => /^q=/i.test(parameter));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

function pick(accept) {
  if (ENCODING === "br11" && accepts(accept, "br")) return "br";
  if (accepts(accept, "zstd")) return "zstd";
  return accepts(accept, "gzip") ? "gzip" : null;
}

function encode(kind, raw) {
  if (kind === "br") {
    return brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  }
  if (kind === "zstd") {
    const level = ENCODING === "zstd19" ? 19 : 3;
    return zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: level } });
  }
  return gzipSync(raw);
}

const EXTENSIONS = { br: ".br", zstd: ".zst", gzip: ".gz" };

function precompressedBody(file, accept) {
  for (const kind of ["br", "zstd", "gzip"]) {
    const copy = file + EXTENSIONS[kind];
    if (accepts(accept, kind) && existsSync(copy)) {
      return { bytes: readFileSync(copy), encoding: kind };
    }
  }
  return { bytes: readFileSync(file), encoding: null };
}

function body(file, accept) {
  if (ENCODING === "precompressed") return precompressedBody(file, accept);
  const kind = COMPRESSIBLE.has(extname(file)) ? pick(accept) : null;
  const key = `${file}|${kind}`;
  let hit = compressed.get(key);
  if (!hit) {
    const raw = readFileSync(file);
    hit = { bytes: kind ? encode(kind, raw) : raw, encoding: kind };
    compressed.set(key, hit);
  }
  return hit;
}

function forward(request, response) {
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(
      ([name]) => !name.startsWith(":") && name !== "connection",
    ),
  );
  const upstream = httpRequest(
    { host: "127.0.0.1", port: FIXTURE_PORT, path: request.url, method: request.method, headers },
    (answer) => {
      const keep = Object.entries(answer.headers).filter(
        ([name]) =>
          !["connection", "keep-alive", "transfer-encoding", "content-length"].includes(name),
      );
      response.writeHead(answer.statusCode ?? 502, Object.fromEntries(keep));
      if (request.url !== "/basemap/tiles.json") {
        answer.pipe(response);
        return;
      }
      const chunks = [];
      answer.on("data", (chunk) => chunks.push(chunk));
      answer.on("end", () => {
        const own = `${PROTOCOL === "h2" ? "https" : "http"}://127.0.0.1:${PORT}`;
        response.end(
          Buffer.concat(chunks)
            .toString("utf8")
            .replaceAll(`http://127.0.0.1:${FIXTURE_PORT}`, own),
        );
      });
    },
  );
  upstream.on("error", () => {
    response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
}

function handle(request, response) {
  const url = new URL(request.url, "http://x");
  const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = normalize(join(DIST, relative));
  if (file.startsWith(DIST + sep) && existsSync(file) && statSync(file).isFile()) {
    const hit = body(file, String(request.headers["accept-encoding"] ?? ""));
    const headers = {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      Vary: "Accept-Encoding",
      "Content-Length": hit.bytes.length,
      "Cache-Control": relative.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
    if (hit.encoding) headers["Content-Encoding"] = hit.encoding;
    response.writeHead(200, headers);
    response.end(hit.bytes);
    return;
  }
  forward(request, response);
}

function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "gerlines-delivery-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "2",
    ].concat(["-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]),
    { stdio: "ignore" },
  );
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const { startFixtureServer } = await import("../e2e/server/fixture-server.ts");
await startFixtureServer({ port: FIXTURE_PORT, dist: DIST });
const server =
  PROTOCOL === "h2"
    ? createSecureServer({ ...certificate(), allowHTTP1: true }, handle)
    : createServer(handle);
server.listen(PORT, "127.0.0.1", () => {
  const scheme = PROTOCOL === "h2" ? "https" : "http";
  process.stdout.write(
    `delivery server ${scheme}://127.0.0.1:${PORT} (${ENCODING}) from ${DIST}\n`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => process.exit(0));
}
