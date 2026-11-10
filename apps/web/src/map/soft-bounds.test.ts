import { describe, expect, it } from "vitest";
import {
  clampToBox,
  createElasticTracker,
  ELASTIC_LIMIT_KM,
  elasticBox,
  expandBox,
  fitZoom,
  GERMANY_BOX,
  hardBounds,
  includePoints,
  isOutside,
  kmPerDegreeLon,
  overshootKm,
  rawPosition,
  releaseTarget,
  rubberBand,
  rubberBandInverse,
  softPosition,
  unionBounds,
  type ViewSize,
  visibleLonSpan,
} from "./soft-bounds.ts";

const box = elasticBox();

describe("expandBox", () => {
  it("grows every side by at least the given distance", () => {
    const grown = expandBox(GERMANY_BOX, 60);

    expect((GERMANY_BOX.south - grown.south) * 110.574).toBeCloseTo(60, 0);
    expect((grown.north - GERMANY_BOX.north) * 110.574).toBeCloseTo(60, 0);
    for (const lat of [GERMANY_BOX.south, GERMANY_BOX.north]) {
      expect((GERMANY_BOX.west - grown.west) * kmPerDegreeLon(lat)).toBeGreaterThanOrEqual(59.9);
      expect((grown.east - GERMANY_BOX.east) * kmPerDegreeLon(lat)).toBeGreaterThanOrEqual(59.9);
    }
  });

  it("gives the hard bounds about 400 km around Germany", () => {
    const [[west, south], [east, north]] = hardBounds();

    expect((GERMANY_BOX.south - south) * 110.574).toBeCloseTo(400, 0);
    expect((north - GERMANY_BOX.north) * 110.574).toBeCloseTo(400, 0);
    expect(west).toBeLessThan(GERMANY_BOX.west - 5);
    expect(east).toBeGreaterThan(GERMANY_BOX.east + 5);
  });
});

describe("hardBounds for wide viewports", () => {
  const desktop = { top: 24, bottom: 72, left: 412, right: 248 };
  const span = (bounds: [[number, number], [number, number]]) => bounds[1][0] - bounds[0][0];

  it("keeps Germany plus 400 km where the national view already fits, as on a phone", () => {
    const phone = { top: 172, bottom: 72, left: 12, right: 12 };

    expect(hardBounds({ width: 390, height: 844, padding: phone })).toEqual(hardBounds());
  });

  it("widens east and west at 2560 by 1440 so the national view is not forced to zoom in", () => {
    const view = { width: 2560, height: 1440, padding: desktop };
    const bounds = hardBounds(view);
    const zoom = fitZoom(GERMANY_BOX, view);

    expect(zoom).toBeLessThan(6.37);
    expect(span(bounds)).toBeGreaterThan(visibleLonSpan(view.width, zoom));
    expect(bounds[0][1]).toBe(hardBounds()[0][1]);
    expect(
      Math.abs((bounds[0][0] + bounds[1][0]) / 2 - (GERMANY_BOX.west + GERMANY_BOX.east) / 2),
    ).toBeLessThan(0.5);
  });

  it("also covers a 3840 by 1600 ultra wide screen", () => {
    const view = { width: 3840, height: 1600, padding: desktop };

    expect(span(hardBounds(view))).toBeGreaterThan(
      visibleLonSpan(view.width, fitZoom(GERMANY_BOX, view)),
    );
  });
});

