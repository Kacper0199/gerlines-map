import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCatalog } from "../src/catalog.ts";
import { bodyLayout, lowBottomOf } from "../src/geometry/body.ts";
import { buildBody } from "../src/geometry/car-body.ts";
import {
  buildFront,
  cheekOffset,
  type FrontBands,
  type FrontDecal,
  type FrontSpec,
  frontLevels,
  lampPod,
  PLAN_EXPONENTS,
  planReach,
  planShape,
  screenWidthAt,
  setbackProfile,
} from "../src/geometry/front.ts";
import { LODS } from "../src/geometry/lod.ts";
import { loftScale, type NoseLoft, sectionWidth } from "../src/geometry/loft.ts";
import { cross, MeshBuilder, sub, type Vec3 } from "../src/geometry/mesh.ts";
import {
  type Facets,
  isLamp,
  lampLenses,
  logoParts,
  screenPaneWidth,
} from "../src/geometry/panes.ts";
import { fullRing, ringParameter, type SectionParams } from "../src/geometry/profile.ts";
import { emitGrid } from "../src/geometry/surface.ts";
import { type Slot, slotU } from "../src/palette.ts";
import { type CarSpec, resolveCar } from "../src/spec.ts";

const SECTION: SectionParams = {
  halfWidth: 1.45,
  height: 3.9,
  eave: 3.3,
  sideBottom: 1.1,
  bottom: 0.6,
  tuck: 0.1,
  roofExponent: 2.4,
  roofSegments: 6,
  lowerSegments: 3,
};

function faceNormals(mesh: MeshBuilder): { normal: Vec3; centroid: Vec3 }[] {
  const out: { normal: Vec3; centroid: Vec3 }[] = [];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 9) {
    const a: Vec3 = [p[i] as number, p[i + 1] as number, p[i + 2] as number];
    const b: Vec3 = [p[i + 3] as number, p[i + 4] as number, p[i + 5] as number];
    const c: Vec3 = [p[i + 6] as number, p[i + 7] as number, p[i + 8] as number];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    out.push({
      normal: [
        (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number),
        (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number),
        (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number),
      ],
      centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
    });
  }
  return out;
}

describe("cross-section", () => {
  const ring = fullRing(SECTION, [2.0, 2.9]);

  it("is mirror symmetric about the car axis", () => {
    const n = ring.points.length;
    for (let i = 1; i < n / 2; i++) {
      const left = ring.points[i];
      const right = ring.points[n - i];
      expect(right?.y).toBeCloseTo(-(left?.y ?? 0), 9);
      expect(right?.z).toBeCloseTo(left?.z ?? 0, 9);
    }
  });

  it("starts at the roof centre and passes the bottom centre", () => {
    expect(ring.points[0]).toEqual({ y: 0, z: SECTION.height });
    expect(ring.points[ring.points.length / 2]).toEqual({ y: 0, z: SECTION.bottom });
  });

  it("keeps the side wall straight at the full width with the requested levels on it", () => {
    const [top, bottom] = ring.leftWall;
    const wall = ring.points.slice(top, bottom + 1);
    expect(wall.every((q) => Math.abs(q.y - SECTION.halfWidth) < 1e-9)).toBe(true);
    expect(wall.map((q) => q.z)).toEqual([SECTION.eave, 2.9, 2.0, SECTION.sideBottom]);
  });

  it("marks the lower body edges as creases and stays inside the width", () => {
    expect(ring.creases.size).toBe(2);
    for (const c of ring.creases) expect(ring.points[c]?.z).toBeCloseTo(SECTION.bottom, 9);
    expect(ring.points.every((q) => Math.abs(q.y) <= SECTION.halfWidth + 1e-9)).toBe(true);
  });

  it("parameterises the half ring from 0 at the roof to 1 at the bottom", () => {
    const s = ringParameter(ring.points);
    expect(s[0]).toBe(0);
    expect(s[ring.points.length / 2]).toBe(1);
    expect(s.slice(0, ring.points.length / 2 + 1)).toEqual(
      [...s.slice(0, ring.points.length / 2 + 1)].sort((a, b) => a - b),
    );
  });
});

describe("tumblehome", () => {
  it("insets the wall top by the tumblehome and keeps the wall bottom at the full width", () => {
    const p: SectionParams = { ...SECTION, tumblehome: 0.08 };
    const ring = fullRing(p, [1.5, 2.5]);
    const [top, bottom] = ring.leftWall;
    expect((ring.points[top] as { y: number }).y).toBeCloseTo(SECTION.halfWidth - 0.08, 9);
    expect((ring.points[bottom] as { y: number }).y).toBeCloseTo(SECTION.halfWidth, 9);
    for (let i = top; i < bottom; i++)
      expect((ring.points[i + 1] as { y: number }).y).toBeGreaterThanOrEqual(
        (ring.points[i] as { y: number }).y - 1e-12,
      );
  });

  it("leaves the section unchanged without a tumblehome", () => {
    expect(fullRing({ ...SECTION, tumblehome: 0 }, [2]).points).toEqual(
      fullRing(SECTION, [2]).points,
    );
  });
});

describe("lofted surface", () => {
  it("faces every triangle of a lofted ring away from the car axis", () => {
    const ring = fullRing(SECTION);
    const rows = [-5, 0, 5].map((x) => ring.points.map((q) => [x, q.y, q.z] as Vec3));
    const mesh = new MeshBuilder();
    emitGrid(mesh, { rows, closed: true, creaseColumns: ring.creases }, () => "body");
    const axisZ = (SECTION.height + SECTION.bottom) / 2;
    const faces = faceNormals(mesh);
    expect(faces.length).toBe(2 * 2 * ring.points.length);
    for (const { normal, centroid } of faces) {
      const outward = normal[1] * centroid[1] + normal[2] * (centroid[2] - axisZ);
      expect(outward).toBeGreaterThan(0);
    }
  });

  it("splits vertex normals at crease columns and keeps them unit length", () => {
    const ring = fullRing(SECTION);
    const rows = [0, 4].map((x) => ring.points.map((q) => [x, q.y, q.z] as Vec3));
    const mesh = new MeshBuilder();
    emitGrid(mesh, { rows, closed: true, creaseColumns: ring.creases }, () => "body");
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const l = Math.hypot(
        mesh.normals[i] as number,
        mesh.normals[i + 1] as number,
        mesh.normals[i + 2] as number,
      );
      expect(l).toBeCloseTo(1, 6);
    }
    const bottomNormals = new Set<string>();
    const edge = [...ring.creases][0] as number;
    const edgePoint = ring.points[edge];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (
        Math.abs((mesh.positions[i + 1] as number) - (edgePoint?.y ?? 0)) < 1e-9 &&
        Math.abs((mesh.positions[i + 2] as number) - (edgePoint?.z ?? 0)) < 1e-9
      ) {
        bottomNormals.add(
          `${(mesh.normals[i + 1] as number).toFixed(3)},${(mesh.normals[i + 2] as number).toFixed(3)}`,
        );
      }
    }
    expect(bottomNormals.size).toBe(2);
  });

  it("drops degenerate faces where a ring collapses to a point", () => {
    const ring = fullRing(SECTION);
    const outer = ring.points.map((q) => [0, q.y, q.z] as Vec3);
    const centre = ring.points.map(() => [0, 0, 2] as Vec3);
    const mesh = new MeshBuilder();
    emitGrid(mesh, { rows: [outer, centre], closed: true }, () => "body");
    expect(mesh.triangleCount).toBe(ring.points.length);
  });
});

describe("mesh builder", () => {
  it("builds a closed box with outward faces", () => {
    const mesh = new MeshBuilder();
    mesh.box([-1, -1, 0], [1, 1, 2], "body");
    expect(mesh.triangleCount).toBe(12);
    for (const { normal, centroid } of faceNormals(mesh)) {
      const outward =
        normal[0] * centroid[0] + normal[1] * centroid[1] + normal[2] * (centroid[2] - 1);
      expect(outward).toBeGreaterThan(0);
    }
  });

  it("builds a wheel whose faces point away from its axle", () => {
    const mesh = new MeshBuilder();
    mesh.wheel([0, 0.76, 0.46], 0.46, 0.14, 8, "bogie");
    expect(mesh.triangleCount).toBe(8 * 2 + 2 * 6);
    for (const { normal, centroid } of faceNormals(mesh)) {
      const outward =
        normal[0] * centroid[0] +
        normal[1] * (centroid[1] - 0.76) +
        normal[2] * (centroid[2] - 0.46);
      expect(outward).toBeGreaterThan(0);
    }
  });
});

