import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { placeRows, placesWithin, type RowKey } from "./place-rows.ts";

const MIN = 60;

interface Row extends RowKey {
  readonly name: string;
}

/** A run of `stops` as `place@minute` (arrival equals departure), rows as `[index, place, minute]`. */
function place(stops: string[], rows: [number, string | null, number | null][]) {
  const parsed = stops.map((stop) => stop.split("@") as [string, string]);
  const run = {
    places: parsed.map(([p]) => p),
    arrivals: parsed.map(([, m]) => Number(m) * MIN),
    departures: parsed.map(([, m]) => Number(m) * MIN),
  };
  const source = rows.map(([i, p, m]) => {
    const t = m === null ? null : m * MIN;
    return [i, { name: `r${i}`, place: p, arrival: t, departure: t }] as const;
  });
  const placed = placeRows<Row>(run, source, (r) => r);
  return {
    at: placed.rows.flatMap((r, k) => (r ? [`${r.name}@${k}`] : [])),
    realigned: placed.realigned,
    renamed: placed.renamed,
    dropped: placed.dropped,
  };
}

describe("placeRows", () => {
  it("takes rows of the same version by index", () => {
    expect(
      place(
        ["a@0", "b@10", "c@20"],
        [
          [0, "a", 0],
          [2, "c", 20],
        ],
      ),
    ).toEqual({ at: ["r0@0", "r2@2"], realigned: 0, renamed: 0, dropped: 0 });
  });

  it("takes a same-version row by index even when its planned time is far off", () => {
    expect(place(["a@0", "b@10", "c@20"], [[1, "b", 200]])).toEqual({
      at: ["r1@1"],
      realigned: 0,
      renamed: 0,
      dropped: 0,
    });
  });

  it("puts an inserted stop before a repeated place on the right visits", () => {
    expect(
      place(
        ["a@0", "b@10", "b@20", "c@30"],
        [
          [0, "a", 0],
          [1, "x", 5],
          [2, "b", 10],
          [3, "b", 20],
          [4, "c", 30],
        ],
      ),
    ).toEqual({
      at: ["r0@0", "r2@1", "r3@2", "r4@3"],
      realigned: 3,
      renamed: 0,
      dropped: 1,
    });
  });

  it("puts sparse rows after an inserted stop on the visit of their planned time", () => {
    const run = ["a@0", "b@10", "b@20", "c@30"];
    expect(place(run, [[3, "b", 20]]).at).toEqual(["r3@2"]);
    expect(place(run, [[2, "b", 10]]).at).toEqual(["r2@1"]);
    expect(
      place(run, [
        [2, "b", 10],
        [4, "c", 30],
      ]).at,
    ).toEqual(["r2@1", "r4@3"]);
  });

  it("aligns a loop with an inserted stop (A X B C B D on A B C B D)", () => {
    expect(
      place(
        ["a@0", "b@10", "c@20", "b@30", "d@40"],
        [
          [0, "a", 0],
          [1, "x", 5],
          [2, "b", 10],
          [3, "c", 20],
          [4, "b", 30],
          [5, "d", 40],
        ],
      ),
    ).toEqual({
      at: ["r0@0", "r2@1", "r3@2", "r4@3", "r5@4"],
      realigned: 4,
      renamed: 0,
      dropped: 1,
    });
    expect(place(["a@0", "b@10", "c@20", "b@30", "d@40"], [[4, "b", 30]]).at).toEqual(["r4@3"]);
  });

  it("puts the final row of a ring shortened by more than half on the last visit", () => {
    const ring = ["s@0", "a@10", "b@20", "c@30", "d@40", "e@50", "s@60"];
    expect(place(ring, [[2, "s", 60]])).toEqual({
      at: ["r2@6"],
      realigned: 1,
      renamed: 0,
      dropped: 0,
    });
    expect(
      place(ring, [
        [0, "s", 0],
        [1, "e", 50],
        [2, "s", 60],
      ]).at,
    ).toEqual(["r0@0", "r1@5", "r2@6"]);
  });

  it("places an untimed row of a repeated place by the shift of the row before it", () => {
    const ring = ["s@0", "a@10", "b@20", "c@30", "d@40", "e@50", "s@60"];
    expect(
      place(ring, [
        [0, "s", 0],
        [1, "e", 50],
        [2, "s", null],
      ]).at,
    ).toEqual(["r0@0", "r1@5", "r2@6"]);
    expect(place(ring, [[2, "s", null]])).toEqual({
      at: [],
      realigned: 0,
      renamed: 0,
      dropped: 1,
    });
  });

  it("keeps untimed rows of another version on shift 0 until a timed row moves them", () => {
    const loop = ["x@0", "y@1", "a@2", "b@3", "a@4", "b@5"];
    const untimed: [number, string, null][] = [
      [0, "a", null],
      [1, "b", null],
      [2, "a", null],
      [3, "b", null],
    ];
    expect(place(loop, untimed)).toEqual({
      at: ["r2@2", "r3@3"],
      realigned: 0,
      renamed: 0,
      dropped: 2,
    });
    expect(place(loop, [[0, "a", 2], ...untimed.slice(1)]).at).toEqual([
      "r0@2",
      "r1@3",
      "r2@4",
      "r3@5",
    ]);
  });

  it("moves an untimed row only with the row before it", () => {
    const run = ["a@0", "b@10", "c@20", "d@30"];
    expect(place(run, [[1, "c", null]]).dropped).toBe(1);
    expect(
      place(run, [
        [0, "b", 10],
        [1, "c", null],
      ]).at,
    ).toEqual(["r0@1", "r1@2"]);
  });

  it("moves a row whose planned time fits no visit only with the row before it", () => {
    const run = ["a@0", "b@10", "c@20", "d@30"];
    expect(place(run, [[1, "c", 45]]).dropped).toBe(1);
    expect(
      place(run, [
        [0, "b", 10],
        [1, "c", 45],
      ]).at,
    ).toEqual(["r0@1", "r1@2"]);
  });

  it("aligns sparse rows of another version", () => {
    expect(
      place(
        ["a@0", "b@10", "c@20", "d@30", "e@40", "f@50"],
        [
          [1, "c", 20],
          [3, "f", 50],
        ],
      ),
    ).toEqual({ at: ["r1@2", "r3@5"], realigned: 2, renamed: 0, dropped: 0 });
  });

  it("drops a stray row of a same-version source and keeps the others by index", () => {
    expect(
      place(
        ["a@0", "b@10", "c@20", "d@30"],
        [
          [0, "a", 0],
          [1, "c", 10],
          [2, "c", 20],
          [3, "d", 30],
        ],
      ),
    ).toEqual({ at: ["r0@0", "r2@2", "r3@3"], realigned: 0, renamed: 0, dropped: 1 });
  });

  it("drops a stray row that would move the source off its index for one row", () => {
    expect(
      place(
        ["a@0", "b@10", "c@20", "d@30"],
        [
          [0, "a", 0],
          [1, "c", 12],
          [3, null, 30],
        ],
      ),
    ).toEqual({ at: ["r0@0", "r3@3"], realigned: 0, renamed: 0, dropped: 1 });
  });

  it("places a renamed station on the stop of the same planned time", () => {
    expect(
      place(
        ["a@0", "b@10", "c@20"],
        [
          [0, "a", 0],
          [1, "b2", 10],
          [2, "c", 20],
        ],
      ),
    ).toEqual({ at: ["r0@0", "r1@1", "r2@2"], realigned: 1, renamed: 1, dropped: 0 });
    expect(
      place(
        ["a@0", "b@10", "c@20", "d@30"],
        [
          [0, "a", 0],
          [1, "c2", 20],
          [2, "d", 30],
        ],
      ),
    ).toEqual({ at: ["r0@0", "r1@2", "r2@3"], realigned: 2, renamed: 1, dropped: 0 });
  });

  it("places a renamed station only within 150 m of the stop when places have coordinates", () => {
    const times = [0, 600, 1200];
    const run = { places: ["a", "b", "c"], arrivals: times, departures: times };
    const near = placesWithin(
      new Map([
        ["b", { lon: 8, lat: 50 }],
        ["b2", { lon: 8, lat: 50.0012 }],
        ["b3", { lon: 8.002, lat: 50.0012 }],
      ]),
    );
    const at = (place: string) =>
      placeRows(run, [[1, { place, arrival: 600, departure: 600 }]], (r) => r, near).rows.findIndex(
        (r) => r !== undefined,
      );
    expect(at("b2")).toBe(1);
    expect(at("b3")).toBe(-1);
    expect(at("b4")).toBe(-1);
    expect(near("b", "b2")).toBe(true);
    expect(near("b", "b3")).toBe(false);
  });

  it("drops a renamed station without the same planned time", () => {
    expect(
      place(
        ["a@0", "b@10", "c@20"],
        [
          [0, "a", 0],
          [1, "b2", 12],
          [2, "c", 20],
        ],
      ),
    ).toEqual({ at: ["r0@0", "r2@2"], realigned: 0, renamed: 0, dropped: 1 });
    expect(place(["a@0", "b@10"], [[1, "b2", null]]).dropped).toBe(1);
  });

  it("never places a row before the last placed one", () => {
    expect(
      place(
        ["a@0", "b@10", "c@20"],
        [
          [0, "c", 20],
          [1, "a", 0],
          [2, "b", 10],
        ],
      ),
    ).toEqual({ at: ["r1@0", "r2@1"], realigned: 2, renamed: 0, dropped: 1 });
  });

  it("chooses the visit of a repeated place nearest the row's planned time", () => {
    expect(place(["b@0", "a@10", "b@20", "c@30"], [[1, "b", 18]]).at).toEqual(["r1@2"]);
    expect(place(["b@0", "a@10", "b@20", "c@30"], [[1, "b", 2]]).at).toEqual(["r1@0"]);
  });

  it("chooses by planned time between visits of a place less than 6 minutes apart", () => {
    expect(place(["x@0", "c@10", "d@12", "c@14", "e@20"], [[1, "c", 14]]).at).toEqual(["r1@3"]);
    const times = [0, 600, 1148, 1359];
    const run = { places: ["p0", "p1", "p0", "p0"], arrivals: times, departures: times };
    const row = { place: "p0", arrival: 1359, departure: 1359 };
    expect(placeRows(run, [[2, row]], (r) => r).rows.indexOf(row)).toBe(3);
  });

  it("drops an untimed row at a repeated place when nothing fixes its visit", () => {
    expect(place(["b@0", "a@10", "b@20", "c@30"], [[1, "b", null]]).dropped).toBe(1);
  });

  it("keeps rows without a place on the shift of the row before them", () => {
    expect(
      place(
        ["a@0", "b@10", "c@20", "d@30"],
        [
          [0, "b", 10],
          [1, null, null],
          [2, "d", 30],
        ],
      ).at,
    ).toEqual(["r0@1", "r1@2", "r2@3"]);
    expect(
      place(
        ["a@0", "b@10", "c@20", "d@30"],
        [
          [0, "a", 0],
          [1, null, 25],
        ],
      ),
    ).toEqual({ at: ["r0@0"], realigned: 0, renamed: 0, dropped: 1 });
  });

  it("keeps a row without a place on its shift when its planned time is under 5 min off", () => {
    expect(
      place(
        ["a@0", "b@10", "c@20"],
        [
          [0, "a", 0.75],
          [1, null, 10.75],
          [2, "c", 20.75],
        ],
      ),
    ).toEqual({ at: ["r0@0", "r1@1", "r2@2"], realigned: 0, renamed: 0, dropped: 0 });
    expect(
      place(
        ["a@0", "b@10", "c@20"],
        [
          [0, "a", 0],
          [1, null, 16],
          [2, "c", 20],
        ],
      ).dropped,
    ).toBe(1);
  });

  it("drops a same-version row beyond the run or on a missing index", () => {
    const run = {
      places: ["a", undefined, "c"],
      arrivals: [0, null, 1200],
      departures: [0, null, 1200],
    };
    const key = (place: string | null) => ({ place, arrival: null, departure: null });
    const placed = placeRows(
      run,
      [
        [1, { name: "r1", ...key(null) }],
        [2, { name: "r2", ...key("c") }],
        [7, { name: "r7", ...key(null) }],
      ],
      (r) => r,
    );
    expect(placed.rows.map((r) => r?.name)).toEqual([undefined, undefined, "r2"]);
    expect(placed.dropped).toBe(2);
  });

  it("compares the arrival and the departure side", () => {
    const run = { places: ["a", "b", "c"], arrivals: [0, 600, 1200], departures: [0, 660, 1200] };
    const at = (arrival: number | null, departure: number | null) =>
      placeRows(run, [[1, { place: "b2", arrival, departure }]], (r) => r).rows.findIndex(
        (r) => r !== undefined,
      );
    expect(at(600, 660)).toBe(1);
    expect(at(null, 660)).toBe(1);
    expect(at(600, 900)).toBe(-1);
  });

  it("takes rows on their own index without the full alignment, with its result", () => {
    const stop = fc.record({
      place: fc.constantFrom("a", "b", "c"),
      gap: fc.integer({ min: 1, max: 600 }),
    });
    const row = fc.record({
      take: fc.boolean(),
      named: fc.boolean(),
      timed: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(fc.tuple(stop, row), { minLength: 1, maxLength: 30 }), (stops) => {
        let t = 0;
        const times = stops.map(([s]) => (t += s.gap));
        const run = { places: stops.map(([s]) => s.place), arrivals: times, departures: times };
        const source: [number, RowKey][] = stops.flatMap(([s, r], i) => {
          if (!r.take) return [];
          const time = r.timed ? (times[i] as number) : null;
          return [[i, { place: r.named ? s.place : null, arrival: time, departure: time }]];
        });
        const fast = placeRows(run, source, (r) => r);
        const stray: RowKey = { place: "z", arrival: null, departure: null };
        const full = placeRows(run, [...source, [stops.length + 3, stray]], (r) => r);
        expect(fast.rows).toEqual(full.rows);
        expect({ ...fast, rows: [] }).toEqual({ ...full, rows: [], dropped: 0 });
        expect(fast.rows.flatMap((r, k) => (r ? [k] : []))).toEqual(source.map(([i]) => i));
      }),
      { numRuns: 500 },
    );
  });

  it("returns nothing placed for an empty source", () => {
    expect(place(["a@0", "b@10"], [])).toEqual({ at: [], realigned: 0, renamed: 0, dropped: 0 });
  });

  it("aligns a long run of repeating places on a source shifted by two stops", () => {
    const stops = Array.from({ length: 120 }, (_, k) => `p${k % 40}@${k * 3}`);
    const rows: [number, string, number][] = Array.from({ length: 118 }, (_, j) => [
      j,
      `p${(j + 2) % 40}`,
      (j + 2) * 3,
    ]);
    const result = place(stops, rows);
    expect(result.dropped).toBe(0);
    expect(result.at[0]).toBe("r0@2");
    expect(result.at.at(-1)).toBe("r117@119");
  });
});
