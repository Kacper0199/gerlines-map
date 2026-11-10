import type { Slot } from "../palette.ts";
import type { BogieSpec, CarSpec } from "../spec.ts";
import {
  BAND_FRACTION,
  type BodyLayout,
  bodyLayout,
  emitFacade,
  lowBottomOf,
  sectionFor,
  type Zone,
} from "./body.ts";
import { type Apron, buildFront, type FrontBands } from "./front.ts";
import type { LodSettings } from "./lod.ts";
import { add, cross, MeshBuilder, normalize, scale, sub, type Vec3 } from "./mesh.ts";
import { fullRing, type Ring, roofZAt, type SectionPoint } from "./profile.ts";
import { emitGrid } from "./surface.ts";

function ringAt(ring: Ring, columns: readonly number[], x: number): Vec3[] {
  return columns.map((c) => {
    const q = ring.points[c] as SectionPoint;
    return [x, q.y, q.z] as Vec3;
  });
}

function range(from: number, to: number, size: number): number[] {
  const out: number[] = [];
  for (let i = from; ; i = (i + 1) % size) {
    out.push(i);
    if (i === to) return out;
  }
}

function zoneRing(spec: CarSpec, lod: LodSettings, layout: BodyLayout, zone: Zone): Ring {
  return fullRing(sectionFor(spec, lod, zone, layout.eave), layout.ringLevels);
}

function emitLowerLoft(
  mesh: MeshBuilder,
  spec: CarSpec,
  lod: LodSettings,
  layout: BodyLayout,
  zone: Zone,
) {
  const ring = zoneRing(spec, lod, layout, zone);
  const columns = range(ring.leftWall[1], ring.rightWall[0], ring.points.length);
  const rows = [ringAt(ring, columns, zone.x0), ringAt(ring, columns, zone.x1)];
  const flat = (c: number) =>
    Math.abs((ring.points[columns[c] as number]?.z ?? 0) - zone.bottom) < 1e-6;
  const skirt = layout.levels.skirtTop;
  emitGrid(mesh, { rows, closed: false }, (_, c) => {
    if (flat(c) && flat(c + 1)) return null;
    return skirt !== null ? "skirt" : "lower_body";
  });
}

/** The roof over the constant section: the colour-mode band in the middle, roof colour beside it. */
function emitRoofLoft(mesh: MeshBuilder, spec: CarSpec, lod: LodSettings, layout: BodyLayout) {
  const zone = layout.zones[0] as Zone;
  const ring = zoneRing(spec, lod, layout, zone);
  const columns = range(ring.rightWall[1], ring.leftWall[0], ring.points.length);
  const rows = [ringAt(ring, columns, layout.constRear), ringAt(ring, columns, layout.constFront)];
  const band = (spec.width / 2) * BAND_FRACTION + 1e-6;
  emitGrid(mesh, { rows, closed: false }, (_, c) => {
    const a = ring.points[columns[c] as number] as SectionPoint;
    const b = ring.points[columns[c + 1] as number] as SectionPoint;
    return Math.abs(a.y) <= band && Math.abs(b.y) <= band ? "mode" : "roof";
  });
}

function emitZoneSteps(mesh: MeshBuilder, spec: CarSpec, layout: BodyLayout) {
  const w = spec.width / 2;
  for (let i = 0; i < layout.zones.length - 1; i++) {
    const a = layout.zones[i] as Zone;
    const b = layout.zones[i + 1] as Zone;
    if (Math.abs(a.bottom - b.bottom) < 1e-6) continue;
    const [low, high] = a.bottom < b.bottom ? [a, b] : [b, a];
    const x = a.x1;
    const facing: Vec3 = [high === b ? 1 : -1, 0, 0];
    const quad: [Vec3, Vec3, Vec3, Vec3] = [
      [x, w, high.sideBottom],
      [x, -w, high.sideBottom],
      [x, -(w - 0.1), low.bottom],
      [x, w - 0.1, low.bottom],
    ];
    mesh.facingQuad(quad, facing, layout.levels.skirtTop !== null ? "skirt" : "lower_body");
  }
}

function offsetX(mesh: MeshBuilder, dx: number): MeshBuilder {
  for (let i = 0; i < mesh.positions.length; i += 3)
    mesh.positions[i] = (mesh.positions[i] as number) + dx;
  return mesh;
}

/** Clearance kept between the apron and the leading wheel. */
const APRON_WHEEL_GAP = 0.15;

/**
 * The part of the front that reaches below the body ahead of the leading wheels, in the front's
 * frame (x from the nose base towards the tip), or null when the front ends above the body bottom.
 */
