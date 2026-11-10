import { beforeEach, describe, expect, it } from "vitest";
import type { NearestAnswer } from "./store.ts";
import { resetInViewStore, useInViewStore } from "./store.ts";

const ANSWER = (inView: number): NearestAnswer => ({
  centre: { lon: 8, lat: 50 },
  result: { inView, trains: [] },
});

describe("trains in view store", () => {
  beforeEach(() => resetInViewStore());

  it("holds the answer of the map and says when it is loading", async () => {
    let release: (answer: NearestAnswer) => void = () => undefined;
    useInViewStore.getState().attach(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = useInViewStore.getState().refresh();
    expect(useInViewStore.getState().loading).toBe(true);
    release(ANSWER(4));
    await pending;
    expect(useInViewStore.getState()).toMatchObject({ loading: false });
    expect(useInViewStore.getState().answer?.result.inView).toBe(4);
  });

  it("answers null and stays empty with no map attached", async () => {
    await expect(useInViewStore.getState().refresh()).resolves.toBeNull();
    expect(useInViewStore.getState().answer).toBeNull();
  });

  it("lets the newest request win over an older one that answers late", async () => {
    const releases: ((answer: NearestAnswer) => void)[] = [];
    useInViewStore.getState().attach(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const first = useInViewStore.getState().refresh();
    const second = useInViewStore.getState().refresh();
    releases[1]?.(ANSWER(2));
    releases[0]?.(ANSWER(9));
    await Promise.all([first, second]);
    expect(useInViewStore.getState().answer?.result.inView).toBe(2);
  });

  it("keeps the last answer when a request fails", async () => {
    useInViewStore.getState().attach(async () => ANSWER(3));
    await useInViewStore.getState().refresh();
    useInViewStore.getState().attach(async () => {
      throw new Error("worker gone");
    });
    await useInViewStore.getState().refresh();
    expect(useInViewStore.getState().answer?.result.inView).toBe(3);
    expect(useInViewStore.getState().loading).toBe(false);
  });

  it("counts the moves of the user", () => {
    useInViewStore.getState().userMoved();
    useInViewStore.getState().userMoved();
    expect(useInViewStore.getState().moves).toBe(2);
  });

  it("marks a failed request as missing and clears the mark with the next answer", async () => {
    useInViewStore.getState().attach(async () => {
      throw new Error("no map");
    });
    await useInViewStore.getState().refresh();
    expect(useInViewStore.getState()).toMatchObject({ error: true, loading: false, answer: null });
    useInViewStore.getState().attach(async () => ANSWER(2));
    await useInViewStore.getState().refresh();
    expect(useInViewStore.getState().error).toBe(false);
    expect(useInViewStore.getState().answer?.result.inView).toBe(2);
  });

  it("counts requests to move the focus to the list heading", () => {
    useInViewStore.getState().requestHeadingFocus();
    useInViewStore.getState().requestHeadingFocus();
    expect(useInViewStore.getState().headingFocus).toBe(2);
  });
});
