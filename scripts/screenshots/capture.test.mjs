import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

const source = readFileSync(new URL("./capture.js", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !line.startsWith("// biome-ignore"))
  .join("\n");
const capture = new Function(`return (${source});`)();

const BASE = { baseUrl: "http://127.0.0.1:5191", outDir: "/out", prefix: "docs", settleMs: 0 };

function fakeWindow(showTrain) {
  const map = { jumpTo: () => undefined, areTilesLoaded: () => true, once: () => undefined };
  const noop = () => undefined;
  return {
    gerlinesMap: map,
    gerlines: { mapStyle: noop, terrain3d: noop, focusLand: noop },
    ...(showTrain ? { gerlinesCheck: { showTrain } } : {}),
  };
}

function fakePage(window) {
  const shots = [];
  const tab = {
    on: () => undefined,
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    waitForFunction: async () => undefined,
    evaluate: async (fn, argument) => {
      globalThis.window = window;
      return fn(argument);
    },
    screenshot: async ({ path }) => void shots.push(path),
  };
  const browser = {
    newContext: async () => ({ newPage: async () => tab, close: async () => undefined }),
  };
  return { page: { context: () => ({ browser: () => browser }) }, shots };
}

function noteOf(results, id) {
  return results.find((result) => result.id === id)?.note;
}

afterEach(() => {
  delete globalThis.window;
});

describe("capture.js train selection", () => {
  globalThis.fetch = () => {
    throw new Error("the capture script must not call any API");
  };

  it("takes every shot without a train key and says why no train is selected", async () => {
    const { page, shots } = fakePage(fakeWindow(null));
    const results = await capture(page, { ...BASE, shots: "all", trainKey: null });

    assert.equal(shots.length, 15);
    assert.match(noteOf(results, "09-selected-ice-desktop"), /^no train selected: set TRAIN_KEY/);
    assert.match(noteOf(results, "10-selected-ice-phone-de"), /^no train selected: set TRAIN_KEY/);
    assert.equal(noteOf(results, "11-overview-phone-dark"), "");
  });

  it("selects the train of the key through the dev check hook", async () => {
    const calls = [];
    const showTrain = async (key, view) => {
      calls.push([key, view]);
      return { found: true, key, lon: 8.66219, lat: 50.10703, zoom: view.zoom, cars: "chevron" };
    };
    const { page } = fakePage(fakeWindow(showTrain));
    const results = await capture(page, { ...BASE, shots: "09", trainKey: 25279342 });

    assert.deepEqual(calls, [[25279342, { zoom: 11, pitch: 0, bearing: 0 }]]);
    assert.equal(
      noteOf(results, "09-selected-ice-desktop"),
      "train 25279342 selected at 8.6622, 50.1070",
    );
  });

  it("carries on when the train is not in the frames or the hook fails", async () => {
    const missing = async (key) => ({ found: false, key });
    const failing = async () => {
      throw new RangeError("not a trip key");
    };
    const first = fakePage(fakeWindow(missing));
    const notFound = await capture(first.page, { ...BASE, shots: "09,10,11", trainKey: 7 });
    const second = fakePage(fakeWindow(failing));
    const failed = await capture(second.page, { ...BASE, shots: "09,10,11", trainKey: 7 });

    assert.equal(first.shots.length, 3);
    assert.equal(
      noteOf(notFound, "10-selected-ice-phone-de"),
      "no train selected: train 7 is not in the frames",
    );
    assert.equal(second.shots.length, 3);
    assert.equal(
      noteOf(failed, "09-selected-ice-desktop"),
      "no train selected: RangeError: not a trip key",
    );
  });

  it("says that the hook exists only in the dev server", async () => {
    const { page } = fakePage(fakeWindow(null));
    const results = await capture(page, { ...BASE, shots: "09", trainKey: 7 });

    assert.match(noteOf(results, "09-selected-ice-desktop"), /only in the dev server/);
  });
});