describe("measured fronts", () => {
  const front: FrontSpec = {
    length: 2.0,
    tipZ: 1.0,
    faceTop: 1.6,
    bottom: null,
    bottomSetback: 0.2,
    screenBottom: 1.8,
    screenTop: 3.6,
    screenBottomSetback: 0.1,
    screenTopSetback: 0.9,
    screenWidth: 0.86,
    plan: PLAN_EXPONENTS.flat,
    straight: 1.4,
    mask: { bottom: 1.55, top: 3.75, width: 0.95 },
    lamps: { bottom: 1.0, top: 1.25, inner: 0.55, outer: 0.85 },
    skirtTop: 0.75,
    stripe: "across",
    frontStripe: null,
    cabWindow: true,
    sideWindow: null,
    cabLength: 3.2,
  };
  const bands: FrontBands = {
    bottom: 0.55,
    height: 4.2,
    sill: 1.7,
    top: 2.7,
    stripeBottom: 1.3,
    stripeTop: 1.5,
    eave: 3.7,
    bandZ: 4.0,
    windowBand: true,
  };
  const levels = [...frontLevels(front, "full"), 1.3, 1.5, 1.7, 2.7, 4.0];
  const ring = fullRing(
    { ...SECTION, height: 4.2, eave: 3.7, bottom: 0.55, sideBottom: 0.8 },
    levels,
  );
  const mesh = buildFront(front, bands, ring, "full");

  function facesOf(slot: Slot): number[][] {
    const out: number[][] = [];
    const u = slotU(slot);
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      if (Math.abs((mesh.uvs[t * 6] as number) - u) > 1e-9) continue;
      out.push(mesh.positions.slice(t * 9, t * 9 + 9) as number[]);
    }
    return out;
  }
  const zs = (faces: number[][]) => faces.flatMap((f) => [f[2], f[5], f[8]] as number[]);

  it("sweeps a diving stripe from the side band at the nose base down to the front band at the tip", () => {
    const dive: FrontSpec = {
      ...front,
      length: 5,
      straight: 0.5,
      plan: PLAN_EXPONENTS.pointed,
      stripe: "dive",
      frontStripe: { bottom: 0.7, top: 0.85 },
    };
    const built = buildFront(dive, bands, ring, "full");
    const u = slotU("stripe");
    const points: number[][] = [];
    for (let t = 0; t < built.positions.length / 9; t++) {
      if (Math.abs((built.uvs[t * 6] as number) - u) > 1e-9) continue;
      for (let v = 0; v < 3; v++)
        points.push(built.positions.slice(t * 9 + v * 3, t * 9 + v * 3 + 3));
    }
    expect(points.length).toBeGreaterThan(0);
    const atTip = points.filter((p) => (p[0] as number) > 4.5);
    const atBase = points.filter((p) => (p[0] as number) < 0.6);
    expect(atTip.length).toBeGreaterThan(0);
    expect(atBase.length).toBeGreaterThan(0);
    for (const p of atTip) expect(p[2] as number).toBeLessThan(0.85 + 0.15);
    for (const p of atBase) expect(p[2] as number).toBeGreaterThan(bands.stripeBottom - 0.15);
    for (const p of points) {
      expect(p[2] as number).toBeGreaterThan(0.7 - 0.05);
      expect(p[2] as number).toBeLessThan(bands.stripeTop + 0.05);
    }
  });

  it("puts a bounded cab side window on the nose side behind the windscreen edge", () => {
    const side: FrontSpec = {
      ...front,
      length: 5,
      straight: 0.5,
      plan: PLAN_EXPONENTS.round,
      sideWindow: { from: 1.5, to: 4.5 },
    };
    const built = buildFront(side, { ...bands, windowBand: false }, ring, "full");
    const u = slotU("window");
    let lifted = 0;
    for (let t = 0; t < built.positions.length / 9; t++) {
      if (Math.abs((built.uvs[t * 6] as number) - u) > 1e-9) continue;
      const zsOf = [2, 5, 8].map((i) => built.positions[t * 9 + i] as number);
      const inBand = zsOf.every((z) => z >= bands.sill - 1e-6 && z <= bands.top + 1e-6);
      const xs = [0, 3, 6].map((i) => built.positions[t * 9 + i] as number);
      if (inBand && xs.every((x) => x > 0.5 && x < 5 - 1.5 + 1e-6)) lifted++;
    }
    expect(lifted).toBeGreaterThan(0);
  });

  it("draws the stripe as a level band across the front, without a fang", () => {
    const stripe = zs(facesOf("stripe"));
    expect(stripe.length).toBeGreaterThan(0);
    for (const z of stripe) {
      expect(z).toBeGreaterThanOrEqual(bands.stripeBottom - 1e-6);
      expect(z).toBeLessThanOrEqual(bands.stripeTop + 1e-6);
    }
  });

  it("keeps the windscreen, the mask and the skirt within their measured heights", () => {
    for (const z of zs(facesOf("window"))) {
      expect(z).toBeGreaterThanOrEqual(Math.min(front.screenBottom, bands.sill) - 1e-6);
      expect(z).toBeLessThanOrEqual(front.screenTop + 1e-6);
    }
    const pod = lampPod(front.lamps as NonNullable<typeof front.lamps>);
    for (const z of zs(facesOf("mask"))) {
      const inPod = z >= pod.bottom - 1e-6 && z <= pod.top + 1e-6;
      expect(inPod || z >= 1.55 - 1e-6).toBe(true);
    }
    for (const z of zs(facesOf("skirt"))) expect(z).toBeLessThanOrEqual(0.75 + 1e-6);
    expect(facesOf("light").length).toBeGreaterThan(0);
  });

  it("reaches the tip at the measured length and joins the body section at its base", () => {
    let maxX = 0;
    for (let i = 0; i < mesh.positions.length; i += 3)
      maxX = Math.max(maxX, mesh.positions[i] as number);
    expect(maxX).toBeCloseTo(front.length, 6);
    const onRing = (y: number, z: number) =>
      ring.points.some((q, i) => {
        const b = ring.points[(i + 1) % ring.points.length] as typeof q;
        const cross = (b.y - q.y) * (z - q.z) - (b.z - q.z) * (y - q.y);
        const inside =
          Math.min(q.y, b.y) - 1e-6 <= y &&
          y <= Math.max(q.y, b.y) + 1e-6 &&
          Math.min(q.z, b.z) - 1e-6 <= z &&
          z <= Math.max(q.z, b.z) + 1e-6;
        return inside && Math.abs(cross) < 1e-6;
      });
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (Math.abs(mesh.positions[i] as number) > 1e-9) continue;
      const y = mesh.positions[i + 1] as number;
      const z = mesh.positions[i + 2] as number;
      if (Math.abs(z - bands.bottom) < 1e-9) continue;
      expect(onRing(y, z)).toBe(true);
    }
  });

  it("bounds the cab side window to its measured setbacks", () => {
    const bounded = buildFront(
      { ...front, sideWindow: { from: 0.8, to: 1.9 } },
      bands,
      ring,
      "full",
    );
    const wall = SECTION.halfWidth - 1e-6;
    const sideGlass: number[] = [];
    for (let t = 0; t < bounded.positions.length / 9; t++) {
      if (Math.abs((bounded.uvs[t * 6] as number) - slotU("window")) > 1e-9) continue;
      const p = bounded.positions.slice(t * 9, t * 9 + 9) as number[];
      if ([p[1], p[4], p[7]].every((y) => Math.abs(y as number) >= wall))
        sideGlass.push(p[0] as number, p[3] as number, p[6] as number);
    }
    expect(sideGlass.length).toBeGreaterThan(0);
    expect(Math.min(...sideGlass)).toBeCloseTo(front.length - 1.9, 6);
    expect(Math.max(...sideGlass)).toBeCloseTo(front.length - 0.8, 6);
    const unbounded = mesh.positions.length;
    expect(bounded.positions.length).toBeGreaterThan(unbounded);
  });

  it("reaches below the body ahead of the leading wheels and no further back", () => {
    const apron = { bottom: 0.3, start: 0.9 };
    const low = buildFront(front, bands, ring, "full", apron);
    const p = low.positions;
    let lowest = Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const z = p[i + 2] as number;
      lowest = Math.min(lowest, z);
      if (z < bands.bottom - 1e-6)
        expect(p[i] as number).toBeGreaterThanOrEqual(apron.start - 1e-6);
    }
    expect(lowest).toBeCloseTo(apron.bottom, 9);
    const s = setbackProfile(front, apron.bottom, bands.height);
    expect(s(apron.bottom)).toBeCloseTo(front.bottomSetback, 9);
  });

  it("follows a profile by height through its points and reaches the roof at the front's length", () => {
    const profileByHeight = [
      [0.6, 0.5],
      [1.0, 0.0],
      [1.4, 0.3],
      [2.5, 1.2],
      [3.6, 1.8],
    ] as const;
    const s = setbackProfile({ ...front, profileByHeight }, bands.bottom, bands.height);
    for (const [z, setback] of profileByHeight) expect(s(z)).toBeCloseTo(setback, 9);
    expect(s(bands.height)).toBeCloseTo(front.length, 9);
    expect(s(bands.bottom)).toBeCloseTo(0.5, 9);
    for (let z = bands.bottom; z <= bands.height; z += 0.01) {
      expect(s(z)).toBeGreaterThanOrEqual(-1e-9);
      expect(s(z)).toBeLessThanOrEqual(front.length + 1e-9);
    }
    const nearRoof = [...profileByHeight, [bands.height - 0.01, 1.7]] as const;
    const roofed = setbackProfile(
      { ...front, profileByHeight: nearRoof },
      bands.bottom,
      bands.height,
    );
    expect(roofed(bands.height)).toBeCloseTo(front.length, 9);
    const plain = setbackProfile({ ...front, profileByHeight: null }, bands.bottom, bands.height);
    expect(plain(front.screenTop)).toBeCloseTo(front.screenTopSetback, 9);
  });

  it("interpolates the side profile without overshoot", () => {
    const s = setbackProfile(front, bands.bottom, bands.height);
    for (let z = bands.bottom; z <= bands.height; z += 0.01) {
      expect(s(z)).toBeGreaterThanOrEqual(-1e-9);
      expect(s(z)).toBeLessThanOrEqual(front.length + 1e-9);
    }
    expect(s(front.tipZ)).toBeCloseTo(0, 9);
    expect(s(1.3)).toBeCloseTo(0, 9);
    expect(s(bands.height)).toBeCloseTo(front.length, 9);
  });
});