function apronOf(spec: CarSpec, layout: BodyLayout, zone: Zone, rear: boolean): Apron | null {
  const front = spec.front;
  if (!front) return null;
  const bottom = front.bottom ?? lowBottomOf(spec);
  if (bottom > zone.bottom - 0.02) return null;
  const bogie = spec.bogies[rear ? 1 : 0];
  const wheelFront = Math.abs(bogie.x) + bogie.wheelbase / 2 + bogie.wheelDiameter / 2;
  const base = rear ? -layout.constRear : layout.constFront;
  const start = Math.max(0, wheelFront + APRON_WHEEL_GAP - base);
  return start < front.length - 0.3 ? { bottom, start } : null;
}

function emitNose(
  mesh: MeshBuilder,
  spec: CarSpec,
  lod: LodSettings,
  layout: BodyLayout,
  rear: boolean,
) {
  const front = spec.front;
  if (!front) return;
  const zone = (rear ? layout.zones[0] : layout.zones[layout.zones.length - 1]) as Zone;
  const ring = zoneRing(spec, lod, layout, zone);
  const bands: FrontBands = {
    ...layout.levels,
    bottom: zone.bottom,
    windowBand: spec.role !== "power_head" && spec.role !== "locomotive" && !front.sideWindow,
  };
  const detail = lod.noseLevels === "none" ? "screen" : lod.noseLevels;
  const local = buildFront(front, bands, ring, detail, apronOf(spec, layout, zone, rear));
  if (rear) mesh.appendMirroredX(offsetX(local, -layout.constRear));
  else mesh.append(offsetX(local, layout.constFront));
}

/** A plain car end: the dark bellows at a joint, the body colour where it ends the formation. */
function emitEndWall(
  mesh: MeshBuilder,
  spec: CarSpec,
  lod: LodSettings,
  layout: BodyLayout,
  front: boolean,
) {
  const zone = (front ? layout.zones[layout.zones.length - 1] : layout.zones[0]) as Zone;
  const ring = zoneRing(spec, lod, layout, zone);
  const x = front ? layout.frontEnd : layout.rearEnd;
  const outer = ring.points.map((q) => [x, q.y, q.z] as Vec3);
  const cz = outer.reduce((s, p) => s + p[2], 0) / outer.length;
  const centre = outer.map(() => [x, 0, cz] as Vec3);
  const slot: Slot = spec.tailLamps === (front ? "front" : "rear") ? "body" : "gangway";
  emitGrid(mesh, { rows: front ? [outer, centre] : [centre, outer], closed: true }, () => slot);
}

/**
 * Zg 2 tail lamps on a plain end wall, metres: lens diameter, dark rim, height
 * of the lens centres just above the buffers, inset of the centres from the side wall, and the step
 * each disc stands off the wall. Placement follows the rule (low, left and right, the same height),
 * not a measured coach end.
 */
const END_TAIL = { lens: 0.15, rim: 0.03, z: 1.15, inset: 0.32, step: 0.01, segments: 12 } as const;

function disc(mesh: MeshBuilder, centre: Vec3, radius: number, facing: 1 | -1, slot: Slot) {
  const n = END_TAIL.segments;
  const at = (i: number): Vec3 => {
    const a = (2 * Math.PI * i) / n;
    return [centre[0], centre[1] + radius * Math.cos(a), centre[2] + radius * Math.sin(a)];
  };
  for (let i = 0; i < n; i++) {
    const [a, b] = facing > 0 ? [at(i), at(i + 1)] : [at(i + 1), at(i)];
    mesh.triangle(centre, a, b, slot);
  }
}

/** Two red lenses in dark rims low on the end wall that ends the formation (Zg 2), lit by the renderer at the trailing end. */
function emitEndTailLamps(mesh: MeshBuilder, spec: CarSpec, layout: BodyLayout) {
  const rear = spec.tailLamps === "rear";
  const facing = rear ? -1 : 1;
  const x = rear ? layout.rearEnd : layout.frontEnd;
  const y = spec.width / 2 - END_TAIL.inset;
  for (const side of [1, -1]) {
    const at = (step: number): Vec3 => [x + facing * step * END_TAIL.step, side * y, END_TAIL.z];
    disc(mesh, at(1), END_TAIL.lens / 2 + END_TAIL.rim, facing, "housing");
    disc(mesh, at(2), END_TAIL.lens / 2, facing, "tail");
  }
}

