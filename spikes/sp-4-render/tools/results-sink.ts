import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";

export const RESULTS_PREFIX = "/__results/";
export const TOKEN_HEADER = "x-sp4-token";
export const ENABLE_FLAG = "SP4_RESULTS_SINK";
export const TOKEN_VARIABLE = "SP4_SINK_TOKEN";
export const MAX_BODY_BYTES = 1024 * 1024;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ndjson$/;
const MIN_TOKEN_LENGTH = 32;

export function isSafeResultName(name: string): boolean {
  return SAFE_NAME.test(name);
}

export function exceedsBodyLimit(bytes: number): boolean {
  return bytes > MAX_BODY_BYTES;
}

export type SinkDecision =
  | { kind: "skip" }
  | { kind: "accept"; name: string }
  | { kind: "reject"; status: number; reason: string };

export interface SinkRequestHead {
  method?: string | undefined;
  url?: string | undefined;
  headers: IncomingHttpHeaders;
}

function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function resultName(url: string): string | null {
  const path = url.split("?", 1)[0] ?? "";
  try {
    return decodeURIComponent(path.slice(RESULTS_PREFIX.length));
  } catch {
    return null;
  }
}

export function checkSinkRequest(request: SinkRequestHead, token: string): SinkDecision {
  const url = request.url ?? "";
  if (request.method !== "POST" || !url.startsWith(RESULTS_PREFIX)) return { kind: "skip" };
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") {
    return { kind: "reject", status: 403, reason: "cross-site request" };
  }
  if (!tokenMatches(request.headers[TOKEN_HEADER], token)) {
    return { kind: "reject", status: 403, reason: "missing or wrong token" };
  }
  const name = resultName(url);
  if (name === null || !isSafeResultName(name)) {
    return { kind: "reject", status: 400, reason: "bad name" };
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (exceedsBodyLimit(declared)) return { kind: "reject", status: 413, reason: "body too large" };
  return { kind: "accept", name };
}

function reply(response: ServerResponse, status: number, text = ""): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.end(text);
}

export interface SinkOptions {
  directory: string;
  token: string;
}

export function createSinkHandler(options: SinkOptions) {
  const directory = resolve(options.directory);
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const decision = checkSinkRequest(request, options.token);
    if (decision.kind === "skip") {
      next();
      return;
    }
    if (decision.kind === "reject") {
      reply(response, decision.status, decision.reason);
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let overflowed = false;
    request.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      received += chunk.length;
      if (exceedsBodyLimit(received)) {
        overflowed = true;
        chunks.length = 0;
        response.setHeader("connection", "close");
        response.once("finish", () => request.destroy());
        reply(response, 413, "body too large");
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => reply(response, 400, "request failed"));
    request.on("end", () => {
      if (overflowed) return;
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(resolve(directory, decision.name), Buffer.concat(chunks), { flag: "wx" });
        reply(response, 204);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") reply(response, 409, "result exists, choose another name");
        else reply(response, 500, "write failed");
      }
    });
  };
}

export function resultsSink(environment: NodeJS.ProcessEnv, directory: string): Plugin | undefined {
  if (environment[ENABLE_FLAG] !== "1") return undefined;
  const given = environment[TOKEN_VARIABLE] ?? "";
  const token = given.length >= MIN_TOKEN_LENGTH ? given : randomBytes(24).toString("hex");
  const handler = createSinkHandler({ directory, token });
  return {
    name: "sp4-results-sink",
    configureServer: (server) => {
      server.middlewares.use(handler);
      if (token !== given) server.config.logger.info(`SP4 results sink token: ${token}`);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(handler);
      if (token !== given) server.config.logger.info(`SP4 results sink token: ${token}`);
    },
  };
}
