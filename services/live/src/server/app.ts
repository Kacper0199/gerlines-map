import { Hono } from "hono";
import type { FileStore } from "../publish/storage.ts";

/** What the HTTP app needs from a store: bytes by relative path (a replay joins two stores). */
export type ObjectSource = Pick<FileStore, "read">;

export const IMMUTABLE = "public, max-age=31536000, immutable";
const SEQUENCE = /^[1-9]\d{0,9}$/;
const EPOCH = /^\d{1,10}$/;
const PART = /^(?:0|[1-9]\d?)$/;
const PACK_NAME = /^(?:\d{1,10}|[0-9a-f]{16})$/;

type Encoding = "br" | "gzip" | null;

/** The encoding FORMAT.md section 7 asks for: brotli when accepted, else gzip, else none. */
export function chooseEncoding(acceptEncoding: string | undefined): Encoding {
  const accepted = new Map<string, number>();
  for (const part of (acceptEncoding ?? "").split(",")) {
    const [name = "", ...parameters] = part.trim().toLowerCase().split(";");
    const q = parameters.map((p) => p.trim()).find((p) => p.startsWith("q="));
    accepted.set(name.trim(), q ? Number(q.slice(2)) : 1);
  }
  const allows = (name: string) => (accepted.get(name) ?? accepted.get("*") ?? 0) > 0;
  if (allows("br")) return "br";
  if (allows("gzip")) return "gzip";
  return null;
}

export function binaryHeaders(cacheControl: string): Record<string, string> {
  return {
    "Content-Type": "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cacheControl,
    "Access-Control-Allow-Origin": "*",
  };
}

/** An immutable object of `store` in the encoding the request accepts (FORMAT.md section 7). */
export async function objectResponse(
  store: ObjectSource,
  relative: string,
  acceptEncoding: string | undefined,
): Promise<Response> {
  const encoding = chooseEncoding(acceptEncoding);
  const suffix = encoding === "br" ? ".br" : encoding === "gzip" ? ".gz" : "";
  const bytes = await store.read(`${relative}${suffix}`);
  if (!bytes) return notFound();
  const headers: Record<string, string> = {
    ...binaryHeaders(IMMUTABLE),
    Vary: "Accept-Encoding",
  };
  if (encoding) headers["Content-Encoding"] = encoding;
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

/**
 * The newest head's bytes in memory, set by whoever publishes heads: a request for the head is
 * answered from it without touching the disk or the thread pool the compression of frames uses.
 */
export class HeadBuffer {
  #bytes: Uint8Array | null = null;

  set(bytes: Uint8Array): void {
    this.#bytes = Uint8Array.from(bytes);
  }

  current(): Uint8Array | null {
    return this.#bytes;
  }
}

/** How long the engine may go without a tick before the health check says so. */
export const ENGINE_STALL_MS = 30_000;

/** When the engine last finished a tick, counted from its creation until the first. */
export class EngineHeartbeat {
  readonly #now: () => number;
  #last: number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#last = now();
  }

  beat(): void {
    this.#last = this.#now();
  }

  silentMs(): number {
    return this.#now() - this.#last;
  }
}

export interface LiveServing {
  /** The newest head in memory; without it the head is read from the store. */
  readonly head?: Pick<HeadBuffer, "current">;
  /** The engine's ticks; with it the health check fails after `engineStallMs` without one. */
  readonly engine?: Pick<EngineHeartbeat, "silentMs">;
  readonly engineStallMs?: number;
}

function headResponse(bytes: Uint8Array | null): Response {
  if (!bytes) return notFound();
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...binaryHeaders("public, max-age=1"), Vary: "Accept-Encoding" },
  });
}

/**
 * Serves the published objects with the headers of FORMAT.md section 7: pre-compressed bytes chosen
 * by Accept-Encoding, `Vary: Accept-Encoding`, immutable caching, and the head with max-age 1, from
 * `serving.head` when given, else from the store. Paths are matched against fixed patterns, so no
 * request names a file outside the store.
 */
export function createLiveApp(store: ObjectSource, serving: LiveServing = {}): Hono {
  const { head, engine, engineStallMs = ENGINE_STALL_MS } = serving;
  const app = new Hono();
  const serveObject = (relative: string, acceptEncoding: string | undefined) =>
    objectResponse(store, relative, acceptEncoding);

  app.get("/live/v1/head", async () => {
    if (head) return headResponse(head.current());
    const bytes = await store.read("head");
    return headResponse(bytes ? new Uint8Array(bytes) : null);
  });

  app.get("/live/v1/:kind{k|d}/:file", (c) => {
    const file = c.req.param("file");
    const sequence = file.endsWith(".bin") ? file.slice(0, -4) : "";
    if (!SEQUENCE.test(sequence)) return notFound();
    return serveObject(`${c.req.param("kind")}/${sequence}.bin`, c.req.header("accept-encoding"));
  });

  app.get("/live/v1/s/:epoch/:file", (c) => {
    const epoch = c.req.param("epoch");
    const file = c.req.param("file");
    const name = file.endsWith(".bin") ? file.slice(0, -4) : "";
    if (!EPOCH.test(epoch) || !PACK_NAME.test(name)) return notFound();
    return serveObject(`s/${epoch}/${name}.bin`, c.req.header("accept-encoding"));
  });

  app.get("/live/v1/sets/:epoch/b/:id/:file", (c) => {
    const { epoch, id, file } = c.req.param();
    const index = file.endsWith(".bin") ? file.slice(0, -4) : "";
    if (!(EPOCH.test(epoch) && SEQUENCE.test(id) && PART.test(index))) return notFound();
    return serveObject(`sets/${epoch}/b/${id}/${index}.bin`, c.req.header("accept-encoding"));
  });

  app.get("/live/v1/sets/:epoch/i/:file", (c) => {
    const { epoch, file } = c.req.param();
    const id = file.endsWith(".bin") ? file.slice(0, -4) : "";
    if (!(EPOCH.test(epoch) && SEQUENCE.test(id))) return notFound();
    return serveObject(`sets/${epoch}/i/${id}.bin`, c.req.header("accept-encoding"));
  });

  app.get("/healthz", (c) => {
    const silentMs = engine?.silentMs() ?? 0;
    if (silentMs <= engineStallMs) return c.json({ ok: true });
    c.header("Cache-Control", "no-store");
    return c.json({ ok: false, engineSilentS: Math.floor(silentMs / 1000) }, 503);
  });
  app.notFound(() => notFound());
  app.onError((error, c) => {
    process.stderr.write(
      `${JSON.stringify({ level: "error", msg: "request failed", error: String(error).slice(0, 200) })}\n`,
    );
    return c.json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
  });
  return app;
}

export function notFound(): Response {
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such object" } }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1" },
  });
}

/**
 * What `live run` serves while it waits for the packs of its shape epoch: 503 with
 * the reason on every path, so a health probe can tell waiting from a crashed process.
 */
export function createWaitingApp(epoch: number) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: false, waitingFor: "packs", epoch }, 503));
  app.all("*", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        error: {
          code: "WAITING_FOR_PACKS",
          message: `waiting for the packs of shape epoch ${epoch}`,
        },
      },
      503,
    );
  });
  return app;
}
