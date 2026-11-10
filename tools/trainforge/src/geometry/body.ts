import type { Slot } from "../palette.ts";
import type { CarSpec } from "../spec.ts";
import { frontLevels } from "./front.ts";
import type { LodSettings } from "./lod.ts";
import type { MeshBuilder, Vec3 } from "./mesh.ts";
import { roofZAt, type SectionParams } from "./profile.ts";

const NOSE_TIP_GAP = 0.05;
const GANGWAY_GAP = 0.3;
const JACOBS_GAP = 0.15;
const RECESS = 0.045;
/** Half width of the roof band that carries the colour mode, as a fraction of the half width. */
export const BAND_FRACTION = 0.62;

export interface BodyLevels {
  readonly floor: number;
  readonly sill: number;
  readonly top: number;
  readonly stripeBottom: number;
  readonly stripeTop: number;
  readonly skirtTop: number | null;
  readonly height: number;
  readonly bottom: number;
  readonly eave: number;
  readonly bandZ: number;
}

export interface Zone {
  readonly x0: number;
  readonly x1: number;
  readonly bottom: number;
  readonly sideBottom: number;
}

interface Opening {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly kind: "window" | "door" | "panel";
}

export interface BodyLayout {
  readonly frontEnd: number;
  readonly rearEnd: number;
  readonly constFront: number;
  readonly constRear: number;
  readonly zones: readonly Zone[];
  readonly levels: BodyLevels;
  readonly eave: number;
  readonly openings: readonly Opening[];
  /** Heights every cross-section of this car carries as points. */
  readonly ringLevels: readonly number[];
  /** Forward of this x (the foremost passenger window's end) the side between sill and window top keeps the body colour. */
  readonly plainFrom?: number;
  /** At full detail the side stripe is left out between these x, behind lettering on the cab side. */
  readonly stripeGap?: readonly [number, number];
}

export function sectionFor(
  spec: CarSpec,
  lod: LodSettings,
  zone: Zone,
  eave: number,
): SectionParams {
  return {
    halfWidth: spec.width / 2,
    height: spec.height,
    eave,
    sideBottom: zone.sideBottom,
    bottom: zone.bottom,
    tuck: 0.1,
    roofExponent: spec.roofExponent ?? (spec.category === "hsr" ? 2.3 : 2.9),
    tumblehome: spec.tumblehome,
    roofSegments: lod.roofSegments,
    lowerSegments: lod.lowerSegments,
  };
}

function endGap(spec: CarSpec, end: 0 | 1): number {
  return spec.bogies[end].kind === "jacobs" ? JACOBS_GAP : GANGWAY_GAP;
}

/** Underside of the body between the bogies. */
export function lowBottomOf(spec: CarSpec): number {
  if (spec.bodyBottom != null) return spec.bodyBottom;
  return spec.doubleDeck
    ? Math.max(0.28, spec.lowerDeckFloor - 0.28)
    : Math.max(0.42, spec.floor - (spec.category === "hsr" ? 0.6 : 0.4));
}

/** Tuck of a measured bogie skirt from its vertical side to its underside, metres. */
const SKIRT_TUCK = 0.04;

/** Side bottom and underside over the bogies: the measured skirt, kept clear of the wheels, or the clearance rule. */
function highZone(spec: CarSpec, clearance: number, lowSide: number) {
  if (spec.bogieSkirt === undefined)
    return { bottom: clearance, sideBottom: Math.max(clearance + 0.14, lowSide) };
  const side = Math.max(spec.bogieSkirt, spec.wheelDiameter + 0.02 + SKIRT_TUCK);
  return { bottom: side - SKIRT_TUCK, sideBottom: side };
}

