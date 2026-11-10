import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { apiMiddleware } from "./api-plugin.ts";
import { detailProxy, handsOffDetail } from "./detail-proxy.ts";

const TARGET = "http://127.0.0.1:8815";

function run(url: string, detailTarget: string | undefined) {
  const listener = vi.fn();
  const next = vi.fn();
  apiMiddleware(listener, detailTarget)({ url } as IncomingMessage, {} as ServerResponse, next);
  return { listener, next };
}

describe("apiMiddleware", () => {
  it("answers every /api/ request itself while no detail target is set", () => {
    for (const url of ["/api/v1/trains/42", "/api/v1/search?q=ice", "/api/health"]) {
      const { listener, next } = run(url, undefined);
      expect(listener).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("hands /api/v1 over to the proxy while a detail target is set, so the detail card can be checked with pnpm dev", () => {
    for (const url of ["/api/v1/trains/42", "/api/v1/live/keys/7", "/api/v1/search?q=ice"]) {
      const { listener, next } = run(url, TARGET);
      expect(listener).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it("still answers /api/ paths outside /api/v1 itself with a detail target set", () => {
    const { listener, next } = run("/api/health", TARGET);
    expect(listener).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it("passes everything else on", () => {
    const { listener, next } = run("/live/head", TARGET);
    expect(listener).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("detailProxy", () => {
  it("proxies exactly the prefix the plugin stands aside for", () => {
    expect(detailProxy(TARGET)).toEqual({ "/api/v1": { target: TARGET, changeOrigin: true } });
    expect(detailProxy(undefined)).toEqual({});
    expect(handsOffDetail("/api/v1/trains/1", TARGET)).toBe(true);
    expect(handsOffDetail("/api/v1", TARGET)).toBe(false);
    expect(handsOffDetail(undefined, TARGET)).toBe(false);
    expect(handsOffDetail("/api/v1/trains/1", "")).toBe(false);
  });
});