describe("measured streamlined nose (side profile, plan, tip gap, body bottom)", () => {
  const profile: [number, number][] = [
    [1.2, 0.3],
    [0.3, 0.45],
    [0, 0.85],
    [0.35, 1.45],
    [1.0, 2.05],
    [2.0, 2.75],
    [3.5, 3.5],
    [5.0, 3.85],
    [6.0, 3.89],
  ];
  const plan: [number, number][] = [
    [0.3, 0.5],
    [0.9, 0.73],
    [1.8, 0.88],
    [2.9, 1.0],
  ];
  const base: FrontSpec = {
    length: 6.0,
    tipZ: 0.85,
    faceTop: 0.85,
    bottom: 0.3,
    bottomSetback: 1.2,
    screenBottom: 2.0,
    screenTop: 3.4,
    screenBottomSetback: 0.95,
    screenTopSetback: 3.4,
    screenWidth: 0.6,
    plan: PLAN_EXPONENTS.round,
    straight: 0.5,
    mask: null,
    lamps: null,
    skirtTop: null,
    stripe: "sides",
    frontStripe: null,
    cabWindow: false,
    sideWindow: null,
    cabLength: 6.0,
  };
  const front: FrontSpec = { ...base, sideProfile: profile, planWidths: plan };

  it("passes the side profile through every measured point and keeps it within the front", () => {
    const s = setbackProfile(front, 0.3, 3.89);
    for (const [setback, z] of profile) expect(s(z)).toBeCloseTo(setback, 9);
    for (let z = 0.3; z <= 3.89; z += 0.01) {
      expect(s(z)).toBeGreaterThanOrEqual(-1e-9);
      expect(s(z)).toBeLessThanOrEqual(front.length + 1e-9);
    }
  });

  it("rises monotonically above the tip and falls monotonically below it", () => {
    const s = setbackProfile(front, 0.3, 3.89);
    for (let z = 0.86; z < 3.89; z += 0.01) expect(s(z + 0.01)).toBeGreaterThanOrEqual(s(z) - 1e-9);
    for (let z = 0.84; z > 0.3; z -= 0.01) expect(s(z - 0.01)).toBeGreaterThanOrEqual(s(z) - 1e-9);
  });

  it("turns the measured plan into a reach from the centre (1) to the side (0) and inverts it", () => {
    const shape = planShape(front);
    expect(shape.span).toBeCloseTo(2.9, 9);
    expect(shape.reach(0)).toBeCloseTo(1, 9);
    expect(shape.reach(1)).toBeCloseTo(0, 9);
    for (const [setback, fraction] of plan)
      expect(shape.reach(fraction)).toBeCloseTo(1 - setback / 2.9, 9);
    for (let u = 0; u < 1; u += 0.02) {
      expect(shape.reach(u + 0.02)).toBeLessThanOrEqual(shape.reach(u) + 1e-9);
      expect(shape.fraction(shape.reach(u))).toBeCloseTo(u, 6);
    }
  });

  it("keeps the superellipse plan of a front without measured widths", () => {
    const shape = planShape(base);
    expect(shape.span).toBeNull();
    for (let u = 0; u <= 1; u += 0.05) expect(shape.reach(u)).toBe(planReach(u, base.plan));
  });

  it("sets the measured plan back with the profile: full width from the plan length behind the local tip", () => {
    const bands: FrontBands = {
      bottom: 0.3,
      height: 3.89,
      sill: 2.0,
      top: 2.8,
      stripeBottom: 1.66,
      stripeTop: 1.82,
      eave: 3.3,
      bandZ: 3.8,
      windowBand: false,
    };
    const levels = [...frontLevels(front, "full"), 1.66, 1.82, 2.0, 2.8, 3.8];
    const ring = fullRing(
      { ...SECTION, height: 3.89, eave: 3.3, bottom: 0.3, sideBottom: 1.1 },
      levels,
    );
    const mesh = buildFront(front, bands, ring, "full");
    const p = mesh.positions;
    let tip = -Infinity;
    for (let i = 0; i < p.length; i += 3) tip = Math.max(tip, p[i] as number);
    expect(tip).toBeCloseTo(front.length, 6);
    for (let i = 0; i < p.length; i += 3) {
      const z = p[i + 2] as number;
      if (Math.abs(z - 0.85) > 1e-6) continue;
      const x = p[i] as number;
      const y = Math.abs(p[i + 1] as number);
      if (x > front.length - 2.9 + 1e-6) expect(y).toBeLessThan(1.45 + 1e-6);
    }
  });

  it("draws a measured stripe curve down the nose side to the tip instead of the side band", () => {
    const curve: [number, number, number][] = [
      [6.0, 1.66, 1.82],
      [3.0, 1.35, 1.5],
      [1.0, 0.95, 1.1],
      [0, 0.8, 0.95],
    ];
    const striped: FrontSpec = {
      ...front,
      stripe: "dive",
      frontStripe: { bottom: 0.8, top: 0.95 },
      stripeCurve: curve,
    };
    const bands: FrontBands = {
      bottom: 0.3,
      height: 3.89,
      sill: 2.0,
      top: 2.8,
      stripeBottom: 1.66,
      stripeTop: 1.82,
      eave: 3.3,
      bandZ: 3.8,
      windowBand: false,
    };
    const ring = fullRing({ ...SECTION, height: 3.89, eave: 3.3, bottom: 0.3, sideBottom: 1.1 }, [
      ...frontLevels(striped, "full"),
      1.66,
      1.82,
      2.0,
      2.8,
      3.8,
    ]);
    const mesh = buildFront(striped, bands, ring, "full");
    const u = slotU("stripe");
    const stripe: number[][] = [];
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      if (Math.abs((mesh.uvs[t * 6] as number) - u) > 1e-9) continue;
      stripe.push(mesh.positions.slice(t * 9, t * 9 + 9) as number[]);
    }
    const near = stripe.filter(
      (f) => Math.max(f[0] as number, f[3] as number, f[6] as number) > striped.length - 0.3,
    );
    expect(near.length).toBeGreaterThan(0);
    for (const f of near)
      for (const z of [f[2], f[5], f[8]] as number[]) expect(z).toBeLessThan(1.1);
    const base = stripe.filter(
      (f) => Math.max(f[0] as number, f[3] as number, f[6] as number) < 0.5,
    );
    for (const f of base)
      for (const z of [f[2], f[5], f[8]] as number[]) expect(z).toBeGreaterThan(1.5);
  });

  it("pulls the nose tip back from the car end by the measured tip gap and keeps the skirt line along the car", () => {
    const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
    const model = catalog.vehicles.find((v) => v.model_id === "db-407");
    const car = model?.car_types.find((c) => c.car_type === "end");
    if (!model || !car?.front) throw new Error("db-407 end car missing");
    const spec = resolveCar(model, car);
    const layout = bodyLayout(spec, LODS[0] as (typeof LODS)[number]);
    expect(layout.frontEnd).toBeCloseTo(spec.length / 2 - (car.front.tip_gap_m ?? 0), 9);
    expect(lowBottomOf(spec)).toBe(car.body_bottom_m);
    expect(layout.zones).toHaveLength(1);
    const body = buildBody(spec, LODS[0] as (typeof LODS)[number]);
    let tip = -Infinity;
    for (let i = 0; i < body.positions.length; i += 3)
      tip = Math.max(tip, body.positions[i] as number);
    expect(Math.abs(tip - layout.frontEnd)).toBeLessThan(0.025);
  });
});

/** Palette u of the highest face over the middle half of the car. */
function topSlotOf(body: MeshBuilder, length: number): number {
  const p = body.positions;
  let top = -Infinity;
  let topSlot = -1;
  for (let t = 0; t < p.length / 9; t++) {
    const x = ((p[t * 9] as number) + (p[t * 9 + 3] as number)) / 2;
    if (Math.abs(x) > length / 4) continue;
    const z = ((p[t * 9 + 2] as number) + (p[t * 9 + 5] as number) + (p[t * 9 + 8] as number)) / 3;
    if (z > top + 1e-9) {
      top = z;
      topSlot = body.uvs[t * 6] as number;
    }
  }
  return topSlot;
}

