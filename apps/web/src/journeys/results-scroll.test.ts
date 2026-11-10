import { describe, expect, it } from "vitest";
import { resultsScrollTop } from "./results-scroll.ts";

const view = { top: 100, bottom: 1300, scrollTop: 0 };

describe("results scroll", () => {
  it("leaves the form in place when the shown journey is already in view", () => {
    expect(
      resultsScrollTop(view, { top: 480, bottom: 2000 }, { top: 520, bottom: 640 }, 8),
    ).toBeNull();
  });

  it("brings the results to the top of the body when the shown journey is below it", () => {
    expect(
      resultsScrollTop(
        { top: 100, bottom: 700, scrollTop: 20 },
        { top: 480, bottom: 2000 },
        { top: 650, bottom: 770 },
        8,
      ),
    ).toBe(392);
  });

  it("without a shown journey scrolls only when the start of the results is out of view", () => {
    expect(resultsScrollTop(view, { top: 480, bottom: 600 }, null, 8)).toBeNull();
    expect(
      resultsScrollTop({ top: 100, bottom: 400, scrollTop: 0 }, { top: 480, bottom: 600 }, null, 8),
    ).toBe(372);
  });
});