function zonesFor(spec: CarSpec, lod: LodSettings, constRear: number, constFront: number): Zone[] {
  const clearance = spec.wheelDiameter + 0.14;
  const lowBottom = lowBottomOf(spec);
  const lowSide = spec.doubleDeck
    ? spec.lowerDeckFloor - 0.04
    : Math.max(lowBottom + 0.12, spec.floor - 0.06);
  if (lowBottom >= clearance || !lod.zones || spec.bodyBottom != null) {
    return [{ x0: constRear, x1: constFront, bottom: lowBottom, sideBottom: lowSide }];
  }
  const high = highZone(spec, clearance, lowSide);
  const spans = spec.bogies
    .map((b) => [b.x - b.wheelbase / 2 - 0.55, b.x + b.wheelbase / 2 + 0.55] as const)
    .map(([a, b]) => [Math.max(a, constRear), Math.min(b, constFront)] as const)
    .filter(([a, b]) => b - a > 0.05)
    .sort((p, q) => p[0] - q[0]);
  const zones: Zone[] = [];
  let cursor = constRear;
  for (const [a, b] of spans) {
    if (a > cursor + 0.05)
      zones.push({ x0: cursor, x1: a, bottom: lowBottom, sideBottom: lowSide });
    zones.push({ x0: Math.max(a, cursor), x1: b, ...high });
    cursor = b;
  }
  if (constFront > cursor + 0.05) {
    zones.push({ x0: cursor, x1: constFront, bottom: lowBottom, sideBottom: lowSide });
  } else if (zones.length) {
    const last = zones.pop() as Zone;
    zones.push({ ...last, x1: constFront });
  }
  return zones;
}

