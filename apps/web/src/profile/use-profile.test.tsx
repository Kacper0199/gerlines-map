// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import answer from "./fixtures/segments-619-hsr.json" with { type: "json" };
import { clearProfileCache, profileCacheSize, useProfile } from "./use-profile.ts";

const SUBJECT = { number: "619", category: "hsr", operatorId: "db-fernverkehr-ag" } as const;
const RANGE = { from: "2026-09-28", to: "2026-10-27" };
const ok = () => new Response(JSON.stringify(answer), { status: 200 });

beforeEach(() => clearProfileCache());
afterEach(cleanup);

describe("useProfile", () => {
  it("asks for nothing until it is switched on", () => {
    const fetch = vi.fn(async () => ok());
    const { result } = renderHook(() => useProfile(SUBJECT, RANGE, false, fetch));
    expect(result.current.view.state).toBe("idle");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads the answer once and serves the same request again from memory", async () => {
    const fetch = vi.fn(async () => ok());
    const first = renderHook(() => useProfile(SUBJECT, RANGE, true, fetch));
    expect(first.result.current.view.state).toBe("loading");
    await waitFor(() => expect(first.result.current.view.state).toBe("ready"));
    first.unmount();
    const second = renderHook(() => useProfile(SUBJECT, RANGE, true, fetch));
    expect(second.result.current.view.state).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails with the reason and asks again after a retry", async () => {
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(ok());
    const { result } = renderHook(() => useProfile(SUBJECT, RANGE, true, fetch));
    await waitFor(() => expect(result.current.view.state).toBe("failed"));
    expect(result.current.view).toMatchObject({ failure: "unavailable" });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.view.state).toBe("ready"));
  });

  it("starts over for another train", async () => {
    const fetch = vi.fn(async () => ok());
    const { result, rerender } = renderHook(
      ({ number }) => useProfile({ ...SUBJECT, number }, RANGE, true, fetch),
      { initialProps: { number: "619" } },
    );
    await waitFor(() => expect(result.current.view.state).toBe("ready"));
    rerender({ number: "620" });
    expect(result.current.view.state).toBe("loading");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  describe("memory", () => {
    afterEach(() => vi.useRealTimers());

    it("holds at most twenty answers, the oldest going first", async () => {
      const fetch = vi.fn(async () => ok());
      for (let number = 1; number <= 25; number++) {
        const view = renderHook(() =>
          useProfile({ ...SUBJECT, number: String(number) }, RANGE, true, fetch),
        );
        await waitFor(() => expect(view.result.current.view.state).toBe("ready"));
        view.unmount();
      }
      expect(profileCacheSize()).toBe(20);
      const oldest = renderHook(() => useProfile({ ...SUBJECT, number: "1" }, RANGE, true, fetch));
      expect(oldest.result.current.view.state).toBe("loading");
      await waitFor(() => expect(oldest.result.current.view.state).toBe("ready"));
      const newest = renderHook(() => useProfile({ ...SUBJECT, number: "25" }, RANGE, true, fetch));
      expect(newest.result.current.view.state).toBe("ready");
    });

    it("drops an answer older than five minutes when it is looked up", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const fetch = vi.fn(async () => ok());
      const first = renderHook(() => useProfile(SUBJECT, RANGE, true, fetch));
      await waitFor(() => expect(first.result.current.view.state).toBe("ready"));
      first.unmount();
      expect(profileCacheSize()).toBe(1);
      vi.setSystemTime(Date.now() + 6 * 60_000);
      const pending = vi.fn(() => new Promise<Response>(() => undefined));
      renderHook(() => useProfile(SUBJECT, RANGE, true, pending));
      expect(pending).toHaveBeenCalledTimes(1);
      expect(profileCacheSize()).toBe(0);
    });
  });

  describe("cache expiry", () => {
    afterEach(() => vi.useRealTimers());

    it("stays ready when a cached answer turns five minutes old under a card opened again", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const fetch = vi.fn(async () => ok());
      const first = renderHook(() => useProfile(SUBJECT, RANGE, true, fetch));
      await waitFor(() => expect(first.result.current.view.state).toBe("ready"));
      first.unmount();
      const { result, rerender } = renderHook(
        ({ enabled }) => useProfile(SUBJECT, RANGE, enabled, fetch),
        { initialProps: { enabled: true } },
      );
      expect(result.current.view.state).toBe("ready");
      rerender({ enabled: false });
      rerender({ enabled: true });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      rerender({ enabled: true });
      rerender({ enabled: true });
      expect(result.current.view.state).toBe("ready");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("asks again after switching off and on once the answer is older than five minutes", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const fetch = vi.fn(async () => ok());
      const { result, rerender } = renderHook(
        ({ enabled }) => useProfile(SUBJECT, RANGE, enabled, fetch),
        { initialProps: { enabled: true } },
      );
      await waitFor(() => expect(result.current.view.state).toBe("ready"));
      rerender({ enabled: false });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      rerender({ enabled: true });
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.view.state).toBe("ready"));
    });

    it("stays ready on A, B, A within five minutes and after the entry has expired", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const fetch = vi.fn(async () => ok());
      const { result, rerender } = renderHook(
        ({ number }) => useProfile({ ...SUBJECT, number }, RANGE, true, fetch),
        { initialProps: { number: "619" } },
      );
      await waitFor(() => expect(result.current.view.state).toBe("ready"));
      rerender({ number: "620" });
      await waitFor(() => expect(result.current.view.state).toBe("ready"));
      rerender({ number: "619" });
      expect(result.current.view.state).toBe("ready");
      vi.setSystemTime(Date.now() + 6 * 60_000);
      rerender({ number: "619" });
      expect(result.current.view.state).toBe("ready");
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("asks again for A on A, B, A past five minutes", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const fetch = vi.fn(async () => ok());
      const { result, rerender } = renderHook(
        ({ number }) => useProfile({ ...SUBJECT, number }, RANGE, true, fetch),
        { initialProps: { number: "619" } },
      );
      await waitFor(() => expect(result.current.view.state).toBe("ready"));
      rerender({ number: "620" });
      await waitFor(() => expect(result.current.view.state).toBe("ready"));
      vi.setSystemTime(Date.now() + 6 * 60_000);
      rerender({ number: "619" });
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(result.current.view.state).toBe("ready"));
    });
  });
});
