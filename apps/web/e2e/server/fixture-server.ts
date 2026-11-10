import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = join(HERE, "..", "fixture", "data");
const DEFAULT_DIST = join(HERE, "..", "..", "dist");

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

export interface FixtureServerOptions {
  readonly port: number;
  readonly dist?: string;
}

export interface Unmatched {
  readonly test: string;
  readonly request: string;
}

export interface FixtureServer {
  readonly origin: string;
  readonly unmatched: Unmatched[];
  close(): Promise<void>;
}

type Miss = (request: string) => void;

function send(
  response: ServerResponse,
  status: number,
  body: Buffer | string,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { "Cache-Control": "no-store", ...headers });
  response.end(body);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  send(response, status, JSON.stringify(value), { "Content-Type": "application/json", ...headers });
}

function readIfFile(path: string): Buffer | null {
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null;
}

function within(root: string, relative: string): string | null {
  const full = normalize(join(root, relative));
  return full === root || full.startsWith(root + sep) ? full : null;
}

const TEST_HEADER = "x-e2e-test";
const NUMBER = /^\d{1,10}$/;
const UUID = /^[0-9a-f-]{36}$/;

function live(path: string, response: ServerResponse): boolean {
  const base = join(FIXTURE, "live");
  const relative =
    path === "/live/v1/head"
      ? "head"
      : /^\/live\/v1\/k\/\d+\.bin$/.test(path) || /^\/live\/v1\/s\/\d+\/\d+\.bin$/.test(path)
        ? path.slice("/live/v1/".length)
        : null;
  const file = relative === null ? null : within(base, relative);
  const bytes = file === null ? null : readIfFile(file);
  if (!bytes) {
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "no such object" } });
    return true;
  }
  send(response, 200, bytes, { "Content-Type": "application/octet-stream" });
  return true;
}

function search(url: URL, response: ServerResponse): boolean {
  if (url.pathname !== "/api/v1/search") return false;
  const query = (url.searchParams.get("q") ?? "").toLowerCase();
  const lang = url.searchParams.get("lang") ?? "en";
  const file = /^[\p{L}\p{N} -]{1,64}$/u.test(query)
    ? within(join(FIXTURE, "api", "search"), `${lang}-${query}.json`)
    : null;
  const bytes = file === null ? null : readIfFile(file);
  if (!bytes) return false;
  send(response, 200, bytes, { "Content-Type": "application/json" });
  return true;
}

function api(path: string, response: ServerResponse): boolean {
  const key = /^\/api\/v1\/live\/keys\/(\d+)$/.exec(path)?.[1];
  if (key !== undefined && NUMBER.test(key)) {
    const bytes = readIfFile(join(FIXTURE, "api", "keys", `${key}.json`));
    if (!bytes) sendJson(response, 404, { error: "not_found" });
    else send(response, 200, bytes, { "Content-Type": "application/json" });
    return true;
  }
  const train = /^\/api\/v1\/trains\/([0-9a-f-]+)$/.exec(path)?.[1];
  if (train !== undefined && UUID.test(train)) {
    const bytes = readIfFile(join(FIXTURE, "api", "trains", `${train}.json`));
    if (!bytes) {
      sendJson(response, 404, { error: "not_found" });
      return true;
    }
    const detail = JSON.parse(bytes.toString("utf8")) as { frameKey: number | null };
    const frameKey = frameKeyOf(train);
    sendJson(response, 200, { ...detail, frameKey }, { ETag: `"${train}"` });
    return true;
  }
  return false;
}

function frameKeyOf(tripInstanceId: string): number | null {
  const names = readdirSync(join(FIXTURE, "api", "keys")).filter((name) => name.endsWith(".json"));
  for (const name of names) {
    const pair = JSON.parse(readFileSync(join(FIXTURE, "api", "keys", name), "utf8")) as {
      tripInstanceId: string;
    };
    if (pair.tripInstanceId === tripInstanceId) return Number(name.replace(".json", ""));
  }
  return null;
}

function tileJson(origin: string, response: ServerResponse): void {
  const description = JSON.parse(
    readFileSync(join(FIXTURE, "basemap", "tiles.json"), "utf8"),
  ) as Record<string, unknown>;
  sendJson(response, 200, { ...description, tiles: [`${origin}/basemap/tiles/{z}/{x}/{y}.pbf`] });
}