function windowRow(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  doors: readonly Opening[],
  width: number,
  pillar: number,
  separate: boolean,
): Opening[] {
  const blocked = doors
    .map((d) => [d.x0 - 0.3, d.x1 + 0.3] as const)
    .filter(([a, b]) => b > x0 && a < x1)
    .sort((p, q) => p[0] - q[0]);
  const spans: [number, number][] = [];
  let cursor = x0;
  for (const [a, b] of blocked) {
    if (a > cursor) spans.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (x1 > cursor) spans.push([cursor, x1]);
  const out: Opening[] = [];
  for (const [a, b] of spans) {
    const span = b - a;
    if (span < 0.7) continue;
    if (!separate) {
      out.push({ x0: a + pillar / 2, x1: b - pillar / 2, z0, z1, kind: "window" });
      continue;
    }
    const count = Math.max(1, Math.floor((span + pillar) / (width + pillar)));
    const pitch = span / count;
    for (let i = 0; i < count; i++) {
      const centre = a + pitch * (i + 0.5);
      const half = Math.max(0.25, (pitch - pillar) / 2);
      out.push({ x0: centre - half, x1: centre + half, z0, z1, kind: "window" });
    }
  }
  return out;
}

function doorOpenings(
  spec: CarSpec,
  lod: LodSettings,
  constRear: number,
  constFront: number,
  eave: number,
): Opening[] {
  if (spec.role === "locomotive" || spec.role === "power_head" || !lod.doors) return [];
  const doorBase = spec.doubleDeck ? spec.lowerDeckFloor : spec.floor;
  const doorTop = Math.min(eave - 0.1, doorBase + 2.0);
  return spec.doors
    .filter((d) => d.x - d.width / 2 > constRear && d.x + d.width / 2 < constFront)
    .map((d) => ({
      x0: d.x - d.width / 2,
      x1: d.x + d.width / 2,
      z0: doorBase - 0.03,
      z1: doorTop,
      kind: "door" as const,
    }));
}

function lowerDeckRows(spec: CarSpec, zones: readonly Zone[]): [Zone, number, number][] {
  const lowSill = spec.lowerDeckFloor + 0.62;
  const lowTop = Math.min(spec.lowerDeckFloor + 1.55, spec.windowSill - 0.35);
  return zones
    .map((zone): [Zone, number, number] => {
      const low = zone.bottom < 0.9;
      const z0 = low ? lowSill : Math.max(zone.sideBottom + 0.5, lowSill + 0.45);
      const z1 = low ? lowTop : Math.min(z0 + 0.85, spec.windowSill - 0.3);
      return [zone, z0, z1];
    })
    .filter(([, z0, z1]) => z1 - z0 >= 0.4);
}

function cabWindow(spec: CarSpec, constFront: number, frontEnd: number): Opening[] {
  if (!spec.front?.cabWindow) return [];
  const side = spec.front.sideWindow;
  const x0 = side ? frontEnd - side.to : frontEnd - spec.front.cabLength + 0.35;
  const x1 = side ? Math.min(constFront, frontEnd - side.from) : constFront - 0.1;
  return x1 - x0 >= 0.4
    ? [{ x0, x1, z0: spec.windowSill, z1: spec.windowTop, kind: "window" }]
    : [];
}

function windowOpenings(
  spec: CarSpec,
  lod: LodSettings,
  zones: readonly Zone[],
  range: readonly [number, number],
  doors: readonly Opening[],
): Opening[] {
  if (spec.role === "locomotive" || spec.role === "power_head") return [];
  const margin = 0.45;
  const from = range[0] + margin;
  const to = range[1] - margin;
  const row = (x0: number, x1: number, z0: number, z1: number) =>
    windowRow(x0, x1, z0, z1, doors, spec.windowWidth, spec.pillar, lod.separateWindows);
  const windows = to > from ? row(from, to, spec.windowSill, spec.windowTop) : [];
  if (!spec.doubleDeck) return windows;
  const below: Opening[] = [];
  for (const [zone, z0, z1] of lowerDeckRows(spec, zones)) {
    const a = Math.max(zone.x0, from);
    const b = Math.min(zone.x1, to);
    for (const w of windows) {
      if (w.x0 >= a - 1e-6 && w.x1 <= b + 1e-6) below.push({ ...w, z0, z1 });
    }
  }
  return [...windows, ...below];
}

function cabOpenings(
  spec: CarSpec,
  lod: LodSettings,
  ends: { constFront: number; frontEnd: number; constRear: number; rearEnd: number },
): Opening[] {
  if (!lod.cabWindows) return [];
  const front = cabWindow(spec, ends.constFront, ends.frontEnd);
  if (!spec.noseAtRear) return front;
  const rear = cabWindow(spec, -ends.constRear, -ends.rearEnd);
  return [...front, ...rear.map((o) => ({ ...o, x0: -o.x1, x1: -o.x0 }))];
}

/** Measured side panels (grilles, louvres), recessed into both side walls where the level has roof equipment. */
function panelOpenings(
  spec: CarSpec,
  lod: LodSettings,
  constRear: number,
  constFront: number,
): Opening[] {
  if (!lod.roofEquipment || !spec.sidePanels) return [];
  return spec.sidePanels
    .map(([from, to, z0, z1]) => ({
      x0: Math.max(from, constRear),
      x1: Math.min(to, constFront),
      z0,
      z1,
      kind: "panel" as const,
    }))
    .filter((o) => o.x1 - o.x0 > 0.05);
}

function eaveOf(spec: CarSpec): number {
  const roofRise = spec.doubleDeck ? 0.42 : spec.category === "hsr" ? 0.82 : 0.5;
  return Math.min(spec.height - 0.12, Math.max(spec.height - roofRise, spec.windowTop + 0.08));
}

function bodyLevels(spec: CarSpec, lod: LodSettings, zones: readonly Zone[], eave: number) {
  const stripeTop = spec.stripe?.top ?? spec.windowSill - 0.08;
  const section = sectionFor(spec, lod, zones[0] as Zone, eave);
  return {
    floor: spec.floor,
    sill: spec.windowSill,
    top: spec.windowTop,
    stripeTop,
    stripeBottom: spec.stripe?.bottom ?? stripeTop - 0.24,
    skirtTop: spec.skirtTop,
    height: spec.height,
    bottom: Math.min(...zones.map((z) => z.bottom)),
    eave,
    bandZ: roofZAt(section, (spec.width / 2) * BAND_FRACTION),
  };
}

export function bodyLayout(spec: CarSpec, lod: LodSettings): BodyLayout {
  const half = spec.length / 2;
  const front = spec.front;
  const rearNose = spec.noseAtRear && front ? front : null;
  const tipGap = front?.tipGap ?? NOSE_TIP_GAP;
  const frontEnd = front ? half - tipGap : half - endGap(spec, 0);
  const rearEnd = spec.noseAtRear ? -half + tipGap : -half + endGap(spec, 1);
  const constFront = front ? frontEnd - front.length : frontEnd;
  const constRear = rearNose ? rearEnd + rearNose.length : rearEnd;
  const zones = zonesFor(spec, lod, constRear, constFront);
  const eave = eaveOf(spec);
  const levels: BodyLevels = bodyLevels(spec, lod, zones, eave);
  const passengerEnd = front ? frontEnd - front.cabLength : constFront;
  const rearPassengerEnd = rearNose ? rearEnd + rearNose.cabLength : constRear;
  const doors = doorOpenings(spec, lod, constRear, constFront, eave);
  const windows = windowOpenings(spec, lod, zones, [rearPassengerEnd, passengerEnd], doors);
  const cab = cabOpenings(spec, lod, { constFront, frontEnd, constRear, rearEnd });
  const panels = panelOpenings(spec, lod, constRear, constFront);
  return {
    frontEnd,
    rearEnd,
    constFront,
    constRear,
    zones,
    levels,
    eave,
    openings: [...doors, ...windows, ...cab, ...panels],
    ringLevels: ringLevels(spec, lod, levels),
    ...(front?.plainCabSide ? { plainFrom: plainCabFrom(windows, passengerEnd) } : {}),
    ...facadeStripeGap(front, lod, frontEnd, constFront),
  };
}

/** A lettering's stripe gap where it lies behind the nose on a plain side stripe, as body x. */
function facadeStripeGap(
  front: CarSpec["front"],
  lod: LodSettings,
  frontEnd: number,
  constFront: number,
): { stripeGap?: readonly [number, number] } {
  const gap = front?.lettering?.stripeGap;
  if (!gap || front?.stripeCurve || lod.noseLevels !== "full") return {};
  const x0 = frontEnd - gap[1];
  const x1 = Math.min(constFront, frontEnd - gap[0]);
  return x1 > x0 ? { stripeGap: [x0, x1] } : {};
}

/** Where a plain cab side starts: the front end of the foremost passenger window, else the cab's end. */
function plainCabFrom(windows: readonly Opening[], passengerEnd: number): number {
  const ends = windows.map((o) => o.x1).filter((x) => x <= passengerEnd + 1e-6);
  return ends.length ? Math.max(...ends) : passengerEnd;
}

function ringLevels(spec: CarSpec, lod: LodSettings, l: BodyLevels): number[] {
  const out = [l.bandZ];
  if (spec.front) {
    const detail = lod.noseLevels === "none" ? "screen" : lod.noseLevels;
    out.push(...frontLevels(spec.front, detail));
    if (detail !== "screen") out.push(l.sill, l.top);
    if (lod.stripe && lod.frontStripe) out.push(l.stripeBottom, l.stripeTop);
    if (detail === "full") out.push(l.floor);
  }
  if (l.skirtTop !== null) out.push(l.skirtTop);
  return out;
}

/** Writes faces on one side wall (left y > 0 or right y < 0), mirroring and flipping for the right. */
class SideWriter {
  private readonly mesh: MeshBuilder;
  private readonly side: 1 | -1;

  constructor(mesh: MeshBuilder, side: 1 | -1) {
    this.mesh = mesh;
    this.side = side;
  }

  private p(x: number, y: number, z: number): Vec3 {
    return [x, this.side * y, z];
  }

  private emit(a: Vec3, b: Vec3, c: Vec3, d: Vec3, slot: Slot) {
    if (this.side === 1) this.mesh.quad(a, b, c, d, slot);
    else this.mesh.quad(a, d, c, b, slot);
  }

  /** Wall rectangle in the plane y = w, facing outwards. */
  wall(y: number, x0: number, x1: number, z0: number, z1: number, slot: Slot) {
    if (x1 - x0 < 1e-6 || z1 - z0 < 1e-6) return;
    this.emit(this.p(x0, y, z0), this.p(x0, y, z1), this.p(x1, y, z1), this.p(x1, y, z0), slot);
  }

  /** Faces lining a rectangular hole from the wall at y = w to the recessed panel. */
  reveals(
    w: number,
    depth: number,
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    ends: [boolean, boolean],
  ) {
    const i = w - depth;
    const p = (x: number, y: number, z: number) => this.p(x, y, z);
    this.emit(p(x0, i, z0), p(x1, i, z0), p(x1, w, z0), p(x0, w, z0), "reveal");
    this.emit(p(x0, i, z1), p(x0, w, z1), p(x1, w, z1), p(x1, i, z1), "reveal");
    if (ends[0]) this.emit(p(x0, i, z0), p(x0, w, z0), p(x0, w, z1), p(x0, i, z1), "reveal");
    if (ends[1]) this.emit(p(x1, i, z0), p(x1, i, z1), p(x1, w, z1), p(x1, w, z0), "reveal");
  }
}

function solidSlots(
  levels: BodyLevels,
  eave: number,
  stripe: boolean,
  pillar: Slot | null,
): [number, number, Slot][] {
  const skirt = levels.skirtTop ?? -Infinity;
  const cuts = [skirt, levels.sill, levels.top, eave + 1];
  if (stripe) cuts.push(levels.stripeBottom, levels.stripeTop);
  const edges = [-Infinity, ...new Set(cuts.filter((z) => Number.isFinite(z)))].sort(
    (p, q) => p - q,
  );
  const slotAt = (z: number): Slot => {
    if (z < skirt) return "skirt";
    if (stripe && z > levels.stripeBottom && z < levels.stripeTop) return "stripe";
    if (z > levels.sill && z < levels.top) return pillar ?? "upper_body";
    return z > levels.sill ? "upper_body" : "lower_body";
  };
  const bands: [number, number, Slot][] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i] as number;
    const hi = edges[i + 1] as number;
    const mid = Number.isFinite(lo) ? (lo + hi) / 2 : hi - 1;
    bands.push([lo, hi, slotAt(mid)]);
  }
  return bands;
}