/** Bellows between cars, kept inside the roof line and above the body's underside at that end. */
function emitGangways(mesh: MeshBuilder, spec: CarSpec, lod: LodSettings, layout: BodyLayout) {
  const half = spec.length / 2;
  const fullWidth = spec.category === "hsr";
  const w = (spec.width * (fullWidth ? 0.92 : 0.55)) / 2;
  const section = sectionFor(spec, lod, layout.zones[0] as Zone, layout.eave);
  const roofAtSide = roofZAt(section, w) - 0.06;
  const top = spec.doubleDeck
    ? spec.height - 0.3
    : Math.min(spec.height - (fullWidth ? 0.12 : 0.25), spec.floor + 2.25 + (fullWidth ? 0.4 : 0));
  const z1 = Math.min(top, roofAtSide);
  const base = spec.doubleDeck ? spec.height - 2.45 : spec.floor - (fullWidth ? 0.35 : 0.1);
  const front = layout.zones[layout.zones.length - 1] as Zone;
  const rear = layout.zones[0] as Zone;
  if (!spec.front)
    mesh.box([layout.frontEnd, -w, Math.max(base, front.bottom + 0.05)], [half, w, z1], "gangway", [
      "bottom",
    ]);
  if (!spec.noseAtRear)
    mesh.box([-half, -w, Math.max(base, rear.bottom + 0.05)], [layout.rearEnd, w, z1], "gangway", [
      "bottom",
    ]);
}

function emitUnderframe(mesh: MeshBuilder, spec: CarSpec, layout: BodyLayout) {
  const [front, rear] = spec.bogies;
  const from = Math.max(rear.x + rear.wheelbase / 2 + 0.9, layout.constRear);
  const to = Math.min(front.x - front.wheelbase / 2 - 0.9, layout.constFront);
  const span = to - from;
  if (span < 2) return;
  const count = Math.min(3, Math.floor(span / 3));
  const pitch = span / Math.max(1, count);
  const w = spec.width * 0.36;
  for (let i = 0; i < count; i++) {
    const x = from + pitch * (i + 0.5);
    const zone = layout.zones.find((z) => x >= z.x0 && x <= z.x1) ?? (layout.zones[0] as Zone);
    if (zone.bottom - 0.4 < 0.3) continue;
    const h = Math.min(1.2, pitch / 2 - 0.25);
    mesh.box([x - h, -w, zone.bottom - 0.38], [x + h, w, zone.bottom + 0.02], "underframe", [
      "top",
    ]);
  }
}

function emitRoofEquipment(mesh: MeshBuilder, spec: CarSpec, layout: BodyLayout) {
  const top = spec.height;
  if (spec.roofEquipment) {
    const w = spec.width * 0.27;
    for (const [from, to] of spec.roofEquipment) {
      const x0 = Math.max(from, layout.constRear);
      const x1 = Math.min(to, layout.constFront);
      if (x1 - x0 < 0.3) continue;
      mesh.box([x0, -w, top - 0.08], [x1, w, top + 0.24], "equipment", ["bottom"]);
    }
    return;
  }
  if (spec.category === "hsr" || spec.category === "ld" || spec.role === "locomotive") return;
  for (const sign of [1, -1]) {
    const x = sign * (spec.length / 2 - 3.4);
    if (x - 1.3 < layout.constRear || x + 1.3 > layout.constFront) continue;
    if (spec.pantographs.some((p) => Math.abs(p - x) < 2)) continue;
    mesh.box([x - 1.3, -0.75, top - 0.08], [x + 1.3, 0.75, top + 0.26], "equipment", ["bottom"]);
  }
}

/** A square tube of the given size from a to b, one pair of sides facing along y. */
function tube(mesh: MeshBuilder, a: Vec3, b: Vec3, size: number) {
  const d = normalize(sub(b, a));
  const u: Vec3 = [0, size / 2, 0];
  const v = scale(normalize(cross(d, [0, 1, 0])), size / 2);
  const at = (p: Vec3, su: number, sv: number): Vec3 => add(add(p, scale(u, su)), scale(v, sv));
  for (const s of [1, -1]) {
    mesh.facingQuad([at(a, s, -1), at(b, s, -1), at(b, s, 1), at(a, s, 1)], scale(u, s), "bogie");
    mesh.facingQuad([at(a, -1, s), at(b, -1, s), at(b, 1, s), at(a, 1, s)], scale(v, s), "bogie");
  }
}

