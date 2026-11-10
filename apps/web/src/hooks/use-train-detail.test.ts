// @vitest-environment happy-dom
import type { TrainDetail } from "@gerlines/schema";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDetail } from "../components/train/test-detail.ts";
import { type FetchLike, fetchTrainDetail, useTrainDetail } from "./use-train-detail.ts";

const ID = "6f1c2a7e-6c3b-5d55-9a43-2f6b8e0c1d11";

interface FakeServer {
  readonly fetch: FetchLike & ReturnType<typeof vi.fn>;
  set(next: TrainDetail | number | "invalid" | "offline"): void;
}

function fakeServer(initial: TrainDetail | number | "invalid" | "offline"): FakeServer {
  let state = initial;
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    expect(input).toBe(`/api/v1/trains/${ID}`);
    if (state === "offline") {
      throw new TypeError("Failed to fetch");
    }
    if (typeof state === "number") {
      return new Response("", { status: state });
    }
    if (state === "invalid") {
      return new Response(JSON.stringify({ tripInstanceId: ID }), { status: 200 });
    }
    const etag = `"v${state.version}"`;
    const asked = new Headers(init?.headers).get("if-none-match");
    if (asked === etag) {
      return new Response(null, { status: 304 });
    }
    return new Response(JSON.stringify(state), { status: 200, headers: { etag } });
  });
  return {
    fetch: fetch as FakeServer["fetch"],
    set(next) {
      state = next;
    },
  };
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function settled(check: () => void): Promise<void> {
  for (let turn = 0; ; turn += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (turn >= 50) throw error;
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

describe("fetchTrainDetail", () => {
  it("parses a detail with the schema and keeps the etag", async () => {
    const server = fakeServer(testDetail());
    const result = await fetchTrainDetail(ID, { fetch: server.fetch });
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.etag).toBe('"v3"');
  });

  it("asks with the etag and reads 304 as not modified", async () => {
    const server = fakeServer(testDetail());
    expect((await fetchTrainDetail(ID, { fetch: server.fetch, etag: '"v3"' })).kind).toBe(
      "not-modified",
    );
  });

  it("names 404, server errors, unreadable bodies and network failures", async () => {
    expect((await fetchTrainDetail(ID, { fetch: fakeServer(404).fetch })).kind).toBe("not-found");
    expect(await fetchTrainDetail(ID, { fetch: fakeServer(503).fetch })).toEqual({
      kind: "error",
      code: "server_error",
    });
    expect(await fetchTrainDetail(ID, { fetch: fakeServer("invalid").fetch })).toEqual({
      kind: "error",
      code: "unreadable",
    });
    expect(await fetchTrainDetail(ID, { fetch: fakeServer("offline").fetch })).toEqual({
      kind: "error",
      code: "unreachable",
    });
  });

  it("shows a detail without its photo when the photo has a shape this bundle does not know", async () => {
    const answer =
      (body: unknown): FetchLike =>
      async () =>
        new Response(JSON.stringify(body), { status: 200 });
    const otherPhoto = { url: "https://upload.wikimedia.org/a.jpg", author: "Rail Fan" };
    const result = await fetchTrainDetail(ID, {
      fetch: answer({ ...testDetail(), photo: otherPhoto }),
    });
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.detail.photo).toBeNull();
    expect(result.kind === "ok" && result.detail.version).toBe(3);
    const brokenElsewhere = { ...testDetail(), photo: otherPhoto, category: "rocket" };
    expect(await fetchTrainDetail(ID, { fetch: answer(brokenElsewhere) })).toEqual({
      kind: "error",
      code: "unreadable",
    });
  });

  it("refuses a detail of another train", async () => {
    const server = fakeServer(
      testDetail({ tripInstanceId: "6f1c2a7e-6c3b-5d55-9a43-2f6b8e0c1d12" }),
    );
    expect((await fetchTrainDetail(ID, { fetch: server.fetch })).kind).toBe("error");
  });
});