function columnEdges(layout: BodyLayout): number[] {
  const edges = new Set<number>([layout.constRear, layout.constFront]);
  for (const zone of layout.zones) edges.add(zone.x0).add(zone.x1);
  for (const o of layout.openings) edges.add(o.x0).add(o.x1);
  if (layout.plainFrom !== undefined) edges.add(layout.plainFrom);
  if (layout.stripeGap) edges.add(layout.stripeGap[0]).add(layout.stripeGap[1]);
  return [...edges]
    .filter((x) => x >= layout.constRear && x <= layout.constFront)
    .sort((a, b) => a - b);
}

interface FacadeContext {
  readonly writer: SideWriter;
  readonly w: number;
  readonly layout: BodyLayout;
  readonly lod: LodSettings;
  readonly bands: readonly [number, number, Slot][];
  /** Bands forward of the layout's plainFrom, without the dark band between sill and window top. */
  readonly plainBands: readonly [number, number, Slot][];
  /** Bands inside the layout's stripe gap, without the stripe. */
  readonly gapBands: readonly [number, number, Slot][];
  readonly floor: number;
}

function emitSolid(ctx: FacadeContext, x0: number, x1: number, z0: number, z1: number) {
  const plain = ctx.layout.plainFrom !== undefined && x0 >= ctx.layout.plainFrom - 1e-6;
  const gap = ctx.layout.stripeGap;
  const inGap = !!gap && x0 >= gap[0] - 1e-6 && x1 <= gap[1] + 1e-6;
  for (const [a, b, slot] of inGap ? ctx.gapBands : plain ? ctx.plainBands : ctx.bands) {
    const lo = Math.max(a, z0);
    const hi = Math.min(b, z1);
    if (hi > lo + 1e-6) ctx.writer.wall(ctx.w, x0, x1, lo, hi, slot);
  }
}

