// @vitest-environment happy-dom
import type { StatsNetwork } from "@gerlines/schema/stats";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import network from "./fixtures/network-2025-11.json" with { type: "json" };
import today from "./fixtures/today.json" with { type: "json" };
import type { FetchLike } from "./stats-client.ts";
import { useStats } from "./use-stats.ts";

const NET = network as unknown as StatsNetwork;
const AREA = { kind: "network" } as const;
const NOVEMBER = { from: "2025-11-01", to: "2025-11-30" };
const OCTOBER = { from: "2025-10-01", to: "2025-10-31" };

interface Gate {
  readonly fetch: FetchLike;
  readonly calls: { url: string; signal: AbortSignal | undefined }[];
  settle(index: number, make: () => Response | Promise<Response>): Promise<void>;
}

function gated(): Gate {
  const calls: Gate["calls"] = [];
  const resolvers: ((value: Response) => void)[] = [];
  const rejecters: ((reason: unknown) => void)[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, signal: init?.signal ?? undefined });
    return new Promise<Response>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return {
    fetch,
    calls,
    async settle(index, make) {
      const response = await make();
      resolvers[index]?.(response);
      await Promise.resolve();
    },
  };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(cleanup);

describe("useStats", () => {
  it("shows the last of two overlapping requests even when the first answers later", async () => {
    const gate = gated();
    const { result, rerender } = renderHook(
      ({ range }) => useStats(AREA, range, false, gate.fetch),
      { initialProps: { range: NOVEMBER } },
    );
    rerender({ range: OCTOBER });
    expect(gate.calls).toHaveLength(2);
    expect(gate.calls[0]?.signal?.aborted).toBe(true);
    await act(async () => {
      await gate.settle(1, () => ok({ ...NET, period: { ...NET.period, from: "2025-10-01" } }));
    });
    await waitFor(() => expect(result.current.view.state).toBe("ready"));
    await act(async () => {
      await gate.settle(0, () => ok(NET));
    });
    expect(result.current.view.state).toBe("ready");
    expect(result.current.view.data?.period.from).toBe("2025-10-01");
  });

  it("does not turn an aborted body into a failure and keeps the held answer", async () => {
    const gate = gated();
    const { result, rerender } = renderHook(
      ({ range }) => useStats(AREA, range, false, gate.fetch),
      { initialProps: { range: NOVEMBER } },
    );
    await act(async () => {
      await gate.settle(0, () => ok(NET));
    });
    await waitFor(() => expect(result.current.view.state).toBe("ready"));
    rerender({ range: OCTOBER });
    expect(result.current.view.state).toBe("refreshing");
    const first = gate.calls[1]?.signal;
    rerender({ range: { from: "2025-09-01", to: "2025-09-30" } });
    expect(first?.aborted).toBe(true);
    const body = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.reject(new DOMException("aborted", "AbortError")),
    } as unknown as Response;
    await act(async () => {
      await gate.settle(1, () => body);
    });
    expect(result.current.view.state).toBe("refreshing");
    expect(result.current.view.data).not.toBeNull();
  });

  it("ignores a late answer after the area went away", async () => {
    const gate = gated();
    const { result, rerender } = renderHook(
      ({ area }: { area: typeof AREA | null }) => useStats(area, NOVEMBER, false, gate.fetch),
      { initialProps: { area: AREA as typeof AREA | null } },
    );
    rerender({ area: null });
    await act(async () => {
      await gate.settle(0, () => ok(NET));
    });
    expect(result.current.view.state).toBe("idle");
  });

  it("carries the wait a limited answer asks for into the failed view", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    );
    const { result } = renderHook(() => useStats(AREA, NOVEMBER, false, fetch));
    await waitFor(() => expect(result.current.view.state).toBe("failed"));
    const view = result.current.view;
    expect(view.state === "failed" && view.retryAfterS).toBe(30);
  });

  it("asks for a fresh answer again when retry is pressed", async () => {
    const fetch = vi.fn(async () => ok(today));
    const { result } = renderHook(() => useStats(AREA, NOVEMBER, true, fetch));
    await waitFor(() => expect(result.current.view.state).toBe("ready"));
    act(() => result.current.retry());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