/** A folded single-arm pantograph: base frame, lower arm forward to the knee, upper arms back to the head. */
function emitFoldedPantograph(mesh: MeshBuilder, x: number, top: number) {
  mesh.box([x - 0.7, -0.45, top - 0.04], [x + 0.7, 0.45, top + 0.1], "bogie", ["bottom"]);
  const base: Vec3 = [x + 0.5, 0, top + 0.12];
  const knee: Vec3 = [x - 0.95, 0, top + 0.22];
  tube(mesh, base, knee, 0.08);
  for (const y of [0.3, -0.3]) tube(mesh, knee, [x + 0.95, y, top + 0.28], 0.05);
  mesh.box([x + 0.88, -0.95, top + 0.27], [x + 1.02, 0.95, top + 0.33], "bogie", ["bottom"]);
}

function emitPantographs(mesh: MeshBuilder, spec: CarSpec, lod: LodSettings) {
  const top = spec.height;
  for (const x of spec.pantographs) {
    if (lod.pantographDetail === "full") {
      emitFoldedPantograph(mesh, x, top);
      continue;
    }
    mesh.box([x - 0.7, -0.45, top - 0.04], [x + 0.7, 0.45, top + 0.12], "bogie", ["bottom"]);
    mesh.box([x - 0.16, -0.95, top + 0.25], [x + 0.16, 0.95, top + 0.33], "bogie", ["bottom"]);
  }
}

/** The car body for one level of detail, in the car frame (x forward, y left, z up). */
export function buildBody(spec: CarSpec, lod: LodSettings): MeshBuilder {
  const mesh = new MeshBuilder();
  const layout = bodyLayout(spec, lod);
  for (const zone of layout.zones) emitLowerLoft(mesh, spec, lod, layout, zone);
  emitRoofLoft(mesh, spec, lod, layout);
  emitZoneSteps(mesh, spec, layout);
  emitFacade(mesh, spec, layout, lod);
  if (spec.front) emitNose(mesh, spec, lod, layout, false);
  else emitEndWall(mesh, spec, lod, layout, true);
  if (spec.front && spec.noseAtRear) emitNose(mesh, spec, lod, layout, true);
  else emitEndWall(mesh, spec, lod, layout, false);
  if (lod.gangway) emitGangways(mesh, spec, lod, layout);
  if (spec.tailLamps && lod.noseLevels === "full") emitEndTailLamps(mesh, spec, layout);
  if (lod.underframe) emitUnderframe(mesh, spec, layout);
  if (lod.roofEquipment) emitRoofEquipment(mesh, spec, layout);
  if (lod.pantographDetail !== "none") emitPantographs(mesh, spec, lod);
  return mesh;
}

/** One bogie centred on its pivot (x = 0) on top of rail; shared by both cars at a Jacobs joint. */
export function buildBogie(bogie: BogieSpec, lod: LodSettings): MeshBuilder {
  const mesh = new MeshBuilder();
  const r = bogie.wheelDiameter / 2;
  const reach = bogie.wheelbase / 2 + 0.45;
  if (lod.bogieDetail === "block") {
    mesh.box([-reach, -1.0, 0.12], [reach, 1.0, r + 0.28], "bogie", ["bottom"]);
    return mesh;
  }
  const half = bogie.wheelbase / 2;
  if (lod.bogieDetail === "box") {
    for (const side of [1, -1]) {
      const y0 = side * 0.9;
      const y1 = side * 1.04;
      mesh.box([-reach, Math.min(y0, y1), r - 0.14], [reach, Math.max(y0, y1), r + 0.26], "bogie");
    }
  } else {
    const waist = Math.max(0.2, half - 0.3);
    for (const side of [1, -1]) {
      const lo = (a: number, b: number) => Math.min(side * a, side * b);
      const hi = (a: number, b: number) => Math.max(side * a, side * b);
      mesh.box([-waist, lo(0.86, 0.98), r - 0.2], [waist, hi(0.86, 0.98), r + 0.16], "bogie");
      for (const end of [1, -1]) {
        const x0 = end * waist;
        const x1 = end * reach;
        mesh.box(
          [Math.min(x0, x1), lo(0.86, 0.98), r + 0.0],
          [Math.max(x0, x1), hi(0.86, 0.98), r + 0.3],
          "bogie",
          ["bottom"],
        );
        mesh.box(
          [end * half - 0.16, lo(0.82, 1.04), r - 0.13],
          [end * half + 0.16, hi(0.82, 1.04), r + 0.06],
          "bogie",
          ["top"],
        );
      }
    }
  }
  mesh.box([-0.32, -0.9, r + 0.02], [0.32, 0.9, r + 0.34], "bogie", ["bottom"]);
  const segments = lod.wheelSegments;
  for (const x of [half, -half]) {
    for (const y of [0.76, -0.76]) mesh.wheel([x, y, r], r, 0.14, segments, "underframe", true);
  }
  return mesh;
}