function emitColumn(ctx: FacadeContext, x0: number, x1: number) {
  const { layout } = ctx;
  const mid = (x0 + x1) / 2;
  const zone = layout.zones.find((z) => mid >= z.x0 && mid <= z.x1) ?? layout.zones[0];
  const covering = layout.openings
    .filter((o) => o.x0 <= x0 + 1e-6 && o.x1 >= x1 - 1e-6)
    .sort((a, b) => a.z0 - b.z0);
  let cursor = zone?.sideBottom ?? ctx.floor;
  for (const o of covering) {
    const z0 = Math.max(o.z0, cursor);
    const z1 = Math.min(o.z1, layout.eave);
    if (z1 <= z0) continue;
    emitSolid(ctx, x0, x1, cursor, z0);
    emitOpening(ctx.writer, ctx.w, x0, x1, z0, z1, o, ctx.lod);
    cursor = z1;
  }
  emitSolid(ctx, x0, x1, cursor, layout.eave);
}

export function emitFacade(mesh: MeshBuilder, spec: CarSpec, layout: BodyLayout, lod: LodSettings) {
  const xs = columnEdges(layout);
  const passenger = spec.role !== "locomotive" && spec.role !== "power_head";
  const pillar: Slot | null =
    !passenger || spec.pillars === "body" ? null : spec.pillars === "mask" ? "mask" : "window_band";
  const bands = solidSlots(layout.levels, layout.eave, lod.stripe, pillar);
  const plainBands =
    layout.plainFrom === undefined
      ? bands
      : solidSlots(layout.levels, layout.eave, lod.stripe, null);
  const gapBands = layout.stripeGap
    ? solidSlots(layout.levels, layout.eave, false, layout.plainFrom === undefined ? pillar : null)
    : bands;
  for (const side of [1, -1] as const) {
    const ctx: FacadeContext = {
      writer: new SideWriter(mesh, side),
      w: spec.width / 2,
      layout,
      lod,
      bands,
      plainBands,
      gapBands,
      floor: spec.floor,
    };
    for (let i = 0; i < xs.length - 1; i++) {
      const x0 = xs[i] as number;
      const x1 = xs[i + 1] as number;
      if (x1 - x0 >= 1e-4) emitColumn(ctx, x0, x1);
    }
  }
}