describe("hardBounds for tall viewports", () => {
  const desktop = { top: 24, bottom: 72, left: 412, right: 248 };
  const mercator = (latitude: number) =>
    Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) / (2 * Math.PI);
  const coverZoom = (bounds: [[number, number], [number, number]], view: ViewSize) => {
    const spanX = (bounds[1][0] - bounds[0][0]) / 360;
    const spanY = mercator(bounds[1][1]) - mercator(bounds[0][1]);
    return Math.log2(Math.max(view.width / (512 * spanX), view.height / (512 * spanY)));
  };

  it("never forces the map to zoom in past the national view on a 1194 by 1600 portrait screen", () => {
    const view = { width: 1194, height: 1600, padding: desktop };

    expect(coverZoom(hardBounds(), view)).toBeGreaterThan(fitZoom(GERMANY_BOX, view));
    expect(coverZoom(hardBounds(view), view)).toBeLessThanOrEqual(fitZoom(GERMANY_BOX, view));
  });

  it("widens north and south around the middle of Germany and keeps the east and west", () => {
    const view = { width: 1194, height: 1600, padding: desktop };
    const bounds = hardBounds(view);
    const normal = hardBounds();

    expect(bounds[0][1]).toBeLessThan(normal[0][1]);
    expect(bounds[1][1]).toBeGreaterThan(normal[1][1]);
    expect(
      Math.abs(
        (mercator(bounds[0][1]) + mercator(bounds[1][1])) / 2 -
          (mercator(normal[0][1]) + mercator(normal[1][1])) / 2,
      ),
    ).toBeLessThan(0.003);
    expect(bounds[0][0]).toBeLessThanOrEqual(normal[0][0]);
  });
});

describe("hardBounds for a view with more padding on one side", () => {
  it("holds the whole view the national fit puts left of the right column, at 834 by 1194 with a panel open", () => {
    const view = {
      width: 834,
      height: 1194,
      padding: { top: 372, bottom: 72, left: 392, right: 16 },
    };
    const zoom = fitZoom(GERMANY_BOX, view);
    const worldPx = 512 * 2 ** zoom;
    const centreLon =
      (GERMANY_BOX.west + GERMANY_BOX.east) / 2 -
      (((view.padding.left - view.padding.right) / 2) * 360) / worldPx;
    const [[west], [east]] = hardBounds(view);

    expect(west).toBeLessThanOrEqual(centreLon - visibleLonSpan(view.width, zoom) / 2);
    expect(east).toBeGreaterThanOrEqual(centreLon + visibleLonSpan(view.width, zoom) / 2);
  });
});

describe("the bounds that hold the overview with the left slot open and closed", () => {
  const view = { width: 834, height: 1194 };
  const closed = { top: 372, bottom: 72, left: 16, right: 16 };
  const open = { top: 372, bottom: 72, left: 392, right: 16 };

  it("reach as far as either state needs", () => {
    const both = unionBounds(
      hardBounds({ ...view, padding: open }),
      hardBounds({ ...view, padding: closed }),
    );
    for (const padding of [open, closed]) {
      const [[west, south], [east, north]] = hardBounds({ ...view, padding });
      expect(both[0][0]).toBeLessThanOrEqual(west);
      expect(both[0][1]).toBeLessThanOrEqual(south);
      expect(both[1][0]).toBeGreaterThanOrEqual(east);
      expect(both[1][1]).toBeGreaterThanOrEqual(north);
    }
  });

  it("differ between the two states, which is why a swap clamped the ease", () => {
    expect(hardBounds({ ...view, padding: open })[0][0]).toBeLessThan(
      hardBounds({ ...view, padding: closed })[0][0],
    );
  });
});

describe("overshootKm", () => {
  it("is zero inside the box", () => {
    expect(overshootKm({ lng: 10, lat: 51 }, box)).toEqual({ x: 0, y: 0 });
  });

  it("is signed per axis outside the box", () => {
    const east = overshootKm({ lng: box.east + 1, lat: 51 }, box);
    const south = overshootKm({ lng: 10, lat: box.south - 1 }, box);

    expect(east.x).toBeCloseTo(kmPerDegreeLon(51), 3);
    expect(east.y).toBe(0);
    expect(south.y).toBeCloseTo(-110.574, 3);
  });
});

describe("rubberBand", () => {
  it("starts at zero, rises with slope one and never reaches its limit", () => {
    expect(rubberBand(0, 200)).toBe(0);
    expect(rubberBand(1, 200)).toBeCloseTo(1, 1);
    expect(rubberBand(10_000, 200)).toBeLessThan(200);
    expect(rubberBand(200, 200)).toBeCloseTo(100, 6);
  });

  it("is inverted by rubberBandInverse", () => {
    for (const shown of [0, 5, 50, 150, 199]) {
      expect(rubberBand(rubberBandInverse(shown, 200), 200)).toBeCloseTo(shown, 6);
    }
  });
});