describe("roof band", () => {
  it("is the top of every car at every level of detail, so the colour mode reads from above", () => {
    const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
    const mode = slotU("mode");
    const cars = catalog.vehicles.flatMap((model) =>
      model.car_types.map((car) => ({
        id: `${model.model_id} ${car.car_type}`,
        spec: resolveCar(model, car),
      })),
    );
    for (const { id, spec } of cars) {
      for (const lod of LODS) {
        const body = buildBody(spec, lod);
        if (spec.pantographs.length === 0 && lod.level === 2)
          expect(topSlotOf(body, spec.length), id).toBeCloseTo(mode, 9);
        expect(body.uvs.some((u, i) => i % 2 === 0 && Math.abs(u - mode) < 1e-9)).toBe(true);
      }
    }
  });
});

describe("car ends at a joint", () => {
  const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
  const carOf = (modelId: string, carType: string) => {
    const model = catalog.vehicles.find((m) => m.model_id === modelId);
    const car = model?.car_types.find((c) => c.car_type === carType);
    if (!model || !car) throw new Error(`${modelId} ${carType} missing`);
    return resolveCar(model, car);
  };
  const LOD0 = LODS[0] as (typeof LODS)[number];
  const endWallSlots = (mesh: MeshBuilder, x: number) => {
    const slots = new Set<number>();
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      const xs = [0, 1, 2].map((v) => mesh.positions[t * 9 + v * 3] as number);
      if (xs.every((value) => Math.abs(value - x) < 1e-4)) slots.add(mesh.uvs[t * 6] as number);
    }
    return slots;
  };

  it("paints the end wall dark like the bellows wherever another car is coupled", () => {
    for (const [modelId, carType] of [
      ["flirt-3-xl", "middle"],
      ["db-481", "car-b"],
      ["sncf-tgv-duplex", "middle"],
      ["db-463-3", "middle"],
    ] as const) {
      const spec = carOf(modelId, carType);
      const layout = bodyLayout(spec, LOD0);
      const plainEnds = [
        ...(spec.front ? [] : [layout.frontEnd]),
        ...(spec.front && spec.noseAtRear ? [] : [layout.rearEnd]),
      ];
      expect(plainEnds.length, `${modelId} ${carType}`).toBeGreaterThan(0);
      for (const x of plainEnds)
        expect([...endWallSlots(buildBody(spec, LOD0), x)], `${modelId} ${carType} ${x}`).toEqual([
          slotU("gangway"),
        ]);
    }
  });

  it("keeps the body colour on a plain end wall that ends the formation", () => {
    const tail = catalog.vehicles
      .flatMap((model) => model.car_types.map((car) => resolveCar(model, car)))
      .find((spec) => spec.tailLamps === "rear" && !spec.front);
    if (!tail) throw new Error("no plain trailing end in the catalogue");
    const layout = bodyLayout(tail, LOD0);
    expect(endWallSlots(buildBody(tail, LOD0), layout.rearEnd).has(slotU("body"))).toBe(true);
  });
});

describe("the LINT 41 head built from 2011", () => {
  const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
  const LOD0 = LODS[0] as (typeof LODS)[number];
  const endOf = (modelId: string) => {
    const model = catalog.vehicles.find((m) => m.model_id === modelId);
    const car = model?.car_types.find((c) => c.car_type === "end");
    if (!model || !car) throw new Error(`${modelId} end missing`);
    return resolveCar(model, car);
  };
  const lowerFrontWidth = (spec: CarSpec) => {
    const body = buildBody(spec, LOD0);
    const tip = Math.max(...body.positions.filter((_, i) => i % 3 === 0));
    let half = 0;
    for (let i = 0; i < body.positions.length; i += 3) {
      const [x, y, z] = body.positions.slice(i, i + 3) as [number, number, number];
      if (x > tip - 0.25 && z > 0.6 && z < 1.0) half = Math.max(half, Math.abs(y));
    }
    return half / (spec.width / 2);
  };

  it("is 0.18 m longer per end than the 648 head, so the unit is 42.17 m", () => {
    const lint = (id: string) => catalog.vehicles.find((m) => m.model_id === id);
    for (const id of ["db-1648", "coradia-lint-41"]) {
      expect(endOf(id).length - endOf("db-648").length, id).toBeCloseTo(0.18, 6);
      expect(2 * endOf(id).length, id).toBeCloseTo(lint(id)?.unit_length_m ?? 0, 6);
    }
  });

  it("keeps the lower front near the full width down to the coupler, where the 648 head narrows", () => {
    expect(lowerFrontWidth(endOf("db-1648"))).toBeGreaterThan(0.9);
    expect(lowerFrontWidth(endOf("db-648"))).toBeLessThan(0.8);
  });

  it("is the head of the LINT 54 and LINT 81 end cars, all built after 2011 (622, 620)", () => {
    for (const id of ["db-622", "db-620"]) {
      expect(lowerFrontWidth(endOf(id)), id).toBeGreaterThan(0.84);
      expect(endOf(id).front?.length, id).toBeCloseTo(endOf("db-1648").front?.length ?? 0, 6);
    }
  });

  it("keeps the LINT 54 lamps where the 622 508 photo has them, inboard of the old head's", () => {
    const lamps = (endOf("db-622").front?.decals ?? []).filter(
      (d) => d.slot === "light" && d.bottom < 2,
    );
    const centres = lamps.map((d) => (d.inner + d.outer) / 2).sort();
    expect(centres[0]).toBeCloseTo(0.42, 2);
    expect(centres[1]).toBeCloseTo(0.58, 2);
  });
});

describe("the Desiro Classic coupler cover (642)", () => {
  const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
  const LOD0 = LODS[0] as (typeof LODS)[number];
  const endOf = (modelId: string) => {
    const model = catalog.vehicles.find((m) => m.model_id === modelId);
    const car = model?.car_types.find((c) => c.car_type === "end");
    if (!model || !car) throw new Error(`${modelId} end missing`);
    return resolveCar(model, car);
  };
  const lowerFrontTriangles = (spec: CarSpec, slot: Slot) => {
    const body = buildBody(spec, LOD0);
    const tip = Math.max(...body.positions.filter((_, i) => i % 3 === 0));
    const u = slotU(slot);
    let count = 0;
    for (let t = 0; t < body.positions.length / 9; t++) {
      const x = body.positions[t * 9] as number;
      const z = body.positions[t * 9 + 2] as number;
      const inSlot = Math.abs((body.uvs[t * 6] as number) - u) < 1e-9;
      if (inSlot && x > tip - 0.3 && z > 0.5 && z < 1.25) count++;
    }
    return count;
  };

  it("hangs the red cover bag of the Schöna and Bad Schandau photos over the coupler", () => {
    for (const id of ["db-642", "desiro-classic"]) {
      const spec = endOf(id);
      const decals = spec.front?.decals ?? [];
      const coupler = decals.findIndex((d) => d.slot === "equipment" && d.outer < 0.2);
      const bag = decals.findIndex((d) => d.slot === "lower_body");
      expect(coupler, id).toBeGreaterThanOrEqual(0);
      expect(bag, id).toBeGreaterThan(coupler);
      const { bottom, top, outer } = decals[bag] ?? { bottom: 0, top: 0, outer: 0 };
      expect([bottom, top, outer], id).toEqual([0.53, 1.22, 0.55]);
      expect(lowerFrontTriangles(spec, "lower_body"), id).toBeGreaterThan(0);
    }
  });
});

describe("the Traxx P160 AC front of the 146.2, scaled by its UIC buffers", () => {
  const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
  const model = catalog.vehicles.find((m) => m.model_id === "doppelstockwagen-re");
  const car = model?.car_types.find((c) => c.car_type === "locomotive");
  if (!model || !car) throw new Error("doppelstockwagen-re locomotive missing");
  const spec = resolveCar(model, car);
  const metresOff = (fraction: number) => (fraction * spec.width) / 2;

  it("stands 3.85 m high with the windscreen of the 146 273 photo under its roof", () => {
    expect(spec.height).toBeCloseTo(3.85, 6);
    expect(spec.front?.screenBottom).toBeCloseTo(2.67, 6);
    expect(spec.front?.screenTop).toBeCloseTo(3.45, 6);
  });

  it("puts the lamp pairs 0.57 m to 0.98 m off the centre line", () => {
    const lamps = (spec.front?.decals ?? []).filter((d) => d.slot === "light" && d.bottom < 2);
    expect(lamps).toHaveLength(1);
    const [lamp] = lamps;
    expect(metresOff(lamp?.inner ?? 0)).toBeCloseTo(0.57, 1);
    expect(metresOff(lamp?.outer ?? 0)).toBeCloseTo(0.97, 1);
  });
});

describe("the ICE T cab side glazing", () => {
  const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
  const LOD0 = LODS[0] as (typeof LODS)[number];
  const glazingBelowTheScreen = (spec: CarSpec) => {
    const body = buildBody(spec, LOD0);
    const tip = Math.max(...body.positions.filter((_, i) => i % 3 === 0));
    const u = slotU("window");
    const setbacks: number[] = [];
    for (let t = 0; t < body.positions.length / 9; t++) {
      if (Math.abs((body.uvs[t * 6] as number) - u) > 1e-9) continue;
      for (let v = 0; v < 3; v++) {
        const x = body.positions[t * 9 + v * 3] as number;
        const z = body.positions[t * 9 + v * 3 + 2] as number;
        if (z > 1.85 && z < 2.0) setbacks.push(tip - x);
      }
    }
    return Math.min(...setbacks);
  };

  it("runs forward into the nose under the windscreen, to 0.75 m behind the tip as on the side photo", () => {
    for (const id of ["db-411", "db-415"]) {
      const model = catalog.vehicles.find((m) => m.model_id === id);
      const car = model?.car_types.find((c) => c.car_type === "end");
      if (!model || !car) throw new Error(`${id} end missing`);
      expect(glazingBelowTheScreen(resolveCar(model, car)), id).toBeLessThan(0.85);
    }
  });
});

