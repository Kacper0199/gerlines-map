import { describe, expect, it, vi } from "vitest";
import land from "./fixtures/land-by-2025-11.json" with { type: "json" };
import network from "./fixtures/network-2025-11.json" with { type: "json" };
import station from "./fixtures/station-2025-11.json" with { type: "json" };
import today from "./fixtures/today.json" with { type: "json" };
import train from "./fixtures/train-596-2025-11.json" with { type: "json" };
import { fetchStats, statsUrl } from "./stats-client.ts";

const RANGE = { from: "2025-11-01", to: "2025-11-30" };

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("statsUrl", () => {
  it("asks /today for today in Germany and /period for any other range", () => {
    expect(statsUrl({ kind: "network" }, RANGE, true)).toBe("/api/v1/stats/today");
    expect(statsUrl({ kind: "network" }, RANGE, false)).toBe(
      "/api/v1/stats/period?from=2025-11-01&to=2025-11-30",
    );
  });
  it("addresses a Land, a station, a train and a line by their own route", () => {
    expect(statsUrl({ kind: "land", code: "DE-BY" }, RANGE, false)).toBe(
      "/api/v1/stats/lands/DE-BY?from=2025-11-01&to=2025-11-30",
    );
    expect(
      statsUrl(
        { kind: "station", id: "7caf6c52-407d-3f0f-ae57-e324480e9bf3", name: "X" },
        RANGE,
        false,
      ),
    ).toBe(
      "/api/v1/stats/stations/7caf6c52-407d-3f0f-ae57-e324480e9bf3?from=2025-11-01&to=2025-11-30",
    );
    expect(statsUrl({ kind: "train", number: "596" }, RANGE, true)).toBe(
      "/api/v1/stats/trains/596?from=2025-11-01&to=2025-11-30",
    );
    expect(statsUrl({ kind: "line", name: "S 1" }, RANGE, false)).toBe(
      "/api/v1/stats/lines/S%201?from=2025-11-01&to=2025-11-30",
    );
  });
});

describe("fetchStats", () => {
  it("parses each kind of answer with its own schema", async () => {
    const bodies: readonly (readonly [string, unknown])[] = [
      ["/lands/", land],
      ["/stations/", station],
      ["/trains/", train],
      ["/today", today],
    ];
    const fetch = vi.fn(async (url: string) =>
      answer(200, bodies.find(([part]) => url.includes(part))?.[1] ?? network),
    );
    const net = await fetchStats({ kind: "network" }, RANGE, false, { fetch });
    expect(net.kind === "ok" && net.data.kind).toBe("network");
    const lnd = await fetchStats({ kind: "land", code: "DE-BY" }, RANGE, false, { fetch });
    expect(lnd.kind === "ok" && lnd.data.kind).toBe("land");
    const stn = await fetchStats(
      { kind: "station", id: "7caf6c52-407d-3f0f-ae57-e324480e9bf3", name: "X" },
      RANGE,
      false,
      { fetch },
    );
    expect(stn.kind === "ok" && stn.data.kind).toBe("station");
    const trn = await fetchStats({ kind: "train", number: "596" }, RANGE, false, { fetch });
    expect(trn.kind === "ok" && trn.data.kind).toBe("train");
  });

  it("names the failure instead of hiding it", async () => {
    const run = (status: number, body: unknown = {}) =>
      fetchStats({ kind: "network" }, RANGE, false, { fetch: async () => answer(status, body) });
    expect(await run(503, { error: "not_configured" })).toEqual({ kind: "not-configured" });
    expect(await run(503, { error: "stats_unavailable" })).toEqual({ kind: "unavailable" });
    expect(await run(429, { error: "rate_limited" })).toEqual({ kind: "rate-limited" });
    expect(await run(400, { error: "invalid_request" })).toEqual({ kind: "invalid" });
    expect(await run(404, { error: "not_found" })).toEqual({ kind: "not-found" });
    expect(await run(500)).toEqual({ kind: "unavailable" });
    expect(await run(200, { kind: "network" })).toEqual({ kind: "unreadable" });
  });

  it("reports a network failure and lets an abort through", async () => {
    const failed = await fetchStats({ kind: "network" }, RANGE, false, {
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    expect(failed).toEqual({ kind: "unreachable" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchStats({ kind: "network" }, RANGE, false, {
        fetch: async () => {
          throw new DOMException("aborted", "AbortError");
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("lets an abort through when it lands while the body downloads", async () => {
    const controller = new AbortController();
    const body = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
    const pending = fetchStats({ kind: "network" }, RANGE, false, {
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => body,
        }) as unknown as Response,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("still names an unreadable body when nothing was aborted", async () => {
    const result = await fetchStats({ kind: "network" }, RANGE, false, {
      fetch: async () => new Response("<html>", { status: 200 }),
    });
    expect(result).toEqual({ kind: "unreadable" });
  });

  it("carries the seconds a limited or unavailable answer asks to wait", async () => {
    const withHeader = (status: number, seconds: string) =>
      fetchStats({ kind: "network" }, RANGE, false, {
        fetch: async () =>
          new Response(JSON.stringify({ error: "rate_limited" }), {
            status,
            headers: { "retry-after": seconds },
          }),
      });
    expect(await withHeader(429, "42")).toEqual({ kind: "rate-limited", retryAfterS: 42 });
    expect(await withHeader(503, "5")).toEqual({ kind: "unavailable", retryAfterS: 5 });
    expect(await withHeader(429, "0")).toEqual({ kind: "rate-limited", retryAfterS: 1 });
    expect(await withHeader(429, "99999")).toEqual({ kind: "rate-limited", retryAfterS: 120 });
    expect(await withHeader(429, "Wed, 21 Oct 2026 07:28:00 GMT")).toEqual({
      kind: "rate-limited",
    });
  });

  it("rejects an answer for another area than the one asked", async () => {
    const wrong = await fetchStats({ kind: "land", code: "DE-BY" }, RANGE, false, {
      fetch: async () => answer(200, network),
    });
    expect(wrong).toEqual({ kind: "unreadable" });
  });
});