describe("useTrainDetail", () => {
  it("is idle without a train", () => {
    const { result } = renderHook(() => useTrainDetail(null, { fetch: fakeServer(404).fetch }));
    expect(result.current.status).toBe("idle");
  });

  it("loads, then refreshes with the etag and takes a newer version", async () => {
    vi.useFakeTimers();
    const server = fakeServer(testDetail());
    const { result } = renderHook(() =>
      useTrainDetail(ID, { fetch: server.fetch, refreshMs: 1000 }),
    );
    expect(result.current.status).toBe("loading");
    await settled(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(server.fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(server.fetch.mock.calls[1]?.[1]?.headers).get("if-none-match")).toBe('"v3"');
    server.set(testDetail({ version: 4, delaySeconds: 600 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settled(() =>
      expect(result.current.status === "ready" && result.current.detail.version).toBe(4),
    );
  });

  it("keeps the last detail when a refresh fails and says so", async () => {
    vi.useFakeTimers();
    const server = fakeServer(testDetail());
    const { result } = renderHook(() =>
      useTrainDetail(ID, { fetch: server.fetch, refreshMs: 1000 }),
    );
    await settled(() => expect(result.current.status).toBe("ready"));
    server.set("offline");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settled(() =>
      expect(result.current.status === "ready" && result.current.refreshError).toBe("unreachable"),
    );
  });

  it("holds the detail through one 404 and gives up after the second in a row", async () => {
    vi.useFakeTimers();
    const server = fakeServer(testDetail());
    const { result } = renderHook(() =>
      useTrainDetail(ID, { fetch: server.fetch, refreshMs: 1000 }),
    );
    await settled(() => expect(result.current.status).toBe("ready"));
    server.set(404);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(server.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("ready");
    server.set(testDetail());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    server.set(404);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.status).toBe("ready");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settled(() => expect(result.current.status).toBe("not-found"));
  });

  it("offers a retry after not found, which asks again and can find the train", async () => {
    const server = fakeServer(404);
    const { result } = renderHook(() => useTrainDetail(ID, { fetch: server.fetch }));
    await waitFor(() => expect(result.current.status).toBe("not-found"));
    server.set(testDetail());
    act(() => {
      if (result.current.status === "not-found") result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(server.fetch).toHaveBeenCalledTimes(2);
  });

  it("drops a response older than the one it holds for the same timetable", async () => {
    vi.useFakeTimers();
    const server = fakeServer(testDetail({ version: 5 }));
    const { result } = renderHook(() =>
      useTrainDetail(ID, { fetch: server.fetch, refreshMs: 1000 }),
    );
    await settled(() => expect(result.current.status).toBe("ready"));
    server.set(testDetail({ version: 4, delaySeconds: 60 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(server.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.status === "ready" && result.current.detail.version).toBe(5);
    server.set(testDetail({ version: 1, timetableVersion: "delfi-2026-11-02" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settled(() =>
      expect(result.current.status === "ready" && result.current.detail.timetableVersion).toBe(
        "delfi-2026-11-02",
      ),
    );
  });

  it("pauses while the page is hidden and asks again when it shows", async () => {
    vi.useFakeTimers();
    const server = fakeServer(testDetail());
    const { result } = renderHook(() =>
      useTrainDetail(ID, { fetch: server.fetch, refreshMs: 1000 }),
    );
    await settled(() => expect(result.current.status).toBe("ready"));
    setHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(server.fetch.mock.calls.length).toBeLessThanOrEqual(2);
    const calls = server.fetch.mock.calls.length;
    await act(async () => {
      setHidden(false);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(server.fetch.mock.calls.length).toBe(calls + 1);
  });

  it("waits longer after each failed refresh", async () => {
    vi.useFakeTimers();
    const server = fakeServer(testDetail());
    const { result } = renderHook(() =>
      useTrainDetail(ID, { fetch: server.fetch, refreshMs: 1000 }),
    );
    await settled(() => expect(result.current.status).toBe("ready"));
    server.set(503);
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    await advance(1000);
    expect(server.fetch).toHaveBeenCalledTimes(2);
    await advance(1500);
    expect(server.fetch).toHaveBeenCalledTimes(2);
    await advance(500);
    expect(server.fetch).toHaveBeenCalledTimes(3);
    await advance(3900);
    expect(server.fetch).toHaveBeenCalledTimes(3);
    await advance(100);
    expect(server.fetch).toHaveBeenCalledTimes(4);
  });

  it("tells when the last successful answer came", async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const server = fakeServer(testDetail());
    const { result } = renderHook(() =>
      useTrainDetail(ID, { fetch: server.fetch, refreshMs: 1000, clock: () => clock }),
    );
    await settled(() => expect(result.current.status).toBe("ready"));
    expect(result.current.status === "ready" && result.current.fetchedAtMs).toBe(1_000_000);
    clock = 1_001_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.status === "ready" && result.current.fetchedAtMs).toBe(1_001_000);
    server.set("offline");
    clock = 1_002_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.status === "ready" && result.current.fetchedAtMs).toBe(1_001_000);
  });

  it("reports a train that is not running and stops asking", async () => {
    vi.useFakeTimers();
    const server = fakeServer(404);
    const { result } = renderHook(() =>
      useTrainDetail(ID, { fetch: server.fetch, refreshMs: 1000 }),
    );
    await settled(() => expect(result.current.status).toBe("not-found"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(server.fetch).toHaveBeenCalledTimes(1);
  });

  it("offers a retry after a failed first load", async () => {
    const server = fakeServer(503);
    const { result } = renderHook(() => useTrainDetail(ID, { fetch: server.fetch }));
    await waitFor(() => expect(result.current.status).toBe("error"));
    server.set(testDetail());
    act(() => {
      if (result.current.status === "error") result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("stops polling when the train changes or the card closes", async () => {
    vi.useFakeTimers();
    const server = fakeServer(testDetail());
    const { result, unmount } = renderHook(() =>
      useTrainDetail(ID, { fetch: server.fetch, refreshMs: 1000 }),
    );
    await settled(() => expect(result.current.status).toBe("ready"));
    unmount();
    const calls = server.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.fetch.mock.calls.length).toBe(calls);
  });
});