describe("the ICE 3 windscreen outline (403, 406)", () => {
  const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
  const LOD0 = LODS[0] as (typeof LODS)[number];
  const glassFan = (spec: CarSpec) => {
    const body = buildBody(spec, LOD0);
    const glazing = (["window", "glass", "sheen"] as const).map((slot) => slotU(slot));
    const tip = Math.max(...body.positions.filter((_, i) => i % 3 === 0));
    const uses = new Map<string, number>();
    for (let t = 0; t < body.positions.length / 9; t++) {
      const u = body.uvs[t * 6] as number;
      if (!glazing.some((g) => Math.abs(g - u) < 1e-9)) continue;
      for (let v = 0; v < 3; v++) {
        const p = body.positions.slice(t * 9 + v * 3, t * 9 + v * 3 + 3) as number[];
        if (Math.abs(p[1] as number) > 0.3 || (p[0] as number) < tip - 5) continue;
        const key = p.map((c) => c.toFixed(4)).join();
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    }
    return Math.max(...uses.values());
  };

  it("is laid out in columns along its outline, not in rows fanning to a faceted octagon", () => {
    for (const id of ["db-403", "db-406"]) {
      const model = catalog.vehicles.find((m) => m.model_id === id);
      const car = model?.car_types.find((c) => c.car_type === "end");
      if (!model || !car) throw new Error(`${id} end missing`);
      expect(glassFan(resolveCar(model, car)), id).toBeLessThanOrEqual(6);
    }
  });
});

describe("the Twindexx Vario cab end (445)", () => {
  const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
  const LOD0 = LODS[0] as (typeof LODS)[number];
  const model = catalog.vehicles.find((m) => m.model_id === "db-445");
  const car = model?.car_types.find((c) => c.car_type === "end");
  if (!model || !car) throw new Error("db-445 end missing");
  const spec = resolveCar(model, car);
  const layout = bodyLayout(spec, LOD0);

  it("keeps the machine room behind the cab free of passenger windows on both decks", () => {
    const windows = layout.openings.filter((o) => o.kind === "window");
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) expect(w.x1, `window ${w.x0} to ${w.x1}`).toBeLessThanOrEqual(5.82);
  });

  it("draws the machine room's lower grille and upper louvre from the drawing", () => {
    const panels = layout.openings.filter((o) => o.kind === "panel");
    expect(panels.map((p) => [p.x0, p.x1, p.z0, p.z1])).toEqual([
      [7.14, 9.08, 1.53, 2.97],
      [7.86, 9.49, 3.48, 4.1],
    ]);
  });
});

describe("roof equipment and pantographs", () => {
  const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
  const carOf = (modelId: string, carType: string) => {
    const model = catalog.vehicles.find((m) => m.model_id === modelId);
    const car = model?.car_types.find((c) => c.car_type === carType);
    if (!model || !car) throw new Error(`${modelId} ${carType} missing`);
    return resolveCar(model, car);
  };
  const pointsOf = (mesh: MeshBuilder, slot: Slot) => {
    const u = slotU(slot);
    const out: number[][] = [];
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      if (Math.abs((mesh.uvs[t * 6] as number) - u) > 1e-9) continue;
      for (let v = 0; v < 3; v++) out.push(mesh.positions.slice(t * 9 + v * 3, t * 9 + v * 3 + 3));
    }
    return out;
  };

  const glazedInNose = (body: MeshBuilder, nose: number) => {
    const glazing = (["window", "glass", "sheen"] as const).map((slot) => slotU(slot));
    let glazed = 0;
    for (let t = 0; t < body.positions.length / 9; t++) {
      if (!glazing.some((u) => Math.abs((body.uvs[t * 6] as number) - u) < 1e-9)) continue;
      const x = body.positions[t * 9] as number;
      if (x > nose && Math.abs(body.positions[t * 9 + 1] as number) < 0.5) glazed++;
    }
    return glazed;
  };
  const coarser = LODS.flatMap((lod) =>
    (lod.level === 0 ? (["full"] as const) : (["band", "none"] as const)).map((noseLevels) => ({
      ...lod,
      noseLevels,
    })),
  );

  it("keeps a windscreen on every catalogue front at every level of detail and coarser front", () => {
    const fronts = catalog.vehicles.flatMap((model) =>
      model.car_types.map((car) => ({
        id: `${model.model_id} ${car.car_type}`,
        spec: resolveCar(model, car),
      })),
    );
    for (const { id, spec } of fronts) {
      if (!spec.front) continue;
      const nose = spec.length / 2 - spec.front.length;
      for (const lod of coarser)
        expect(
          glazedInNose(buildBody(spec, lod), nose),
          `${id} LOD${lod.level} ${lod.noseLevels}`,
        ).toBeGreaterThan(0);
    }
  });

  it("draws a measured cab glass over the front of the cab band on both sides and nowhere else", () => {
    const spec = carOf("db-407", "end");
    const glassCurve = spec.front?.cabGlassCurve ?? [];
    expect(glassCurve.length).toBeGreaterThan(1);
    const end = spec.length / 2 - (spec.front?.tipGap ?? 0);
    const side = pointsOf(buildBody(spec, LODS[0] as (typeof LODS)[number]), "glass").filter(
      (p) => Math.abs(p[1] as number) > 1.2,
    );
    expect(side.some((p) => (p[1] as number) > 0)).toBe(true);
    expect(side.some((p) => (p[1] as number) < 0)).toBe(true);
    for (const p of side) {
      const setback = end - (p[0] as number);
      expect(setback).toBeGreaterThan(3.4 - 0.05);
      expect(setback).toBeLessThan(4.25 + 0.05);
      expect(p[2] as number).toBeGreaterThan(1.8);
      expect(p[2] as number).toBeLessThan(2.56);
    }
    const plain = carOf("db-403", "end");
    expect(plain.front?.cabGlassCurve).toBeUndefined();
  });

  it("paints a light windscreen grey-blue without the near black window tone", () => {
    const lod = LODS[0] as (typeof LODS)[number];
    const spec = carOf("db-1440-4", "end");
    const front = spec.front as NonNullable<typeof spec.front>;
    const dark = { ...spec, front: { ...front, lightGlass: false } };
    const light = { ...spec, front: { ...front, lightGlass: true } };
    const count = (car: typeof spec, slot: "window" | "glass") =>
      pointsOf(buildBody(car, lod), slot).length;
    expect(count(light, "window")).toBeLessThan(count(dark, "window"));
    expect(count(light, "glass")).toBeGreaterThan(count(dark, "glass"));
  });

  it("puts measured roof equipment boxes on the roof over their spans and nowhere else", () => {
    const spec = carOf("db-442-4", "end");
    expect(spec.roofEquipment).not.toBeNull();
    const points = pointsOf(buildBody(spec, LODS[0] as (typeof LODS)[number]), "equipment").filter(
      (p) => (p[2] as number) > spec.height - 0.1 && (p[0] as number) < spec.length / 2 - 3,
    );
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      expect(p[0] as number).toBeGreaterThanOrEqual(-2.675 - 1e-6);
      expect(p[0] as number).toBeLessThanOrEqual(3.525 + 1e-6);
    }
  });

  it("paints measured side panels (grilles) on both side walls over their spans and heights only", () => {
    const plain = carOf("db-401", "power-head");
    const panel = [4.05, 6.12, 2.62, 3.2] as const;
    const spec: CarSpec = { ...plain, sidePanels: [panel] };
    const masked = (s: CarSpec) =>
      pointsOf(buildBody(s, LODS[0] as (typeof LODS)[number]), "mask").filter(
        (p) => Math.abs(Math.abs(p[1] as number) - s.width / 2) < 0.1 && (p[0] as number) < 8,
      );
    expect(masked({ ...plain, sidePanels: null })).toHaveLength(0);
    const points = masked(spec);
    expect(points.some((p) => (p[1] as number) > 0)).toBe(true);
    expect(points.some((p) => (p[1] as number) < 0)).toBe(true);
    for (const p of points) {
      expect(p[0] as number).toBeGreaterThanOrEqual(panel[0] - 1e-6);
      expect(p[0] as number).toBeLessThanOrEqual(panel[1] + 1e-6);
      expect(p[2] as number).toBeGreaterThanOrEqual(panel[2] - 1e-6);
      expect(p[2] as number).toBeLessThanOrEqual(panel[3] + 1e-6);
    }
  });

  it("draws a folded single-arm pantograph at full detail: arms rising to a knee behind the base", () => {
    const spec = carOf("db-403", "transformer");
    const x = spec.pantographs[0] as number;
    const full = pointsOf(buildBody(spec, LODS[0] as (typeof LODS)[number]), "bogie").filter(
      (p) => (p[2] as number) > spec.height + 0.11 && Math.abs((p[0] as number) - x) < 1.2,
    );
    expect(full.length).toBeGreaterThan(0);
    const knee = Math.min(...full.map((p) => p[0] as number));
    expect(knee).toBeLessThan(x - 0.8);
    for (const p of full) expect(p[2] as number).toBeLessThanOrEqual(spec.height + 0.35);
  });
});

