import { encodeHead } from "@gerlines/live-frame";
import { type Context, Hono } from "hono";
import { binaryHeaders, IMMUTABLE, notFound, objectResponse } from "../server/app.ts";
import { headForInstant, type PlaybackCache } from "./cache.ts";
import type { PlaybackRenderer } from "./renderer.ts";
import { checkWindow, DEFAULT_LIMITS, type PlaybackLimits, parseWindowStart } from "./window.ts";

export interface PlaybackAppOptions {
  readonly cache: PlaybackCache;
  /** Renders a missing window on request (local use); null serves only what is rendered. */
  readonly renderer: PlaybackRenderer | null;
  readonly limits?: PlaybackLimits;
  /** Unix seconds. */
  readonly now: () => number;
}

const INDEX_CACHE = "public, max-age=60";
const REVISION = /^[0-9a-f]{12}$/;
const SEQUENCE = /^[1-9]\d{0,9}$/;
const INSTANT = /^[1-9]\d{9}$/;
const RENDER_RETRY_SECONDS = 30;
const BUSY_RETRY_SECONDS = 60;

function failure(
  c: Context,
  status: 400 | 202 | 404 | 503,
  code: string,
  message: string,
  retryAfter?: number,
) {
  c.header("Cache-Control", "no-store");
  c.header("Access-Control-Allow-Origin", "*");
  if (retryAfter !== undefined) c.header("Retry-After", String(retryAfter));
  return c.json({ error: { code, message } }, status);
}

/**
 * The `/playback/v1/*` routes over rendered windows (ADR-0014 draft): the list, a window's index,
 * the head of any instant, and keyframes and deltas under the window's revision, in the live
 * format, so the client decoder and catch-up rules are the same. Shape packs stay at `/live/v1/s/`.
 */
export function createPlaybackApp(options: PlaybackAppOptions): Hono {
  const { cache, renderer, now } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const app = new Hono();

  app.get("/playback/v1/windows", async (c) => {
    const at = now();
    const windows = (await cache.list())
      .filter((index) => checkWindow(index.start, at, limits).ok)
      .map(({ start, end, revision, shapeEpoch }) => ({ start, end, revision, shapeEpoch }));
    c.header("Cache-Control", INDEX_CACHE);
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ data: { windows, limits } });
  });

  app.get("/playback/v1/w/:start", async (c) => {
    const start = parseWindowStart(c.req.param("start"));
    if (start === null) return failure(c, 400, "INVALID_WINDOW", "a window is named by its start");
    const check = checkWindow(start, now(), limits);
    if (!check.ok) return failure(c, 400, check.code, check.message);
    const index = await cache.index(start);
    if (index) {
      c.header("Cache-Control", INDEX_CACHE);
      c.header("Access-Control-Allow-Origin", "*");
      return c.json({ data: index });
    }
    if (!renderer) return failure(c, 404, "NOT_RENDERED", "this window is not rendered");
    const request = renderer.request(check.start, check.end);
    if (request.status === "busy") {
      return failure(c, 503, "BUSY", "other windows are rendering", BUSY_RETRY_SECONDS);
    }
    return failure(c, 202, "RENDERING", "this window is rendering", RENDER_RETRY_SECONDS);
  });

  const servedIndex = async (startText: string, revision: string) => {
    const start = parseWindowStart(startText);
    if (start === null || !REVISION.test(revision)) return null;
    if (!checkWindow(start, now(), limits).ok) return null;
    return cache.revisionIndex(start, revision);
  };

  app.get("/playback/v1/w/:start/:revision/head", async (c) => {
    const index = await servedIndex(c.req.param("start"), c.req.param("revision"));
    if (!index) return notFound();
    const atText = c.req.query("at") ?? "";
    const at = INSTANT.test(atText) ? Number(atText) : Number.NaN;
    if (!(at >= index.start && at <= index.end)) {
      return failure(c, 400, "INVALID_INSTANT", "at takes Unix seconds inside the window");
    }
    const head = headForInstant(index.heads, at, index.end);
    if (!head) return notFound();
    return new Response(new Uint8Array(encodeHead(head)), {
      status: 200,
      headers: binaryHeaders(IMMUTABLE),
    });
  });

  app.get("/playback/v1/w/:start/:revision/:kind{k|d}/:file", async (c) => {
    const index = await servedIndex(c.req.param("start"), c.req.param("revision"));
    if (!index) return notFound();
    const file = c.req.param("file");
    const sequence = file.endsWith(".bin") ? file.slice(0, -4) : "";
    if (!SEQUENCE.test(sequence)) return notFound();
    return objectResponse(
      cache.reader(index.start, index.revision),
      `${c.req.param("kind")}/${sequence}.bin`,
      c.req.header("accept-encoding"),
    );
  });

  return app;
}