describe("softPosition and rawPosition", () => {
  it("leave a centre inside the box where it is", () => {
    expect(softPosition({ lng: 10, lat: 51 }, box)).toEqual({ lng: 10, lat: 51 });
    expect(rawPosition({ lng: 10, lat: 51 }, box)).toEqual({ lng: 10, lat: 51 });
  });

  it("pull a centre outside towards the box, each axis on its own, and invert each other", () => {
    const raw = { lng: box.east + 3, lat: box.north + 2 };
    const shown = softPosition(raw, box);

    expect(shown.lng).toBeGreaterThan(box.east);
    expect(shown.lng).toBeLessThan(raw.lng);
    expect(shown.lat).toBeGreaterThan(box.north);
    expect(shown.lat).toBeLessThan(raw.lat);
    const back = rawPosition(shown, box);
    expect(back.lng).toBeCloseTo(raw.lng, 9);
    expect(back.lat).toBeCloseTo(raw.lat, 9);
  });

  it("never show more than the elastic limit", () => {
    const shown = softPosition({ lng: 10, lat: box.north + 1000 }, box);

    expect(overshootKm(shown, box).y).toBeLessThan(ELASTIC_LIMIT_KM);
    expect(overshootKm(shown, box).y).toBeGreaterThan(ELASTIC_LIMIT_KM * 0.9);
  });
});

describe("createElasticTracker", () => {
  it("damps a drag past the box as the requested camera moves on", () => {
    const tracker = createElasticTracker(box);
    const start = { lng: box.east - 0.5, lat: 51 };
    tracker.start(start);
    let requested = start;
    let shown = start;
    for (let index = 0; index < 60; index += 1) {
      requested = { lng: requested.lng + 0.05, lat: 51 };
      shown = tracker.next(requested);
    }

    expect(shown).toEqual(softPosition(requested, box));
    expect(shown.lng).toBeLessThan(requested.lng - 0.5);
  });

  it("starts a gesture outside the box where the camera is, without a jump", () => {
    const tracker = createElasticTracker(box);
    const outside = softPosition({ lng: box.east + 2, lat: 51 }, box);
    tracker.start(outside, { widen: false });

    const still = tracker.next(outside);
    const moved = tracker.next({ lng: outside.lng + 0.01, lat: 51 });

    expect(still.lng).toBeCloseTo(outside.lng, 9);
    expect(moved.lng).toBeGreaterThan(outside.lng);
    expect(moved.lng - outside.lng).toBeLessThan(0.01);
  });

  it("follows a move inside the box one to one", () => {
    const tracker = createElasticTracker(box);
    tracker.start({ lng: 10, lat: 51 });

    expect(tracker.next({ lng: 11, lat: 52 })).toEqual({ lng: 11, lat: 52 });
  });

  it("lets a drag back towards Germany pull the camera in", () => {
    const tracker = createElasticTracker(box);
    tracker.start({ lng: 10, lat: 51 });
    const far = tracker.next({ lng: box.east + 3, lat: 51 });
    const back = tracker.next({ lng: box.east + 1, lat: 51 });

    expect(back.lng).toBeLessThan(far.lng);
    expect(tracker.next({ lng: 12, lat: 51 })).toEqual({ lng: 12, lat: 51 });
  });
});

const PARIS = { lng: 2.3522, lat: 48.8566 };
const WARSAW = { lng: 21.0122, lat: 52.2297 };

function pastBoxKm(point: { lng: number; lat: number }): number {
  const { x, y } = overshootKm(point, box);
  return Math.hypot(x, y);
}