const SAMPLE_FRONT: FrontSpec = {
  length: 6.2,
  tipZ: 1.0,
  faceTop: 1.55,
  bottom: 0.32,
  bottomSetback: 0.6,
  screenBottom: 2.3,
  screenTop: 3.3,
  screenBottomSetback: 2.1,
  screenTopSetback: 4.2,
  screenWidth: 0.9,
  plan: PLAN_EXPONENTS.round,
  straight: 0.8,
  mask: null,
  lamps: null,
  skirtTop: null,
  stripe: "sides",
  frontStripe: null,
  cabWindow: true,
  sideWindow: null,
  cabLength: 8.4,
};

describe("lofted nose", () => {
  const loft: NoseLoft = { waist: 1.3, top: 3.9, bottom: 0.3, exponent: 2.4, taper: 1.5 };

  it("keeps the body section at the start of the rounding and narrows monotonically to the tip", () => {
    for (const z of [0.4, 1.0, 1.3, 2.3, 3.3, 3.8]) {
      expect(loftScale(loft, 0, z)).toBe(1);
      let last = 1;
      for (let p = 0.05; p <= 1.0001; p += 0.05) {
        const s = loftScale(loft, p, z);
        expect(s).toBeLessThanOrEqual(last + 1e-12);
        expect(s).toBeGreaterThan(0);
        last = s;
      }
    }
    expect(loftScale(null, 1, 2)).toBe(1);
  });

  it("draws a rounded windscreen from its widths per height", () => {
    const oval = {
      ...SAMPLE_FRONT,
      screenWidths: [
        [2.3, 0.5],
        [2.8, 0.8],
        [3.3, 0.4],
      ] as const,
    };
    expect(screenWidthAt(oval, 2.3)).toBeCloseTo(0.5, 9);
    expect(screenWidthAt(oval, 2.55)).toBeCloseTo(0.65, 9);
    expect(screenWidthAt(SAMPLE_FRONT, 2.8)).toBe(0.9);
    expect(frontLevels(oval, "full")).toContain(2.8);
    expect(frontLevels(oval, "screen")).not.toContain(2.8);
  });

  it("paints the dark chin under the face in the mask colour and puts its edges on rows", () => {
    const chinned = { ...SAMPLE_FRONT, chin: { bottom: 0.4, top: 0.9, width: 0.5 } };
    expect(frontLevels(chinned, "full")).toEqual(expect.arrayContaining([0.4, 0.9]));
  });

  it("bulges the face ahead of the tip between tip and face top", () => {
    const base = { ...SAMPLE_FRONT, faceBulge: 0.12 };
    const setback = setbackProfile(base, 0.3, 3.87);
    expect(setback((base.tipZ + base.faceTop) / 2)).toBeCloseTo(-0.12, 6);
    expect(setback(base.tipZ)).toBeCloseTo(0, 6);
  });

  it("follows measured tip-section widths between their heights without overshoot", () => {
    const measured: NoseLoft = {
      ...loft,
      widths: [
        [0.4, 0.5],
        [1.2, 1.0],
        [2.3, 0.6],
        [3.3, 0.4],
      ],
    };
    expect(sectionWidth(measured, 1.2)).toBeCloseTo(1, 9);
    expect(sectionWidth(measured, 2.3)).toBeCloseTo(0.6, 9);
    expect(sectionWidth(measured, 0.1)).toBeCloseTo(0.5, 9);
    for (let z = 1.2; z <= 3.3; z += 0.1) {
      expect(sectionWidth(measured, z)).toBeLessThanOrEqual(1);
      expect(sectionWidth(measured, z + 0.1)).toBeLessThanOrEqual(
        sectionWidth(measured, z) + 1e-12,
      );
    }
  });

  it("rounds the tip section: widest at the waist, narrowing above and below", () => {
    expect(sectionWidth(loft, loft.waist)).toBe(1);
    expect(sectionWidth(loft, 2.3)).toBeLessThan(1);
    expect(sectionWidth(loft, 3.3)).toBeLessThan(sectionWidth(loft, 2.3));
    expect(sectionWidth(loft, 0.5)).toBeLessThan(sectionWidth(loft, 1.0));
  });

  it("builds a lofted front whose faces point outwards and whose tip is narrower than its base", () => {
    const front: FrontSpec = {
      length: 6.2,
      tipZ: 1.0,
      faceTop: 1.55,
      bottom: null,
      bottomSetback: 0.3,
      screenBottom: 2.3,
      screenTop: 3.3,
      screenBottomSetback: 2.1,
      screenTopSetback: 4.2,
      screenWidth: 0.9,
      plan: PLAN_EXPONENTS.round,
      straight: 0.6,
      mask: null,
      lamps: null,
      skirtTop: null,
      stripe: "sides",
      frontStripe: null,
      cabWindow: false,
      sideWindow: null,
      cabLength: 8.4,
      loft,
    };
    const bands: FrontBands = {
      bottom: 0.55,
      height: 3.87,
      sill: 2.25,
      top: 2.95,
      stripeBottom: 1.72,
      stripeTop: 1.95,
      eave: 3.25,
      bandZ: 3.6,
      windowBand: true,
    };
    const ring = fullRing({ ...SECTION, height: 3.87, eave: 3.25, bottom: 0.55, sideBottom: 0.8 }, [
      ...frontLevels(front, "full"),
      1.72,
      1.95,
      2.25,
      2.95,
      3.6,
    ]);
    const lofted = buildFront(front, bands, ring, "full");
    const plain = buildFront({ ...front, loft: null }, bands, ring, "full");
    const widthAt = (m: MeshBuilder, x0: number, z0: number) => {
      let w = 0;
      for (let i = 0; i < m.positions.length; i += 3) {
        const [px, py, pz] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]] as number[];
        if ((px as number) >= x0 && Math.abs((pz as number) - z0) < 1e-6)
          w = Math.max(w, Math.abs(py as number));
      }
      return w;
    };
    expect(frontLevels(front, "full").length).toBeGreaterThan(
      frontLevels({ ...front, loft: null }, "full").length + 5,
    );
    expect(widthAt(lofted, 3.0, 2.3)).toBeLessThan(widthAt(plain, 3.0, 2.3) - 0.01);
    expect(widthAt(lofted, 0, 2.3)).toBeCloseTo(widthAt(plain, 0, 2.3), 6);
    expect(outwardShare(lofted)).toBeGreaterThan(0.99);
    expect(outwardShare(plain)).toBeGreaterThan(0.99);
  });
});

describe("nose cheeks", () => {
  const cheeks = { bottom: 0.3, top: 1.6, inner: 0.4, outer: 1.0, reach: 0.3, recess: 0.45 };

  it("reach ahead between inner and outer, draw the middle back, and vanish at their edges", () => {
    const mid = (cheeks.bottom + cheeks.top) / 2;
    expect(cheekOffset(cheeks, 0.7, mid)).toBeCloseTo(cheeks.reach, 6);
    expect(cheekOffset(cheeks, -0.7, mid)).toBeCloseTo(cheeks.reach, 6);
    expect(cheekOffset(cheeks, 0, mid)).toBeCloseTo(-cheeks.recess, 6);
    for (const u of [0, 0.2, 0.4, 0.7, 1])
      for (const z of [0, cheeks.bottom, cheeks.top, 2.5])
        expect(Math.abs(cheekOffset(cheeks, u, z))).toBeLessThan(1e-9);
    expect(Math.abs(cheekOffset(cheeks, 1, mid))).toBeLessThan(1e-9);
  });

  it("stay continuous across the edge of the opening", () => {
    for (const z of [0.5, 0.95, 1.4]) {
      const a = cheekOffset(cheeks, cheeks.inner - 1e-6, z);
      const b = cheekOffset(cheeks, cheeks.inner + 1e-6, z);
      expect(Math.abs(a - b)).toBeLessThan(1e-4);
    }
  });
});

