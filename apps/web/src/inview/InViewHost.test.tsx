// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrainMap } from "../map/train-map.ts";
import { InViewHost } from "./InViewHost.tsx";
import { resetInViewStore, useInViewStore } from "./store.ts";

function fakeMap(inView: () => number) {
  const map = {
    nearestTrains: vi.fn(async () => ({
      centre: { lon: 8, lat: 50 },
      result: { inView: inView(), trains: [] },
    })),
  };
  return { map, handle: { current: map as unknown as TrainMap } };
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  await changeLocale("en");
  resetInViewStore();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("trains in view summary", () => {
  it("is a polite status region that starts empty and does not ask the map before a move", async () => {
    const { map, handle } = fakeMap(() => 412);
    render(<InViewHost handle={handle} />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(map.nearestTrains).not.toHaveBeenCalled();
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    expect(region.className).toContain("sr-only");
  });

  it("says the count after the user moved the map", async () => {
    const { handle } = fakeMap(() => 412);
    render(<InViewHost handle={handle} />);
    act(() => useInViewStore.getState().userMoved());
    await flush();
    expect(screen.getByRole("status").textContent).toBe("412 trains in view");
  });

  it("changes at most every ten seconds however often the map moves", async () => {
    let count = 5;
    const { handle } = fakeMap(() => count);
    render(<InViewHost handle={handle} />);
    act(() => useInViewStore.getState().userMoved());
    await flush();
    expect(screen.getByRole("status").textContent).toBe("5 trains in view");
    count = 9;
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      act(() => useInViewStore.getState().userMoved());
    }
    expect(screen.getByRole("status").textContent).toBe("5 trains in view");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(screen.getByRole("status").textContent).toBe("9 trains in view");
  });

  it("reads in the language of the page and counts one train in the singular", async () => {
    await changeLocale("pl");
    const { handle } = fakeMap(() => 1);
    render(<InViewHost handle={handle} />);
    act(() => useInViewStore.getState().userMoved());
    await flush();
    expect(screen.getByRole("status").textContent).toBe("1 pociąg w widoku");
  });

  it("lets go of the map when it unmounts", async () => {
    const { handle } = fakeMap(() => 1);
    const view = render(<InViewHost handle={handle} />);
    view.unmount();
    await expect(useInViewStore.getState().refresh()).resolves.toBeNull();
  });

  it("does not speak the summary while the user types in a field", async () => {
    const { map, handle } = fakeMap(() => 412);
    render(
      <>
        <input aria-label="Search" />
        <InViewHost handle={handle} />
      </>,
    );
    act(() => useInViewStore.getState().userMoved());
    await flush();
    expect(screen.getByRole("status").textContent).toBe("412 trains in view");
    const calls = map.nearestTrains.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    act(() => useInViewStore.getState().userMoved());
    screen.getByRole("textbox", { name: "Search" }).focus();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(map.nearestTrains.mock.calls.length).toBe(calls);
    expect(screen.getByRole("status").textContent).toBe("412 trains in view");
  });

  it("never announces an older count when its own request failed", async () => {
    useInViewStore.setState({
      answer: { centre: { lon: 8, lat: 50 }, result: { inView: 7, trains: [] } },
    });
    const map = {
      nearestTrains: vi.fn(async () => {
        throw new Error("worker gone");
      }),
    };
    render(<InViewHost handle={{ current: map as unknown as TrainMap }} />);
    act(() => useInViewStore.getState().userMoved());
    await flush();
    expect(map.nearestTrains).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
