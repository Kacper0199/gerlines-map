import { describe, expect, it } from "vitest";
import { filterSliced, mapSliced, runNow, runSliced } from "./slices.ts";

describe("sliced jobs", () => {
  it("maps every item and yields after each full slice", () => {
    const job = mapSliced([1, 2, 3, 4, 5], (value) => value * 10, 2);
    const steps = [job.next(), job.next(), job.next()];
    expect(steps.map((step) => step.done)).toEqual([false, false, true]);
    expect(steps[2]?.value).toEqual([10, 20, 30, 40, 50]);
  });

  it("counts the items it looked at, not the ones it kept, for a slice of a filter", () => {
    const job = filterSliced([1, 2, 3, 4, 5], (value) => value === 5, 2);
    expect(runNow(job)).toEqual([5]);
    const pauses: number[] = [];
    const counted = filterSliced([1, 2, 3, 4, 5], () => false, 2);
    return runSliced(counted, async () => {
      pauses.push(pauses.length);
    }).then((kept) => {
      expect(kept).toEqual([]);
      expect(pauses).toHaveLength(2);
    });
  });

  it("pauses between slices and gives the same result as running at once", async () => {
    const items = Array.from({ length: 7 }, (_, at) => at);
    const order: string[] = [];
    const sliced = await runSliced(
      mapSliced(
        items,
        (value) => {
          order.push(`item ${value}`);
          return value + 1;
        },
        3,
      ),
      async () => {
        order.push("pause");
      },
    );
    expect(sliced).toEqual(runNow(mapSliced(items, (value) => value + 1, 3)));
    expect(order).toEqual([
      "item 0",
      "item 1",
      "item 2",
      "pause",
      "item 3",
      "item 4",
      "item 5",
      "pause",
      "item 6",
    ]);
  });

  it("lets a timer that is due run between slices on the real event loop", async () => {
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    const seen: boolean[] = [];
    await runSliced(
      mapSliced(
        Array.from({ length: 8 }, (_, at) => at),
        (value) => {
          const until = Date.now() + 2;
          while (Date.now() < until);
          seen.push(ticked);
          return value;
        },
        2,
      ),
    );
    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(true);
  });
});