describe("panes on the front", () => {
  const front: FrontSpec = {
    ...SAMPLE_FRONT,
    length: 6.0,
    tipZ: 0.8,
    faceTop: 0.8,
    screenBottom: 1.9,
    screenTop: 3.2,
    screenBottomSetback: 1.4,
    screenTopSetback: 4.0,
    screenWidth: 0.7,
    plan: PLAN_EXPONENTS.round,
    straight: 0.5,
    mask: null,
    lamps: null,
    stripe: "sides",
    frontStripe: null,
    cabWindow: true,
    sideWindow: { from: 3.6, to: 5.8 },
    cabLength: 6.5,
    screenRound: 4,
    screenWidths: [
      [1.9, 0.8],
      [2.5, 0.88],
      [3.2, 0.66],
    ],
    decals: [
      { slot: "light", bottom: 1.0, top: 1.25, inner: 0.45, outer: 0.62, round: 4, slant: 0.05 },
      { slot: "stripe", bottom: 1.3, top: 1.44, inner: 0, outer: 0.1, round: 10, slant: 0 },
    ],
    sideWindowBand: { bottom: 2.0, top: 3.1 },
    sideWindowRound: 0.35,
  };
  const bands: FrontBands = {
    bottom: 0.55,
    height: 3.89,
    sill: 2.03,
    top: 2.82,
    stripeBottom: 1.66,
    stripeTop: 1.83,
    eave: 3.3,
    bandZ: 3.65,
    windowBand: false,
  };
  const ring = fullRing({ ...SECTION, height: 3.89, eave: 3.3, bottom: 0.55, sideBottom: 0.8 }, [
    ...frontLevels(front, "full"),
    1.66,
    1.83,
    2.03,
    2.82,
    3.65,
  ]);
  const triangles = (m: MeshBuilder, slot: Slot) => {
    const u = slotU(slot);
    const out: Vec3[][] = [];
    for (let t = 0; t < m.positions.length / 9; t++) {
      if (Math.abs((m.uvs[t * 6] as number) - u) > 1e-9) continue;
      out.push(
        [0, 3, 6].map((i) => m.positions.slice(t * 9 + i, t * 9 + i + 3) as unknown as Vec3),
      );
    }
    return out;
  };

  it("rounds the pane windscreen to a point at its bottom and top and keeps its widths between", () => {
    expect(screenPaneWidth(front, 1.9)).toBeCloseTo(0, 3);
    expect(screenPaneWidth(front, 3.2)).toBeCloseTo(0, 3);
    expect(screenPaneWidth(front, 2.55)).toBeGreaterThan(0.85);
    expect(screenPaneWidth(front, 2.55)).toBeLessThanOrEqual(0.88 + 1e-9);
    expect(screenPaneWidth({ ...front, screenRound: null }, 2.55)).toBe(0);
  });

  it("lays a wrapped windscreen out in columns so that its glass does not fan to a point at its top and bottom", () => {
    const glass = (m: MeshBuilder) => [
      ...triangles(m, "window"),
      ...triangles(m, "glass"),
      ...triangles(m, "sheen"),
    ];
    const fan = (m: MeshBuilder) => {
      const uses = new Map<string, number>();
      for (const f of glass(m))
        for (const p of f) {
          if (Math.abs(p[1]) > 0.3) continue;
          const key = p.map((c) => c.toFixed(5)).join();
          uses.set(key, (uses.get(key) ?? 0) + 1);
        }
      return Math.max(...uses.values());
    };
    const longest = (m: MeshBuilder) =>
      Math.max(
        ...glass(m).flatMap((f) =>
          f.map((p, i) => {
            const [x, y, z] = sub(p, f[(i + 1) % 3] as Vec3);
            return Math.hypot(x, y, z);
          }),
        ),
      );
    const rows = buildFront(front, bands, ring, "full");
    const columns = buildFront({ ...front, screenColumns: true }, bands, ring, "full");
    expect(fan(rows)).toBeGreaterThan(12);
    expect(fan(columns)).toBeLessThanOrEqual(6);
    expect(longest(columns)).toBeLessThan(0.7 * longest(rows));
    const reach = (m: MeshBuilder) => {
      const ys = glass(m).flatMap((f) => f.map((p) => Math.abs(p[1])));
      const zs = glass(m).flatMap((f) => f.map((p) => p[2]));
      return [Math.max(...ys), Math.min(...zs), Math.max(...zs)];
    };
    const [yr, z0r, z1r] = reach(rows);
    const [yc, z0c, z1c] = reach(columns);
    expect(yc).toBeCloseTo(yr as number, 1);
    expect(z0c).toBeCloseTo(z0r as number, 1);
    expect(z1c).toBeCloseTo(z1r as number, 1);
  });

  it("puts two side buffers and a coupler ahead of the beam when the front carries buffers", () => {
    const ahead = (m: MeshBuilder) =>
      Math.max(...triangles(m, "underframe").flatMap((f) => f.map((p) => p[0])));
    const plain = buildFront(front, bands, ring, "full");
    const buffered = buildFront({ ...front, buffers: true }, bands, ring, "full");
    expect(ahead(buffered)).toBeGreaterThan(ahead(plain) + 0.2);
    const heads = triangles(buffered, "underframe").filter((f) =>
      f.every((p) => Math.abs(Math.abs(p[1]) - 0.875) < 0.23 && Math.abs(p[2] - 1.06) < 0.23),
    );
    expect(heads.length).toBeGreaterThan(20);
  });

  it("fills a lamp housing with round lenses side by side, or one strip in a slim housing", () => {
    const flat: Facets = (u, z) => ({ point: [0, u * 1.4, z], normal: [1, 0, 0] });
    const pod = { slot: "light", bottom: 1.0, top: 1.2, round: 4, slant: 0 } as const;
    const wide = lampLenses({ ...pod, inner: 0.5, outer: 0.75 }, flat);
    expect(wide).toHaveLength(2);
    for (const lens of wide) {
      expect(lens.inner).toBeGreaterThanOrEqual(0.5);
      expect(lens.outer).toBeLessThanOrEqual(0.75);
      expect(lens.bottom).toBeGreaterThan(1.0);
      expect(lens.top).toBeLessThan(1.2);
    }
    expect(lampLenses({ ...pod, inner: 0.5, outer: 0.62 }, flat)).toHaveLength(1);
    const strip = lampLenses({ ...pod, top: 1.1, inner: 0.4, outer: 0.8 }, flat);
    expect(strip).toHaveLength(1);
    expect((strip[0]?.outer ?? 0) - (strip[0]?.inner ?? 0)).toBeGreaterThan(0.3);
    expect(isLamp({ ...pod, inner: 0, outer: 0.11, round: 10 })).toBe(false);
  });

  it("gives a lone lamp a red tail lens on its outer side and keeps a second lamp white", () => {
    const flat: Facets = (u, z) => ({ point: [0, u * 1.4, z], normal: [1, 0, 0] });
    const pod = { slot: "light", bottom: 1.0, top: 1.2, round: 4, slant: 0 } as const;
    const single = lampLenses({ ...pod, inner: 0.5, outer: 0.62 }, flat, { share: 0.4 });
    expect(single.map((l) => l.slot)).toEqual(["light", "tail"]);
    expect(single[1]?.inner ?? 0).toBeGreaterThan(single[0]?.outer ?? 1);
    const pair = lampLenses({ ...pod, inner: 0.5, outer: 0.75 }, flat, { share: 0.5 });
    expect(pair.map((l) => l.slot)).toEqual(["light", "tail"]);
    const inner = lampLenses({ ...pod, inner: 0.5, outer: 0.75 }, flat, {
      share: 0.5,
      inner: true,
    });
    expect(inner.map((l) => l.slot)).toEqual(["tail", "light"]);
    expect(lampLenses({ ...pod, inner: 0.5, outer: 0.62 }, flat, { share: 1 })[0]?.slot).toBe(
      "tail",
    );
    expect(lampLenses({ ...pod, inner: 0.5, outer: 0.62 }, flat).map((l) => l.slot)).toEqual([
      "light",
    ]);
  });

  it("stacks a small white lens over a larger red one when the tail sits below", () => {
    const flat: Facets = (u, z) => ({ point: [0, u * 1.4, z], normal: [1, 0, 0] });
    const pod = { slot: "light", bottom: 1.0, top: 1.5, round: 3.5, slant: 0 } as const;
    const lenses = lampLenses({ ...pod, inner: 0.44, outer: 0.7 }, flat, {
      share: 0.5,
      below: true,
    });
    expect(lenses.map((l) => l.slot)).toEqual(["light", "tail"]);
    const [white, red] = lenses as [FrontDecal, FrontDecal];
    expect(white.bottom).toBeGreaterThan(red.top - 1e-9);
    expect(white.inner).toBeCloseTo(red.inner, 9);
    for (const lens of lenses) {
      expect(lens.bottom).toBeGreaterThan(1.0);
      expect(lens.top).toBeLessThan(1.5);
      expect(lens.inner).toBeGreaterThanOrEqual(0.44);
      expect(lens.outer).toBeLessThanOrEqual(0.7);
    }
  });

  it("builds the DB logo as a plate, a red field, the letters D and B and their counters", () => {
    const flat: Facets = (u, z) => ({ point: [0, u * 1.4, z], normal: [1, 0, 0] });
    const plate: FrontDecal = {
      slot: "doors",
      bottom: 1.5,
      top: 1.8,
      inner: 0,
      outer: 0.15,
      round: 6,
      slant: 0,
      logo: true,
    };
    const parts = logoParts(plate, flat);
    expect(parts.map((p) => p.slot)).toEqual([
      "logo_ink",
      "logo",
      "logo_ink",
      "logo",
      "logo_ink",
      "logo",
      "logo",
    ]);
    const [outer, field, ...glyphs] = parts as FrontDecal[];
    expect((field?.outer ?? 1) < (outer?.outer ?? 0)).toBe(true);
    expect((field?.top ?? 0) < (outer?.top ?? 0)).toBe(true);
    const lateral = glyphs.flatMap((g) => g.span ?? []);
    expect(Math.max(...lateral)).toBeLessThan(plate.outer);
    expect(Math.min(...lateral)).toBeGreaterThan(-plate.outer);
    const [d, , b] = glyphs as FrontDecal[];
    expect((d?.span?.[1] ?? 1) <= (b?.span?.[0] ?? 0)).toBe(true);
    for (const g of glyphs) {
      expect(g.bottom).toBeGreaterThanOrEqual(field?.bottom ?? 0);
      expect(g.top).toBeLessThanOrEqual(field?.top ?? 0);
    }
    const red = logoParts({ ...plate, slot: "lower_body", redLetters: true }, flat);
    expect(red.map((p) => p.slot)).toEqual([
      "logo",
      "lower_body",
      "logo",
      "lower_body",
      "logo",
      "lower_body",
      "lower_body",
    ]);
    expect(red.map((p) => [p.bottom, p.top, p.outer, p.span])).toEqual(
      parts.map((p) => [p.bottom, p.top, p.outer, p.span]),
    );
  });

  it("fills a cluster lamp with a white and a red lens across the whole housing", () => {
    const flat: Facets = (u, z) => ({ point: [0, u * 1.4, z], normal: [1, 0, 0] });
    const pod = { slot: "light", bottom: 1.0, top: 1.22, round: 4, slant: 0, fill: true } as const;
    const lenses = lampLenses({ ...pod, inner: 0.4, outer: 0.8 }, flat, { share: 1 / 3 });
    expect(lenses.map((l) => l.slot)).toEqual(["light", "tail"]);
    const [white, red] = lenses as [FrontDecal, FrontDecal];
    const covered = white.outer - white.inner + (red.outer - red.inner);
    expect(covered).toBeGreaterThan(0.8 * 0.4);
    expect(white.outer - white.inner).toBeGreaterThan(1.5 * (red.outer - red.inner));
    expect(white.top - white.bottom).toBeGreaterThan(0.6 * 0.22);
  });

  it("lets a cluster lamp with no lens margin fill its housing edge to edge, so no dark rim shows", () => {
    const flat: Facets = (u, z) => ({ point: [0, u * 1.4, z], normal: [1, 0, 0] });
    const pod = { slot: "light", bottom: 1.0, top: 1.22, round: 4, slant: 0, fill: true } as const;
    const bare = lampLenses({ ...pod, inner: 0.4, outer: 0.8, lensMargin: 0 }, flat, {
      share: 0.2,
      inner: true,
    });
    expect(bare.map((l) => l.slot)).toEqual(["tail", "light"]);
    const [red, white] = bare as [FrontDecal, FrontDecal];
    expect(red.inner).toBeCloseTo(0.4, 9);
    expect(white.outer).toBeCloseTo(0.8, 9);
    expect(white.bottom).toBeCloseTo(1.0, 9);
    expect(white.top).toBeCloseTo(1.22, 9);
    const framed = lampLenses({ ...pod, inner: 0.4, outer: 0.8 }, flat, { share: 0.2 });
    expect(framed[0]?.bottom ?? 0).toBeGreaterThan(1.02);
  });

  it("tilts a decal so that its outer end rises and the lamp splits into white and red faces", () => {
    const tilted = buildFront(
      {
        ...front,
        decals: [
          {
            slot: "light",
            bottom: 1.0,
            top: 1.2,
            inner: 0.35,
            outer: 0.75,
            round: 4,
            slant: 0,
            tilt: 20,
            fill: true,
            tail: 1 / 3,
          },
        ],
      },
      bands,
      ring,
      "full",
    );
    const white = triangles(tilted, "light")
      .flat()
      .filter((p) => p[1] > 0);
    const red = triangles(tilted, "tail")
      .flat()
      .filter((p) => p[1] > 0);
    expect(white.length).toBeGreaterThan(0);
    expect(red.length).toBeGreaterThan(0);
    const mean = (ps: Vec3[], i: number) =>
      ps.reduce((s, p) => s + (p[i] as number), 0) / ps.length;
    expect(mean(red, 1)).toBeGreaterThan(mean(white, 1));
    expect(mean(red, 2)).toBeGreaterThan(mean(white, 2) + 0.03);
    expect(
      triangles(tilted, "tail")
        .flat()
        .some((p) => p[1] < 0),
    ).toBe(true);
  });

  it("draws the windscreen as a pane off the nose at full detail and as painted faces below it", () => {
    const full = buildFront(front, bands, ring, "full");
    const band = buildFront(front, bands, ring, "band");
    const paneFaces = triangles(full, "window").filter((f) => f.every((p) => p[0] > 6.0 - 4.5));
    expect(paneFaces.length).toBeGreaterThan(100);
    for (const f of paneFaces)
      for (const p of f) {
        expect(p[2]).toBeGreaterThan(1.9 - 0.05);
        expect(p[2]).toBeLessThan(3.2 + 0.05);
      }
    expect(triangles(band, "window").length).toBeGreaterThan(0);
    const sheen = triangles(full, "sheen");
    expect(sheen.length).toBeGreaterThan(0);
    for (const f of sheen) for (const p of f) expect(p[2]).toBeGreaterThan(1.9 + 0.75 * 1.3);
    const frame = triangles(full, "housing").flat();
    expect(Math.max(...frame.map((p) => p[2]))).toBeGreaterThan(3.2 + 0.03);
    expect(outwardShare(full)).toBeGreaterThan(0.99);
  });

  it("mirrors a decal with an inner edge on both sides and centres one without", () => {
    const full = buildFront(front, bands, ring, "full");
    const lamps = triangles(full, "light").flat();
    expect(lamps.some((p) => p[1] > 0.3)).toBe(true);
    expect(lamps.some((p) => p[1] < -0.3)).toBe(true);
    for (const p of lamps) {
      expect(p[2]).toBeGreaterThan(1.0 - 0.02);
      expect(p[2]).toBeLessThan(1.25 + 0.02);
    }
    const logo = triangles(full, "stripe")
      .filter((f) => f.every((p) => p[0] > 5 && p[2] > 1.29 && p[2] < 1.45))
      .flat();
    expect(logo.length).toBeGreaterThan(0);
    expect(Math.max(...logo.map((p) => Math.abs(p[1])))).toBeLessThan(0.3);
    expect(triangles(buildFront(front, bands, ring, "band"), "light").length).toBe(0);
  });

  it("paints a light helmet in the neutral grey and draws a decal marked under below the windscreen", () => {
    const helmet: FrontSpec = {
      ...front,
      mask: { bottom: 2.4, top: 3.8, width: 0.9 },
      maskSlot: "equipment",
      decals: [
        {
          slot: "equipment",
          bottom: 1.8,
          top: 3.0,
          inner: 0,
          outer: 0.9,
          round: 2.6,
          slant: 0,
          under: true,
        },
      ],
    };
    const full = buildFront(helmet, bands, ring, "band");
    expect(triangles(full, "equipment").length).toBeGreaterThan(0);
    expect(triangles(full, "mask").length).toBe(0);
    const paned = buildFront(helmet, bands, ring, "full");
    const centre = (slot: Slot) =>
      triangles(paned, slot)
        .flat()
        .filter((p) => Math.abs(p[1]) < 0.05 && p[2] > 2.2 && p[2] < 2.9);
    const grey = centre("equipment");
    let compared = 0;
    for (const w of centre("window")) {
      const below = grey.filter((g) => Math.abs(g[2] - w[2]) < 0.03).map((g) => g[0]);
      if (below.length === 0) continue;
      compared++;
      expect(w[0]).toBeGreaterThan(Math.max(...below));
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("keeps the cab side window inside its own band, its front edge rounding back", () => {
    const full = buildFront(front, bands, ring, "full");
    const side = triangles(full, "window").filter((f) =>
      f.every((p) => p[0] < 6.0 - 3.55 && Math.abs(p[1]) > 1.2),
    );
    expect(side.length).toBeGreaterThan(0);
    const points = side.flat();
    for (const p of points) {
      expect(p[2]).toBeGreaterThan(2.0 - 0.02);
      expect(p[2]).toBeLessThan(3.1 + 0.02);
    }
    const frontAt = (z: number) =>
      Math.max(...points.filter((p) => Math.abs(p[2] - z) < 0.06).map((p) => p[0]));
    expect(frontAt(2.55)).toBeGreaterThan(frontAt(3.08));
  });
});

function outwardShare(mesh: MeshBuilder): number {
  const p = mesh.positions;
  const at = (i: number): Vec3 => [p[i] as number, p[i + 1] as number, p[i + 2] as number];
  let outward = 0;
  let total = 0;
  for (let t = 0; t < p.length / 9; t++) {
    const [a, b, c] = [at(t * 9), at(t * 9 + 3), at(t * 9 + 6)];
    const n = cross(sub(b, a), sub(c, a));
    if (Math.hypot(...n) < 1e-9) continue;
    const cx = (a[0] + b[0] + c[0]) / 3;
    const out: Vec3 = [
      cx - Math.min(cx, 3),
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3 - 1.6,
    ];
    total++;
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] >= 0) outward++;
  }
  return outward / total;
}