describe("a gesture that starts outside the box", () => {
  it("measures Paris below and Warsaw beyond the elastic limit", () => {
    expect(pastBoxKm(PARIS)).toBeGreaterThan(150);
    expect(pastBoxKm(PARIS)).toBeLessThan(ELASTIC_LIMIT_KM);
    expect(pastBoxKm(WARSAW)).toBeGreaterThan(ELASTIC_LIMIT_KM);
  });

  it.each([
    ["Paris", PARIS],
    ["Warsaw", WARSAW],
    ["exactly the limit east", { lng: box.east + ELASTIC_LIMIT_KM / kmPerDegreeLon(51), lat: 51 }],
  ])("starts at %s without a jump and pans freely towards Germany", (_name, start) => {
    const tracker = createElasticTracker(box);
    tracker.start(start, { widen: true });

    expect(tracker.next(start)).toEqual(start);
    const inward = { lng: start.lng + (start.lng < 10 ? 0.2 : -0.2), lat: start.lat + 0.1 };
    expect(tracker.next(inward)).toEqual(inward);
  });

  it("damps only the overshoot the gesture adds beyond its start", () => {
    const tracker = createElasticTracker(box);
    const gestureBox = tracker.start(PARIS, { widen: true });
    const further = { lng: PARIS.lng - 2, lat: PARIS.lat };
    const shown = tracker.next(further);

    expect(gestureBox.west).toBeCloseTo(PARIS.lng, 9);
    expect(shown.lng).toBeLessThan(PARIS.lng);
    expect(shown.lng).toBeGreaterThan(further.lng);
    expect(releaseTarget(shown, gestureBox, box, null)).toEqual({ lng: PARIS.lng, lat: PARIS.lat });
  });

  it("keeps the selected train inside the gesture box", () => {
    const tracker = createElasticTracker(box);
    const gestureBox = tracker.start({ lng: 10, lat: 51 }, { widen: true, keep: [WARSAW] });

    expect(isOutside(WARSAW, gestureBox)).toBe(false);
    expect(tracker.next(WARSAW)).toEqual(WARSAW);
  });

  it("continues the rubber band of an interrupted ease back instead of widening", () => {
    const tracker = createElasticTracker(box);
    const shown = softPosition({ lng: box.east + 2, lat: 51 }, box);
    const gestureBox = tracker.start(shown, { widen: false });

    expect(gestureBox).toEqual(box);
    expect(tracker.next(shown).lng).toBeCloseTo(shown.lng, 9);
  });

  it("widens anyway when the start lies beyond what the rubber band can show", () => {
    const tracker = createElasticTracker(box);
    tracker.start(WARSAW, { widen: false });

    expect(tracker.next(WARSAW)).toEqual(WARSAW);
  });
});

describe("releaseTarget", () => {
  const outside = { lng: box.east + 1, lat: 51 };

  it("eases a camera outside the gesture box back to its edge", () => {
    expect(releaseTarget(outside, box, box, null)).toEqual({ lng: box.east, lat: 51 });
  });

  it("leaves a camera inside the gesture box where it is", () => {
    expect(releaseTarget({ lng: 10, lat: 51 }, box, box, null)).toBeNull();
  });

  it("never eases back while the selected train is outside the box", () => {
    expect(releaseTarget(outside, box, box, PARIS)).toBeNull();
    expect(releaseTarget(outside, box, box, { lng: 10, lat: 51 })).toEqual({
      lng: box.east,
      lat: 51,
    });
  });
});

describe("includePoints", () => {
  it("grows the box just enough to hold every point", () => {
    const grown = includePoints(box, [PARIS, WARSAW]);

    expect(grown).toEqual({ ...box, west: PARIS.lng, east: WARSAW.lng });
    expect(includePoints(box, [{ lng: 10, lat: 51 }])).toEqual(box);
  });
});

describe("clampToBox", () => {
  it("moves a centre outside back to the nearest point of the box", () => {
    expect(clampToBox({ lng: box.east + 3, lat: box.south - 1 }, box)).toEqual({
      lng: box.east,
      lat: box.south,
    });
  });

  it("keeps a centre inside", () => {
    expect(clampToBox({ lng: 9, lat: 50 }, box)).toEqual({ lng: 9, lat: 50 });
  });
});

describe("unionBounds", () => {
  it("covers both boxes", () => {
    expect(
      unionBounds(
        [
          [1, 2],
          [5, 6],
        ],
        [
          [0, 3],
          [4, 9],
        ],
      ),
    ).toEqual([
      [0, 2],
      [5, 9],
    ]);
  });
});