function tile(match: RegExpExecArray, response: ServerResponse, miss: Miss): void {
  const [, z, x, y] = match as unknown as [string, string, string, string];
  const bytes = readIfFile(join(FIXTURE, "basemap", "tiles", z, x, `${y}.pbf`));
  if (!bytes) miss(`tile ${z}/${x}/${y}`);
  const headers = { "Content-Type": "application/x-protobuf" };
  send(
    response,
    200,
    bytes ?? Buffer.alloc(0),
    bytes ? { ...headers, "Content-Encoding": "gzip" } : headers,
  );
}

function glyphs(match: RegExpExecArray, response: ServerResponse, miss: Miss): void {
  const [, encoded, range] = match as unknown as [string, string, string];
  const stack = safeDecode(encoded);
  const file =
    stack === null ? null : within(join(FIXTURE, "basemap", "fonts"), join(stack, `${range}.pbf`));
  const bytes = file === null ? null : readIfFile(file);
  if (!bytes) miss(`glyphs ${encoded} ${range}`);
  send(response, 200, bytes ?? Buffer.alloc(0), { "Content-Type": "application/x-protobuf" });
}

function basemap(path: string, origin: string, response: ServerResponse, miss: Miss): boolean {
  if (!path.startsWith("/basemap/")) return false;
  const tileMatch = /^\/basemap\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(path);
  const glyphMatch = /^\/basemap\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/.exec(path);
  if (path === "/basemap/tiles.json") tileJson(origin, response);
  else if (tileMatch) tile(tileMatch, response, miss);
  else if (glyphMatch) glyphs(glyphMatch, response, miss);
  else sendJson(response, 404, { error: "not_found" });
  return true;
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function assets(dist: string, path: string, response: ServerResponse): void {
  const relative = safeDecode(path === "/" ? "/index.html" : path);
  if (relative === null) {
    send(response, 400, "bad request", { "Content-Type": "text/plain" });
    return;
  }
  const file = within(dist, relative.slice(1));
  const bytes = file === null ? null : readIfFile(file);
  if (bytes && file) {
    send(response, 200, bytes, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    });
    return;
  }
  const index = readIfFile(join(dist, "index.html"));
  if (!index || extname(relative) !== "") {
    send(response, 404, "not found", { "Content-Type": "text/plain" });
    return;
  }
  send(response, 200, index, { "Content-Type": TYPES[".html"] as string });
}

function answerApi(url: URL, response: ServerResponse, miss: () => void): void {
  if (search(url, response) || api(url.pathname, response)) return;
  miss();
  sendJson(response, 404, { error: "not_found" });
}

function control(
  url: URL,
  unmatched: readonly Unmatched[],
  dist: string,
  response: ServerResponse,
): boolean {
  if (url.pathname === "/__e2e/info") {
    sendJson(response, 200, { dist });
    return true;
  }
  if (url.pathname !== "/__e2e/unmatched") return false;
  const wanted = url.searchParams.get("test");
  const tiles = url.searchParams.get("kind") === "tile";
  sendJson(
    response,
    200,
    unmatched
      .filter((entry) => entry.test === wanted && entry.request.startsWith("tile ") === tiles)
      .map((entry) => entry.request),
  );
  return true;
}

export function startFixtureServer(options: FixtureServerOptions): Promise<FixtureServer> {
  const dist = (options.dist ?? DEFAULT_DIST).replace(/\/$/, "");
  const unmatched: Unmatched[] = [];
  const origin = `http://127.0.0.1:${options.port}`;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", origin);
    const miss: Miss = (what) =>
      unmatched.push({ test: String(request.headers[TEST_HEADER] ?? ""), request: what });
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "method_not_allowed" });
    } else if (control(url, unmatched, dist, response)) {
      return;
    } else if (url.pathname.startsWith("/live/v1/")) {
      live(url.pathname, response);
    } else if (url.pathname.startsWith("/api/v1/")) {
      answerApi(url, response, () => miss(`${request.method} ${request.url}`));
    } else if (!basemap(url.pathname, origin, response, miss)) {
      assets(dist, url.pathname, response);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () =>
      resolve({
        origin,
        unmatched,
        close: () => new Promise((done) => server.close(() => done())),
      }),
    );
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.E2E_PORT ?? 8818);
  const server = await startFixtureServer({ port });
  process.stdout.write(`fixture server on ${server.origin}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void server.close().then(() => process.exit(0)));
  }
}
