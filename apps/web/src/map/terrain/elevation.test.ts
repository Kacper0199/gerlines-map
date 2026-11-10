import { describe, expect, it } from "vitest";
import {
  CAR_LIFT_M,
  COVER_DEADBAND_M,
  COVER_RAMP_M,
  carElevation,
  drawnHeight,
  FLAT,
  gradeAngleDeg,
  MESH_LIFT_M,
  markerLiftM,
  metresPerPixel,
  reliefCover,
  selectedCover,
  TRAIN_LIFT_PX,
  terrainElevation,
} from "./elevation.ts";

describe("drawnHeight", () => {
  it("is zero on a flat map whatever the shape holds", () => {
    expect(drawnHeight(512, FLAT)).toBe(0);
    expect(drawnHeight(-3, FLAT)).toBe(0);
  });

  it("multiplies the baked height by the exaggeration of the terrain", () => {
    const elevation = terrainElevation(1.5);
    expect(drawnHeight(400, elevation)).toBeCloseTo(600 + elevation.liftM, 9);
  });

  it("keeps heights below sea level negative", () => {
    const elevation = terrainElevation(1.5);
    expect(drawnHeight(-4, elevation)).toBeCloseTo(-6 + elevation.liftM, 9);
  });

  it("treats a missing or non finite baked height as sea level", () => {
    const elevation = terrainElevation(1.5);
    expect(drawnHeight(Number.NaN, elevation)).toBeCloseTo(elevation.liftM, 9);
    expect(drawnHeight(Number.POSITIVE_INFINITY, elevation)).toBeCloseTo(elevation.liftM, 9);
  });
});

describe("lift", () => {
  it("raises a marker by a few pixels of the ground at the view", () => {
    expect(markerLiftM(11, 50)).toBeCloseTo(TRAIN_LIFT_PX * metresPerPixel(11, 50), 9);
    expect(metresPerPixel(14, 50)).toBeCloseTo(3.07, 1);
  });

  it("grows by a factor of two for every zoom level out", () => {
    expect(markerLiftM(10, 50) / markerLiftM(11, 50)).toBeCloseTo(2, 9);
  });

  it("never drops below what the terrain mesh can cut, until zoom 15", () => {
    expect(markerLiftM(13.6, 50)).toBeGreaterThanOrEqual(MESH_LIFT_M * 0.69);
    expect(markerLiftM(13.6, 50)).toBeGreaterThan(TRAIN_LIFT_PX * metresPerPixel(13.6, 50));
    expect(markerLiftM(13, 60)).toBeGreaterThanOrEqual(MESH_LIFT_M);
    expect(markerLiftM(15, 50)).toBeCloseTo(TRAIN_LIFT_PX * metresPerPixel(15, 50), 9);
    expect(markerLiftM(16.5, 50)).toBeCloseTo(TRAIN_LIFT_PX * metresPerPixel(16.5, 50), 9);
  });

  it("stretches with the tilt, because the far half of a pitched view is coarser", () => {
    expect(markerLiftM(11, 50, 60) / markerLiftM(11, 50, 0)).toBeCloseTo(2, 9);
    expect(markerLiftM(11, 50, 75)).toBeCloseTo(markerLiftM(11, 50, 60), 9);
    expect(markerLiftM(11, 50, -10)).toBeCloseTo(markerLiftM(11, 50, 0), 9);
  });

  it("lifts cars by a fixed height on terrain and not at all on a flat map", () => {
    expect(carElevation(terrainElevation(1.5, 40))).toEqual({ scale: 1.5, liftM: CAR_LIFT_M });
    expect(carElevation(FLAT)).toEqual(FLAT);
  });

  it("adds the lift to the exaggerated height", () => {
    expect(drawnHeight(100, terrainElevation(1.5, 7))).toBeCloseTo(157, 9);
  });
});

describe("terrainElevation", () => {
  it("is flat for a scale of zero", () => {
    expect(terrainElevation(0)).toEqual(FLAT);
  });

  it("rejects a negative or non finite scale as flat", () => {
    expect(terrainElevation(-1)).toEqual(FLAT);
    expect(terrainElevation(Number.NaN)).toEqual(FLAT);
  });
});

describe("gradeAngleDeg", () => {
  it("keeps the real grade on a flat map, where cars pitch by the track alone", () => {
    expect(gradeAngleDeg(10, 100, FLAT)).toBeCloseTo((Math.asin(-0.1) * 180) / Math.PI, 9);
  });

  it("follows the exaggerated relief when terrain is on", () => {
    expect(gradeAngleDeg(10, 100, terrainElevation(1.5))).toBeCloseTo(
      (Math.atan2(-15, 100) * 180) / Math.PI,
      9,
    );
  });

  it("is zero without a drop", () => {
    expect(gradeAngleDeg(0, 18, terrainElevation(1.5))).toBeCloseTo(0, 12);
  });

  it("stays finite for a zero span", () => {
    expect(Number.isFinite(gradeAngleDeg(1, 0, FLAT))).toBe(true);
    expect(Number.isFinite(gradeAngleDeg(1, 0, terrainElevation(1.5)))).toBe(true);
  });
});

describe("reliefCover", () => {
  it("is zero where the car base stands on or above the ground, and within the deadband", () => {
    expect(reliefCover(412, 412)).toBe(0);
    expect(reliefCover(412, 430)).toBe(0);
    expect(reliefCover(412 + COVER_DEADBAND_M, 412)).toBe(0);
  });

  it("is one when the ground stands a car's height above the base, where the cars are buried", () => {
    expect(reliefCover(612, 412)).toBe(1);
    expect(reliefCover(412 + COVER_DEADBAND_M + COVER_RAMP_M, 412)).toBe(1);
  });

  it("grows evenly over the ramp after the deadband", () => {
    expect(reliefCover(412 + COVER_DEADBAND_M + COVER_RAMP_M / 2, 412)).toBeCloseTo(0.5, 12);
  });

  it("counts ground that is not known yet as covered, because the relief drawn there may hide the cars", () => {
    expect(reliefCover(undefined, 412)).toBe(1);
    expect(reliefCover(null, 412)).toBe(1);
    expect(reliefCover(Number.NaN, 412)).toBe(1);
  });

  it("is zero for a train height that is not a number", () => {
    expect(reliefCover(612, Number.NaN)).toBe(0);
  });
});

describe("selectedCover", () => {
  const selected = { lon: 9.7, lat: 48.5, z: 1112 };

  it("measures from the car base: the drawn height without the marker lift plus the car lift", () => {
    const lift = 2.4;
    const base = selected.z - lift + CAR_LIFT_M;
    const ground = () => base + COVER_DEADBAND_M + COVER_RAMP_M / 2;
    expect(selectedCover(ground, selected, lift, true)).toBeCloseTo(0.5, 12);
  });

  it("asks for the ground at the selected train", () => {
    const asked: [number, number][] = [];
    selectedCover(
      (lon, lat) => {
        asked.push([lon, lat]);
        return 0;
      },
      selected,
      0,
      true,
    );
    expect(asked).toEqual([[9.7, 48.5]]);
  });

  it("is zero without the relief and does not look the ground up", () => {
    let calls = 0;
    const ground = () => {
      calls += 1;
      return 5000;
    };
    expect(selectedCover(ground, selected, 0, false)).toBe(0);
    expect(calls).toBe(0);
  });

  it("is zero when the map has no terrain to ask", () => {
    expect(selectedCover(undefined, selected, 0, true)).toBe(0);
  });

  it("is one while the tile's ground is unknown", () => {
    expect(selectedCover(() => undefined, selected, 0, true)).toBe(1);
  });
});