/** Dark seam round a door leaf at full detail, metres. */
const DOOR_SEAM = 0.035;

function emitOpening(
  writer: SideWriter,
  w: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  o: Opening,
  lod: LodSettings,
) {
  const depth = lod.recessedOpenings ? RECESS : 0;
  const y = w - depth;
  if (depth > 0) {
    writer.reveals(w, depth, x0, x1, z0, z1, [
      Math.abs(x0 - o.x0) < 1e-6,
      Math.abs(x1 - o.x1) < 1e-6,
    ]);
  }
  if (o.kind === "window" || o.kind === "panel") {
    writer.wall(y, x0, x1, z0, z1, o.kind === "window" ? "window" : "mask");
    return;
  }
  if (!lod.doorWindows) {
    writer.wall(y, x0, x1, z0, z1, "doors");
    return;
  }
  let a = x0;
  let b = x1;
  let top = z1;
  if (lod.recessedOpenings) {
    if (Math.abs(x0 - o.x0) < 1e-6) {
      writer.wall(y, x0, x0 + DOOR_SEAM, z0, z1, "housing");
      a = x0 + DOOR_SEAM;
    }
    if (Math.abs(x1 - o.x1) < 1e-6) {
      writer.wall(y, x1 - DOOR_SEAM, x1, z0, z1, "housing");
      b = x1 - DOOR_SEAM;
    }
    writer.wall(y, a, b, z1 - DOOR_SEAM, z1, "housing");
    top = z1 - DOOR_SEAM;
  }
  const glassBottom = z1 - Math.min(0.95, (z1 - z0) * 0.48);
  const glassTop = z1 - 0.14;
  writer.wall(y, a, b, z0, glassBottom, "doors");
  writer.wall(y, a, b, glassBottom, glassTop, "window");
  writer.wall(y, a, b, glassTop, top, "doors");
}
