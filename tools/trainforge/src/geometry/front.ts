import type { Slot } from "../palette.ts";
import { detPow } from "./det-math.ts";
import { emitLettering, type FrontLettering, stripeOutside } from "./lettering.ts";
import { loftScale, type NoseLoft } from "./loft.ts";
import { add, cross, MeshBuilder, normalize, scale, sub, type Vec3 } from "./mesh.ts";
import { emitPanes, type Facets, facetSurface, screenPaneWidth } from "./panes.ts";
import type { Ring, SectionPoint } from "./profile.ts";
import { emitGrid } from "./surface.ts";

/**
 * A cab front in the car frame: heights above top of rail, setbacks backwards from the tip,
 * widths as fractions of the local half width of the body section.
 */
export interface FrontSpec {
  readonly length: number;
  readonly tipZ: number;
  readonly faceTop: number;
  /** Lowest edge of the front ahead of the leading wheels; null takes the body's low bottom. */
  readonly bottom: number | null;
  /** Setback at the lowest edge of the front. */
  readonly bottomSetback: number;
  readonly screenBottom: number;
  readonly screenTop: number;
  readonly screenBottomSetback: number;
  readonly screenTopSetback: number;
  readonly screenWidth: number;
  /** Plan shape: forward reach falls as (1 - |u|^a)^(1/b) towards the side. */
  readonly plan: readonly [number, number];
  /** Length of straight cab side before the plan rounding starts. */
  readonly straight: number;
  readonly mask: { readonly bottom: number; readonly top: number; readonly width: number } | null;
  readonly lamps: {
    readonly bottom: number;
    readonly top: number;
    readonly inner: number;
    readonly outer: number;
  } | null;
  readonly skirtTop: number | null;
  /** Stripe on the front: round it at one height, along the sides only, diving to the front band, or none. */
  readonly stripe: "across" | "sides" | "dive" | "none";
  /** Band of the stripe across the middle of the front when it differs from the side band. */
  readonly frontStripe: { readonly bottom: number; readonly top: number } | null;
  readonly cabWindow: boolean;
  /** Cab side window as setbacks from the tip; null paints the whole straight cab side. */
  readonly sideWindow: { readonly from: number; readonly to: number } | null;
  /** Distance from the tip to the rear end of the cab, where passenger windows may start. */
  readonly cabLength: number;
  /** Sections that narrow towards the tip; absent keeps the plan width at every height. */
  readonly loft?: NoseLoft | null;
  /** How far the middle of the face between tip and face top bulges ahead of the tip. */
  readonly faceBulge?: number;
  /** Cab window band as [setback, bottom, top] points along the side, drawn instead of the side window. */
  readonly bandCurve?: readonly (readonly [number, number, number])[] | null;
  /** The cab side window's glass drawn over the front of the band, [setback, bottom, top] points. */
  readonly cabGlassCurve?: readonly (readonly [number, number, number])[];
  /** The band starts at its curve's first setback instead of beside the windscreen (glazing that wraps into the nose). */
  readonly bandFromCurveStart?: boolean;
  /** Windscreen width per height as [height, fraction of the half width], for rounded windscreens. */
  readonly screenWidths?: readonly (readonly [number, number])[] | null;
  /** Measured centreline side profile as [setback, height] points, replacing the profile from the front's levels. */
  readonly sideProfile?: readonly (readonly [number, number])[] | null;
  /** Measured centreline as [height, setback] points closed at the roof at the front's length, replacing the knots. */
  readonly profileByHeight?: readonly (readonly [number, number])[] | null;
  /** Measured plan as [setback, fraction of the half width] points: the same outline at every height, set back with the profile. */
  readonly planWidths?: readonly (readonly [number, number])[] | null;
  /** Distance from the end of the car over couplers back to the nose tip, when it differs from the forge's gap. */
  readonly tipGap?: number;
  /** Measured stripe along the nose side as [setback, bottom, top] points, drawn instead of the dive. */
  readonly stripeCurve?: readonly (readonly [number, number, number])[] | null;
  /** Lettering along both sides of the nose at full detail, with the measured stripe left out behind it. */
  readonly lettering?: FrontLettering | null;
  /** The cab side up to the cab's rear end keeps the body colour between sill and window top. */
  readonly plainCabSide?: boolean;
  /** Dark coupler recess or chin under the face, drawn in the mask colour. */
  readonly chin?: { readonly bottom: number; readonly top: number; readonly width: number } | null;
  /** Lobes of the lower nose that reach ahead of a recessed middle, at full detail. */
  readonly cheeks?: NoseCheeks | null;
  /** At full detail the windscreen is a pane just off the nose whose outline rounds with this superellipse exponent. */
  readonly screenRound?: number | null;
  /** The pane windscreen and its frame are laid out in columns from the outline's bottom to its top, for a screen wrapped over a dome. */
  readonly screenColumns?: boolean;
  /** The pane glass is grey-blue with a lighter upper part instead of near black. */
  readonly lightGlass?: boolean;
  /** Panes just off the front at full detail: lamps, grilles, logos and dark fields. */
  readonly decals?: readonly FrontDecal[] | null;
  /** Heights of the cab side window when they differ from the passenger window band. */
  readonly sideWindowBand?: { readonly bottom: number; readonly top: number } | null;
  /** How far the front edge of the cab side window rounds back towards its top and bottom, metres. */
  readonly sideWindowRound?: number;
  /** How far the front edge of the cab side window leans back per metre of height. */
  readonly sideWindowRake?: number;
  /** Paint of the mask round the windscreen: dark, or the neutral grey of a light helmet. */
  readonly maskSlot?: "mask" | "equipment";
  /** Side buffers and a screw coupler on the buffer beam, drawn at full detail. */
  readonly buffers?: boolean;
  /** False when the windscreen is drawn as a pane, so the lid under it keeps the body paint. */
  readonly paintScreen?: boolean;
}

/**
 * A pane on the front surface between two heights and two lateral fractions, mirrored on both
 * sides when inner is above 0 and centred from -outer to outer otherwise.
 */
export interface FrontDecal {
  readonly slot: Slot;
  readonly bottom: number;
  readonly top: number;
  readonly inner: number;
  readonly outer: number;
  /** Superellipse exponent of the outline: 2 is an ellipse, higher is squarer. */
  readonly round: number;
  /** Lateral shift of the top edge against the bottom edge, as a fraction (positive outwards). */
  readonly slant: number;
  /** Drawn under the windscreen pane, as a mask round it. */
  readonly under?: boolean;
  /** Degrees the decal's long axis is turned, its outer end rising; it turns about `pivot` or its own centre. */
  readonly tilt?: number;
  /** Centre of the turn as a lateral fraction and a height, for parts of a turned decal. */
  readonly pivot?: { readonly u: number; readonly z: number };
  /** A lamp's share given to a red tail lens: 0 none, 1 the whole lens, absent for the forge's rule. */
  readonly tail?: number;
  /** The red lens sits on the inner side of the lamp. */
  readonly tailInner?: boolean;
  /** The red lens sits below a white one, both round, instead of beside it. */
  readonly tailBelow?: boolean;
  /** The white lenses themselves show red at the trailing end (`COMBINED_TAIL_U`). */
  readonly combinedTail?: boolean;
  /** The lenses fill the lamp housing as one cluster instead of round lenses. */
  readonly fill?: boolean;
  /** Metres between a cluster lamp's housing and its lenses, absent for the forge's margin. */
  readonly lensMargin?: number;
  /** The decal is the DB logo plate: its slot paints the border and the letters, `logo` the field. */
  readonly logo?: boolean;
  /** The plate's border and letters are red (`logo`) on a field in its slot: the logo on a light body. */
  readonly redLetters?: boolean;
  /** The inner or outer lens of a pair is a clear unlit lens (`glass`), the other one the lit lamp. */
  readonly clearLens?: "inner" | "outer";
  /** A panel joint drawn just off the skin (`SEAM_LIFT`) under every other pane, so it never stands out of the outline. */
  readonly seam?: boolean;
  /** Explicit signed lateral range [from, to] as fractions, a single unmirrored pane (set by the forge for logo parts). */
  readonly span?: readonly [number, number];
}

/** Windscreen width at height z: the measured outline when there is one, else the single width. */
export function screenWidthAt(front: FrontSpec, z: number): number {
  const w = front.screenWidths;
  if (!w || w.length < 2) return front.screenWidth;
  const sorted = [...w].sort((a, b) => a[0] - b[0]);
  const first = sorted[0] as readonly [number, number];
  const last = sorted[sorted.length - 1] as readonly [number, number];
  if (z <= first[0]) return first[1];
  if (z >= last[0]) return last[1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [z0, w0] = sorted[i] as readonly [number, number];
    const [z1, w1] = sorted[i + 1] as readonly [number, number];
    if (z <= z1) return w0 + ((w1 - w0) * (z - z0)) / Math.max(1e-6, z1 - z0);
  }
  return last[1];
}

type Detail = "full" | "band" | "screen";

/** The front below the body bottom ahead of the leading wheels, from x = start to the tip. */
export interface Apron {
  readonly bottom: number;
  readonly start: number;
}

/** Body heights the front paints against. */
export interface FrontBands {
  readonly bottom: number;
  readonly height: number;
  readonly sill: number;
  readonly top: number;
  readonly stripeBottom: number;
  readonly stripeTop: number;
  /** Top of the straight side wall, where the roof begins. */
  readonly eave: number;
  /** Lowest height of the roof band that carries the colour mode. */
  readonly bandZ: number;
  /** The window band continues on the nose sides: passenger cars whose cab side window is not bounded. */
  readonly windowBand: boolean;
}

export const PLAN_EXPONENTS = {
  pointed: [1.9, 1.35],
  round: [2.6, 2.0],
  flat: [6.0, 2.4],
} as const;

const EPS = 1e-6;

/** Dark housing drawn round each lamp, metres of height and fractions of the half width. */
const POD = { below: 0.08, above: 0.06, inner: 0.05, outer: 0.04 } as const;

/**
 * Share of a painted class lamp, from its outer end, that is the red tail lens: the end of a train
 * shows two red lights paired left and right low on the last vehicle (Zg 2, Wikipedia de
 * Zugschlusssignal), on the outer side as the forge's rule for lamp strips.
 */
export const PAINTED_TAIL_SHARE = 0.3;

/** Lateral fraction where a painted lamp's red tail lens begins. */
export function paintedTailFrom(lamps: NonNullable<FrontSpec["lamps"]>): number {
  return lamps.outer - PAINTED_TAIL_SHARE * (lamps.outer - lamps.inner);
}

/** Lamps drawn as decals; the front then paints none of its own. */
function hasLampDecals(front: FrontSpec): boolean {
  return (front.decals ?? []).some((d) => d.slot === "light");
}

/** The lamp housing: the lamp rectangle grown by the pod margins. */
export function lampPod(lamps: NonNullable<FrontSpec["lamps"]>) {
  return {
    bottom: lamps.bottom - POD.below,
    top: lamps.top + POD.above,
    inner: Math.max(0, lamps.inner - POD.inner),
    outer: Math.min(0.99, lamps.outer + POD.outer),
  };
}

/** Fritsch-Carlson monotone cubic through strictly increasing xs. */
export function monotoneCubic(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length;
  const d = xs
    .slice(0, -1)
    .map((x, i) => ((ys[i + 1] as number) - (ys[i] as number)) / ((xs[i + 1] as number) - x));
  const m = xs.map((_, i) => {
    if (i === 0) return d[0] as number;
    if (i === n - 1) return d[n - 2] as number;
    const a = d[i - 1] as number;
    const b = d[i] as number;
    return a * b <= 0 ? 0 : (a + b) / 2;
  });
  for (let i = 0; i < n - 1; i++) {
    const di = d[i] as number;
    if (Math.abs(di) < EPS) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] as number) / di;
    const b = (m[i + 1] as number) / di;
    const r = a * a + b * b;
    if (r > 9) {
      const t = 3 / Math.sqrt(r);
      m[i] = t * a * di;
      m[i + 1] = t * b * di;
    }
  }
  return (x: number) => {
    if (x <= (xs[0] as number)) return ys[0] as number;
    if (x >= (xs[n - 1] as number)) return ys[n - 1] as number;
    let i = 0;
    while (x > (xs[i + 1] as number)) i++;
    const h = (xs[i + 1] as number) - (xs[i] as number);
    const t = (x - (xs[i] as number)) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * (ys[i] as number) +
      (t3 - 2 * t2 + t) * h * (m[i] as number) +
      (-2 * t3 + 3 * t2) * (ys[i + 1] as number) +
      (t3 - t2) * h * (m[i + 1] as number)
    );
  };
}

export interface NoseCheeks {
  readonly bottom: number;
  readonly top: number;
  readonly inner: number;
  readonly outer: number;
  readonly reach: number;
  readonly recess: number;
}

/**
 * Forward offset of the lid at lateral fraction u and height z from the nose cheeks: a rounded
 * lobe between inner and outer, the middle drawn back, both fading to zero at the cheeks' edges.
 */
export function cheekOffset(cheeks: NoseCheeks, u: number, z: number): number {
  const t = (z - cheeks.bottom) / (cheeks.top - cheeks.bottom);
  if (t <= 0 || t >= 1) return 0;
  const height = Math.sin(Math.PI * t);
  const a = Math.min(1, Math.abs(u));
  if (a >= cheeks.outer) return 0;
  if (a >= cheeks.inner) {
    const s = (a - cheeks.inner) / (cheeks.outer - cheeks.inner);
    return cheeks.reach * height * Math.sin(Math.PI * s);
  }
  const m = a / cheeks.inner;
  return -cheeks.recess * height * (1 - m * m);
}

/** Setback from the tip as a function of height: the front's side profile. */
export function setbackProfile(
  front: FrontSpec,
  bottom: number,
  height: number,
): (z: number) => number {
  /* bottom is the lowest edge of the front: the apron's when there is one. */
  const raw = measuredPoints(front, height) ?? knots(front, bottom, height);
  const points = raw
    .map(([z, s]) => [Math.min(height, Math.max(bottom, z)), Math.min(front.length, s)] as const)
    .sort((a, b) => a[0] - b[0])
    .filter((p, i, all) => i === 0 || p[0] > (all[i - 1] as readonly [number, number])[0] + 0.02);
  return monotoneCubic(
    points.map((p) => p[0]),
    points.map((p) => p[1]),
  );
}

/** A measured profile as [height, setback] points: the side profile as given, or the profile by height closed at the roof. */
function measuredPoints(front: FrontSpec, height: number): [number, number][] | null {
  if (front.sideProfile && front.sideProfile.length >= 2)
    return front.sideProfile.map(([s, z]) => [z, s] as [number, number]);
  const byHeight = front.profileByHeight;
  if (!byHeight || byHeight.length < 3) return null;
  return [
    ...byHeight.filter(([z]) => z < height - 0.02).map(([z, s]) => [z, s] as [number, number]),
    [height, front.length],
  ];
}

/** The side profile's knots from the front's tip, face and windscreen heights and setbacks. */
function knots(front: FrontSpec, bottom: number, height: number): [number, number][] {
  return [
    [bottom, front.bottomSetback],
    [front.tipZ, 0],
    ...(front.faceBulge
      ? [[(front.tipZ + front.faceTop) / 2, -front.faceBulge] as [number, number]]
      : []),
    [front.faceTop, 0],
    [front.screenBottom, front.screenBottomSetback],
    [front.screenTop, front.screenTopSetback],
    [height, front.length],
  ];
}

export function planReach(u: number, plan: readonly [number, number]): number {
  const a = Math.min(1, Math.abs(u));
  return detPow(Math.max(0, 1 - detPow(a, plan[0])), 1 / plan[1]);
}

/** The front's plan: forward reach at a lateral fraction (0 at the side, 1 at the centre), its inverse, and the measured plan length. */
export interface PlanShape {
  readonly reach: (u: number) => number;
  readonly fraction: (r: number) => number;
  readonly span: number | null;
}

/** The plan of a front: the measured outline when there is one, else the superellipse of its exponents. */
export function planShape(front: FrontSpec): PlanShape {
  const w = front.planWidths;
  if (!w || w.length < 2) {
    const [a, b] = front.plan;
    return {
      reach: (u) => planReach(u, front.plan),
      fraction: (r) => detPow(Math.max(0, 1 - detPow(Math.min(1, Math.max(0, r)), b)), 1 / a),
      span: null,
    };
  }
  const sorted = [...w].sort((p, q) => p[0] - q[0]);
  const points: (readonly [number, number])[] = sorted[0]?.[0] === 0 ? sorted : [[0, 0], ...sorted];
  const span = (points[points.length - 1] as readonly [number, number])[0];
  const setbacks = points.map(([s]) => s);
  const fractions = points.map(([, f]) => f);
  const setbackAt = monotoneCubic(fractions, setbacks);
  const reach = (u: number) => 1 - setbackAt(Math.min(1, Math.abs(u))) / span;
  const fraction = (r: number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (reach(mid) > r) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return { reach, fraction, span };
}

/** Heights of a measured profile by height below the tip, where the lower nose needs its own rows. */
function lowerProfileLevels(front: FrontSpec): number[] {
  return (front.profileByHeight ?? []).map(([z]) => z).filter((z) => z < front.tipZ);
}

/** Extra rows of a shaped front: the windscreen outline, and the face and chin of a lofted nose. */
function shapeLevels(front: FrontSpec, detail: "full" | "band"): number[] {
  const screen = detail === "full" ? (front.screenWidths ?? []).map(([z]) => z) : [];
  const out = screen.filter((z) => z > front.screenBottom && z < front.screenTop);
  if (front.chin) out.push(front.chin.bottom, front.chin.top);
  if (front.sideProfile && front.sideProfile.length >= 2) {
    const heights = front.sideProfile.map(([, z]) => z).sort((a, b) => a - b);
    out.push(...(detail === "full" ? heights : heights.filter((_, i) => i % 8 === 4)));
  }
  if (detail === "full") out.push(...lowerProfileLevels(front));
  if (front.loft) {
    const low = front.bottom ?? front.tipZ - 0.4;
    for (const t of detail === "full" ? [0.25, 0.5, 0.75] : [0.5])
      out.push(front.tipZ + t * (front.faceTop - front.tipZ), low + t * (front.tipZ - low));
  }
  return out;
}

/** Heights the body ring must carry so that every edge of the front's paint lies on a row. */
export function frontLevels(front: FrontSpec, detail: "full" | "band" | "screen"): number[] {
  const levels = [front.screenBottom, front.screenTop];
  if (detail === "screen") return levels;
  levels.push(front.tipZ, front.faceTop, ...shapeLevels(front, detail));
  if (front.mask) levels.push(front.mask.bottom, front.mask.top);
  if (front.skirtTop !== null) levels.push(front.skirtTop);
  if (front.frontStripe) levels.push(front.frontStripe.bottom, front.frontStripe.top);
  if (detail === "full" && front.lamps) {
    const pod = lampPod(front.lamps);
    levels.push(front.lamps.bottom, front.lamps.top, pod.bottom, pod.top);
  }
  return levels;
}

/** Lateral fractions of the front's columns from the centre to the side, both included. */
export function frontColumns(front: FrontSpec, detail: "full" | "band" | "screen"): number[] {
  const base =
    detail === "full"
      ? [0, 0.35, 0.6, 0.8, 0.92, 0.98, 1]
      : detail === "band"
        ? [0, 0.5, 0.82, 1]
        : [0, 1];
  const extra = [
    front.screenWidth,
    ...(detail === "full" ? (front.screenWidths ?? []).map(([, w]) => w) : []),
  ];
  if (detail !== "screen" && front.mask) extra.push(front.mask.width);
  if (detail !== "screen" && front.chin) extra.push(front.chin.width);
  if (detail === "full" && front.lamps) {
    const pod = lampPod(front.lamps);
    extra.push(front.lamps.inner, front.lamps.outer, pod.inner, pod.outer);
    if (!hasLampDecals(front)) extra.push(paintedTailFrom(front.lamps));
  }
  if (detail === "full" && front.cheeks) {
    const { inner, outer } = front.cheeks;
    extra.push(
      inner / 2,
      inner,
      inner + (outer - inner) / 3,
      inner + (2 * (outer - inner)) / 3,
      outer,
    );
  }
  return [...new Set([...base, ...extra].map((u) => Math.round(u * 1e4) / 1e4))]
    .filter((u) => u >= 0 && u <= 1)
    .sort((a, b) => a - b);
}

interface FaceSpan {
  readonly z0: number;
  readonly z1: number;
  readonly u0: number;
  readonly u1: number;
}

function spans(f: FaceSpan, lo: number, hi: number): boolean {
  return f.z0 >= lo - EPS && f.z1 <= hi + EPS;
}

/** A painted lamp's lens (white, its outer share red) or its dark housing, null elsewhere. */
function lampSlot(lamps: NonNullable<FrontSpec["lamps"]>, f: FaceSpan): Slot | null {
  if (spans(f, lamps.bottom, lamps.top)) {
    if (f.u0 >= lamps.inner - EPS && f.u1 <= lamps.outer + EPS)
      return f.u0 >= paintedTailFrom(lamps) - EPS ? "tail" : "light";
  }
  const pod = lampPod(lamps);
  if (spans(f, pod.bottom, pod.top) && f.u0 >= pod.inner - EPS && f.u1 <= pod.outer + EPS)
    return "mask";
  return null;
}

/** Lamps, windscreen and mask: the parts of the front that sit on top of the body paint. */
function glazingSlot(front: FrontSpec, f: FaceSpan): Slot | null {
  const { lamps, mask } = front;
  const lamp = lamps ? lampSlot(lamps, f) : null;
  if (lamp) return lamp;
  if (
    front.paintScreen !== false &&
    spans(f, front.screenBottom, front.screenTop) &&
    f.u1 <= screenWidthAt(front, (f.z0 + f.z1) / 2) + EPS
  )
    return "window";
  const within = (field: { bottom: number; top: number; width: number } | null | undefined) =>
    !!field && spans(f, field.bottom, field.top) && f.u1 <= field.width + EPS;
  if (within(front.chin)) return "mask";
  return within(mask) ? (front.maskSlot ?? "mask") : null;
}

/** The stripe band a face of the lid can carry: the side band outside the windscreen width. */
function stripeBand(front: FrontSpec, bands: FrontBands, outside: boolean) {
  if (front.stripe === "none") return null;
  const side = { bottom: bands.stripeBottom, top: bands.stripeTop };
  if (outside) return side;
  return front.frontStripe ?? (front.stripe === "across" ? side : null);
}

function paintSlot(front: FrontSpec, bands: FrontBands, f: FaceSpan): Slot {
  if (f.z0 >= bands.eave - EPS) return "roof";
  if (front.skirtTop !== null && f.z1 <= front.skirtTop + EPS) return "skirt";
  const outside = f.u0 >= front.screenWidth - EPS;
  const stripe = stripeBand(front, bands, outside);
  if (stripe && spans(f, stripe.bottom, stripe.top)) return "stripe";
  if (bands.windowBand && outside && spans(f, bands.sill, bands.top)) return "window_band";
  return f.z0 >= bands.sill - EPS ? "upper_body" : "lower_body";
}

/** Paint of one face of the front lid, from the face's height and lateral span. */
export function lidSlot(front: FrontSpec, bands: FrontBands, f: FaceSpan): Slot {
  return glazingSlot(front, f) ?? paintSlot(front, bands, f);
}

/**
 * Paint of the straight cab side between the body and the front's rounding; `glazed` is false
 * outside the measured side window.
 */
export function sideSlot(
  front: FrontSpec,
  bands: FrontBands,
  z0: number,
  z1: number,
  glazed = front.cabWindow,
): Slot {
  const within = (lo: number, hi: number) => z0 >= lo - EPS && z1 <= hi + EPS;
  if (z0 >= bands.bandZ - EPS) return "mode";
  if (z0 >= bands.eave - EPS) return "roof";
  if (within(bands.sill, bands.top)) {
    if (glazed) return "window";
    if (bands.windowBand) return "window_band";
  }
  if (front.skirtTop !== null && z1 <= front.skirtTop + EPS) return "skirt";
  if (front.stripe !== "none" && within(bands.stripeBottom, bands.stripeTop)) return "stripe";
  return z0 >= bands.sill - EPS ? "upper_body" : "lower_body";
}

/** Stations along the straight cab side at one height: the base, the side window edges, its end. */
function sideStations(
  length: number,
  straight: number,
  window: FrontSpec["sideWindow"],
  lofted = false,
): number[] {
  if (lofted) return [0, 0.25, 0.5, 0.75, 1].map((t) => t * straight);
  if (!window) return [0, straight];
  const clamp = (x: number) => Math.min(straight, Math.max(0, x));
  return [0, clamp(length - window.to), clamp(length - window.from), straight];
}

/**
 * The front from the body section at x = 0 forwards to the tip at x = length: straight cab
 * sides, a lid over the whole section shaped by the side profile and the plan, and the floor
 * under it. `ring` is the section with every front level on it.
 */
export function buildFront(
  front: FrontSpec,
  bands: FrontBands,
  ring: Ring,
  detail: "full" | "band" | "screen",
  apron: Apron | null = null,
): MeshBuilder {
  const mesh = new MeshBuilder();
  const paint = paintedFront(front, detail);
  const lowest = apron ? apron.bottom : bands.bottom;
  const setback = setbackProfile(front, lowest, bands.height);
  const reach = (z: number) => front.length - setback(z);
  const plan = planShape(front);
  const straight = (z: number) =>
    plan.span === null ? Math.min(front.straight, reach(z)) : Math.max(0, reach(z) - plan.span);
  const cheeks = detail === "full" ? (front.cheeks ?? null) : null;
  const x = (u: number, z: number) => {
    const k = straight(z);
    const base = k + (reach(z) - k) * plan.reach(u);
    return cheeks ? base + cheekOffset(cheeks, u, z) : base;
  };
  const scale = (px: number, z: number) => loftScale(front.loft, px / front.length, z);
  const half = ring.points.slice(0, ring.leftEdge + 1) as SectionPoint[];

  const window = detail === "screen" ? null : front.sideWindow;
  const loftedSide = !!front.loft && detail === "full";
  const stations = (z: number) => sideStations(front.length, straight(z), window, loftedSide);
  const sideRows = stations(0).map((_, i) =>
    ring.points.map((q) => {
      const st = stations(q.z)[i] as number;
      return [st, q.y * scale(st, q.z), q.z] as Vec3;
    }),
  );
  const count = ring.points.length;
  const sidePaint = sidePainted(front, detail);
  emitGrid(mesh, { rows: sideRows, closed: true, creaseColumns: ring.creases }, (r, c) => {
    const a = ring.points[c] as SectionPoint;
    const b = ring.points[(c + 1) % count] as SectionPoint;
    if (Math.abs(a.z - b.z) < EPS && Math.abs(a.z - bands.bottom) < EPS) return null;
    const st = stations(bands.sill);
    const within =
      window !== null &&
      (st[r] as number) >= front.length - window.to - EPS &&
      (st[r + 1] as number) <= front.length - window.from + EPS;
    const glazed =
      front.cabWindow &&
      !front.sideWindowBand &&
      (window === null || (loftedSide ? within : r === 1));
    return sideSlot(sidePaint, bands, Math.min(a.z, b.z), Math.max(a.z, b.z), glazed);
  });

  const fractions = frontColumns(front, detail);
  const us = [
    ...fractions
      .slice(1)
      .reverse()
      .map((u) => -u),
    ...fractions,
  ];
  const rows = half.map((q) =>
    us.map((u) => [x(u, q.z), u * scale(x(u, q.z), q.z) * q.y, q.z] as Vec3),
  );
  const screenRow = half.findIndex((q) => Math.abs(q.z - front.screenBottom) < EPS);
  const flat = front.plan[0] >= 4;
  emitGrid(
    mesh,
    {
      rows,
      closed: false,
      ...(flat && screenRow > 0 ? { creaseRows: new Set([screenRow]) } : {}),
    },
    (r, c) => {
      const z1 = (half[r] as SectionPoint).z;
      const z0 = (half[r + 1] as SectionPoint).z;
      const a = Math.abs(us[c] as number);
      const b = Math.abs(us[c + 1] as number);
      return lidSlot(paint, bands, { z0, z1, u0: Math.min(a, b), u1: Math.max(a, b) });
    },
  );

  const edge = half[half.length - 1] as SectionPoint;
  const floorEnd = (u: number) => Math.min(apron ? apron.start : Infinity, x(u, edge.z));
  for (let c = 0; c < us.length - 1; c++) {
    const u0 = us[c] as number;
    const u1 = us[c + 1] as number;
    mesh.quad(
      [0, u0 * edge.y, edge.z],
      [0, u1 * edge.y, edge.z],
      [floorEnd(u1), u1 * scale(floorEnd(u1), edge.z) * edge.y, edge.z],
      [floorEnd(u0), u0 * scale(floorEnd(u0), edge.z) * edge.y, edge.z],
      "underframe",
    );
  }
  if (apron) emitApron(mesh, { front: paint, bands, apron, us, edge, x, scale, detail });
  let facets: Facets | null = null;
  if (detail === "full") {
    const apronZs = apron ? apronLevels(paint, edge.z, apron.bottom, detail).slice(1) : [];
    const apronRows = apronZs.map((z) =>
      us.map((u) => {
        const px = Math.max((apron as Apron).start, x(u, z));
        return [px, u * scale(px, z) * edge.y, z] as Vec3;
      }),
    );
    const levels = [...half.map((q) => q.z), ...apronZs];
    const inside: Vec3 = [-2, 0, (bands.bottom + bands.height) / 2];
    facets = facetSurface(levels, [...rows, ...apronRows], us, inside);
    emitPanes(mesh, front, facets, apronFloor(x, apron, edge.z));
    if (front.buffers) emitBuffers(mesh, facets);
  }
  emitOverlays(mesh, {
    front,
    bands,
    detail,
    window,
    facets,
    surface: lidSurface(half, edge, x, scale, apron),
    x,
    straight,
    setback,
    scale,
    wall: Math.max(...ring.points.map((p) => Math.abs(p.y))),
  });
  return mesh;
}

/** The front as its straight sides are painted: no band there when a measured stripe curve is drawn. */
function sidePainted(front: FrontSpec, detail: Detail): FrontSpec {
  return front.stripeCurve && detail !== "screen" ? { ...front, stripe: "none" } : front;
}

/**
 * Lowest height of the visible front at lateral fraction u when an apron hangs under the body:
 * below it the lid reaches no further forward than the apron's cut, so it is hidden.
 */
export function apronFloor(
  x: (u: number, z: number) => number,
  apron: Apron | null,
  top: number,
): ((u: number) => number) | undefined {
  if (!apron) return undefined;
  return (u) => {
    if (x(u, top) <= apron.start + EPS) return top;
    if (x(u, apron.bottom) > apron.start + EPS) return apron.bottom;
    let lo = apron.bottom;
    let hi = top;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (x(u, mid) > apron.start + EPS) hi = mid;
      else lo = mid;
    }
    return hi;
  };
}

/** Heights of the apron's rows from the body bottom down to the apron bottom. */
function apronLevels(front: FrontSpec, top: number, bottom: number, detail: Detail): number[] {
  const inside = detail === "screen" ? [] : frontLevels(front, detail);
  const between = inside.filter((z) => z < top - 0.005 && z > bottom + 0.005);
  return [top, ...[...new Set(between)].sort((a, b) => b - a), bottom];
}

interface ApronContext {
  readonly front: FrontSpec;
  readonly bands: FrontBands;
  readonly apron: Apron;
  readonly us: readonly number[];
  readonly edge: SectionPoint;
  readonly x: (u: number, z: number) => number;
  readonly scale: (x: number, z: number) => number;
  readonly detail: Detail;
}

/**
 * The front below the body bottom, ahead of the leading wheels: the lid continued down to the
 * apron bottom, cut at x = start by a wall facing the bogie, with side walls and a floor.
 */
function emitApron(mesh: MeshBuilder, ctx: ApronContext) {
  const { front, bands, apron, us, edge, x, scale } = ctx;
  const levels = apronLevels(front, edge.z, apron.bottom, ctx.detail);
  const px = (u: number, z: number) => Math.max(apron.start, x(u, z));
  const rows = levels.map((z) =>
    us.map((u) => [px(u, z), u * scale(px(u, z), z) * edge.y, z] as Vec3),
  );
  emitGrid(mesh, { rows, closed: false }, (r, c) => {
    const z1 = levels[r] as number;
    const z0 = levels[r + 1] as number;
    const u0 = us[c] as number;
    const u1 = us[c + 1] as number;
    const reach = Math.max(x(u0, z0), x(u1, z0), x(u0, z1), x(u1, z1));
    if (reach <= apron.start + EPS) return null;
    const [a, b] = [Math.abs(u0), Math.abs(u1)];
    return lidSlot(front, bands, { z0, z1, u0: Math.min(a, b), u1: Math.max(a, b) });
  });
  const y = edge.y;
  const at = (px0: number, z: number) => y * scale(px0, z);
  for (let r = 0; r < levels.length - 1; r++) {
    const z1 = levels[r] as number;
    const z0 = levels[r + 1] as number;
    const slot = sideSlot(front, bands, z0, z1, false);
    for (const side of [1, -1]) {
      const wall: [Vec3, Vec3, Vec3, Vec3] = [
        [apron.start, side * at(apron.start, z0), z0],
        [px(side, z0), side * at(px(side, z0), z0), z0],
        [px(side, z1), side * at(px(side, z1), z1), z1],
        [apron.start, side * at(apron.start, z1), z1],
      ];
      mesh.facingQuad(wall, [0, side, 0], slot);
    }
  }
  const top = edge.z;
  const bottom = apron.bottom;
  mesh.facingQuad(
    [
      [apron.start, -at(apron.start, bottom), bottom],
      [apron.start, at(apron.start, bottom), bottom],
      [apron.start, at(apron.start, top), top],
      [apron.start, -at(apron.start, top), top],
    ],
    [-1, 0, 0],
    "underframe",
  );
  for (let c = 0; c < us.length - 1; c++) {
    const u0 = us[c] as number;
    const u1 = us[c + 1] as number;
    const floor: [Vec3, Vec3, Vec3, Vec3] = [
      [apron.start, u0 * at(apron.start, bottom), bottom],
      [apron.start, u1 * at(apron.start, bottom), bottom],
      [px(u1, bottom), u1 * at(px(u1, bottom), bottom), bottom],
      [px(u0, bottom), u0 * at(px(u0, bottom), bottom), bottom],
    ];
    mesh.facingQuad(floor, [0, 0, -1], "underframe");
  }
}

/**
 * The front as its lid and apron are painted: a diving stripe and a pane windscreen are drawn off
 * the surface instead, and lamps are painted only at full detail, where their edges are rows.
 */
function paintedFront(front: FrontSpec, detail: Detail): FrontSpec {
  const full = detail === "full";
  const lampDecals = full && hasLampDecals(front);
  const paned: FrontSpec = {
    ...front,
    ...(full && front.screenRound ? { paintScreen: false } : {}),
    ...(lampDecals || !full ? { lamps: null } : {}),
  };
  if (front.stripe !== "dive") return paned;
  const ribbon = detail !== "screen" && front.frontStripe !== null;
  return { ...paned, stripe: ribbon ? "none" : "sides", frontStripe: null };
}

interface OverlayContext {
  readonly front: FrontSpec;
  readonly bands: FrontBands;
  readonly detail: Detail;
  readonly window: FrontSpec["sideWindow"];
  readonly surface: Surface;
  readonly x: (u: number, z: number) => number;
  readonly straight: (z: number) => number;
  readonly setback: (z: number) => number;
  readonly scale: (x: number, z: number) => number;
  /** The emitted lid at full detail, so overlays can lie on its triangles. */
  readonly facets?: Facets | null;
  /** Half width of the car's flat side behind the nose, where the body draws its facade. */
  readonly wall: number;
}

/** The measured stripe, cut where lettering at full detail leaves a gap for it. */
function stripePieces(
  curve: readonly (readonly [number, number, number])[],
  detail: Detail,
  lettering: FrontSpec["lettering"],
) {
  const gap = detail === "full" ? lettering?.stripeGap : null;
  return gap ? stripeOutside(curve, gap) : [curve];
}

/** The stripe down the nose side: the measured curve, cut behind lettering at full detail, or the dive. */
function emitSideStripe(mesh: MeshBuilder, ctx: OverlayContext, side: SidePoint) {
  const { front, bands, detail } = ctx;
  if (front.stripeCurve && front.stripeCurve.length >= 2 && detail !== "screen") {
    for (const piece of stripePieces(front.stripeCurve, detail, front.lettering))
      emitBandCurve(mesh, piece, side, () => 0, {
        steps: detail === "full" ? 4 : 1,
        rows: 1,
        lift: RIBBON_LIFT + 0.01,
        slot: "stripe",
      });
  } else if (front.stripe === "dive" && detail !== "screen" && front.frontStripe) {
    emitDive(mesh, front, bands, ctx.surface, detail === "full" ? DIVE_US : DIVE_US_COARSE);
  }
}

/**
 * Lettering along both sides of the nose, at full detail only. On a lofted front, letters behind
 * the nose lie on the flat facade the body draws there, not on the loft's joint ring.
 */
function emitSideLettering(mesh: MeshBuilder, ctx: OverlayContext, side: SidePoint) {
  const { front, wall } = ctx;
  const lettering = front.lettering;
  if (!lettering || ctx.detail !== "full") return;
  const on = (s: 1 | -1, setback: number, z: number): Vec3 =>
    front.loft && setback > front.length
      ? [front.length - setback, s * (wall + LETTER_LIFT), z]
      : liftedPoint(side, s, LETTER_LIFT)(setback, z);
  emitLettering(mesh, lettering, on, "equipment");
}

/** Parts drawn just off the front surface: the diving stripe and the cab side window. */
function emitOverlays(mesh: MeshBuilder, ctx: OverlayContext) {
  const { front, bands, detail, window, x } = ctx;
  const side = sideSurface(front, ctx.surface, ctx.straight, ctx.setback, ctx.scale);
  emitSideStripe(mesh, ctx, side);
  emitSideLettering(mesh, ctx, side);
  if (front.bandCurve && front.bandCurve.length >= 2 && detail !== "screen") {
    emitCabBands(mesh, ctx, front.bandCurve, side);
    return;
  }
  if (!window || !front.cabWindow) return;
  const clear = Math.min(1, front.screenWidth + 0.1);
  const limit = (z: number) => {
    const pane = screenPaneWidth(front, z);
    const paned = front.screenRound && detail === "full";
    return front.length - x(paned ? Math.min(1, pane + 0.04) : clear, z);
  };
  emitSideWindow(mesh, front, window, bands, side, limit, detail === "full" ? 10 : 3);
}

/** The cab window band and, when measured, the cab glass over its front. */
function emitCabBands(
  mesh: MeshBuilder,
  ctx: OverlayContext,
  curve: readonly (readonly [number, number, number])[],
  side: SidePoint,
) {
  emitCabBand(mesh, ctx, curve, side);
  const glass = ctx.front.cabGlassCurve;
  if (glass && glass.length >= 2) emitCabBand(mesh, ctx, glass, side, true);
}

/** The cab window band, on the emitted facets at full detail and lifted off the analytic nose otherwise. */
function emitCabBand(
  mesh: MeshBuilder,
  ctx: OverlayContext,
  curve: readonly (readonly [number, number, number])[],
  side: SidePoint,
  glass = false,
) {
  const { front, detail, x } = ctx;
  const clear = Math.min(1, front.screenWidth + 0.1);
  const clearance = detail === "full" ? BAND_CLEARANCE : BAND_CLEARANCE_COARSE;
  const edge = front.bandFromCurveStart
    ? () => 0
    : (z: number) => front.length - x(clear, z) + clearance;
  const onFacets = ctx.facets
    ? facetSide(front, ctx.facets, side, ctx.straight, ctx.setback)
    : null;
  emitBandCurve(mesh, curve, onFacets ?? side, edge, {
    steps: detail === "full" ? 4 : 1,
    rows: onFacets ? 4 : 1,
    lift: (onFacets ? FACET_BAND_LIFT : BAND_LIFT) + (glass ? GLASS_LIFT : 0),
    ...(glass ? { slot: "glass" as const } : {}),
  });
}

/** Lateral fractions the diving stripe is sampled at, from the side (1) to the centre (0). */
const DIVE_US = [1, 0.997, 0.99, 0.975, 0.95, 0.91, 0.86, 0.79, 0.7, 0.58, 0.44, 0.28, 0.12, 0];
const DIVE_US_COARSE = [1, 0.99, 0.95, 0.86, 0.7, 0.44, 0];
/** Distance the stripe ribbon stands off the painted surface, metres. */
const RIBBON_LIFT = 0.018;
/** Distance the lettering stands off the painted surface, as far as the stripe ribbon. */
const LETTER_LIFT = RIBBON_LIFT + 0.01;
/** Fraction of the nose length over which the stripe reaches the front band. */
const DIVE_REACH = 0.85;

type Surface = (u: number, z: number) => Vec3;

/** A point on the front at lateral fraction u and height z, on the lid or, below the body, the apron. */
function lidSurface(
  half: readonly SectionPoint[],
  edge: SectionPoint,
  x: (u: number, z: number) => number,
  scale: (x: number, z: number) => number,
  apron: Apron | null,
): Surface {
  const halfWidth = (z: number): number => {
    if (z <= edge.z) return edge.y;
    for (let i = 0; i < half.length - 1; i++) {
      const a = half[i] as SectionPoint;
      const b = half[i + 1] as SectionPoint;
      if (z <= a.z + EPS && z >= b.z - EPS) {
        const t = a.z - b.z < EPS ? 0 : (a.z - z) / (a.z - b.z);
        return a.y + t * (b.y - a.y);
      }
    }
    return 0;
  };
  return (u, z) => {
    const reach = z < edge.z && apron ? Math.max(apron.start, x(u, z)) : x(u, z);
    return [reach, u * scale(reach, z) * halfWidth(z), z];
  };
}

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * The stripe as a ribbon just off the front surface: the side band at the nose base, sweeping
 * down along the nose to the front band, which it carries across the front.
 */
function emitDive(
  mesh: MeshBuilder,
  front: FrontSpec,
  bands: FrontBands,
  surface: Surface,
  samples: readonly number[],
) {
  const target = front.frontStripe as NonNullable<FrontSpec["frontStripe"]>;
  const plan = planShape(front);
  const band = (u: number): [number, number] => {
    const t = smooth(plan.reach(u) / DIVE_REACH);
    return [
      bands.stripeBottom + t * (target.bottom - bands.stripeBottom),
      bands.stripeTop + t * (target.top - bands.stripeTop),
    ];
  };
  const lifted = (u: number, z: number): Vec3 => {
    const e = 1e-3;
    const du = sub(surface(Math.min(1, u + e), z), surface(Math.max(-1, u - e), z));
    const dz = sub(surface(u, z + e), surface(u, z - e));
    const n = normalize(cross(du, dz));
    return add(surface(u, z), scale(n, RIBBON_LIFT));
  };
  const us = [...samples.map((u) => -u), ...[...samples].reverse().slice(1)];
  const rows = us.map((u) => {
    const [b, t] = band(Math.abs(u));
    return [lifted(u, b), lifted(u, (b + t) / 2), lifted(u, t)];
  });
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i] as Vec3[];
    const b = rows[i + 1] as Vec3[];
    for (let v = 0; v < 2; v++) {
      const quad: [Vec3, Vec3, Vec3, Vec3] = [
        a[v] as Vec3,
        b[v] as Vec3,
        b[v + 1] as Vec3,
        a[v + 1] as Vec3,
      ];
      const facing = cross(sub(quad[1], quad[0]), sub(quad[3], quad[0]));
      const out = sub(quad[0], [0, 0, quad[0][2]]);
      const sign = facing[0] * out[0] + facing[1] * out[1] >= 0 ? 1 : -1;
      mesh.facingQuad(quad, scale(facing, sign), "stripe");
    }
  }
}

/** How far the top of a cab side window is set back behind its bottom, per metre of height. */
const SIDE_WINDOW_RAKE = 0.75;

type SidePoint = (setback: number, z: number, side: 1 | -1) => Vec3;

/**
 * A point on the left or right side of the front seen from the side: setback behind the tip and
 * height, on the straight cab side or, further forward, on the lid where it curves round.
 */
function sideSurface(
  front: FrontSpec,
  surface: Surface,
  straight: (z: number) => number,
  setback: (z: number) => number,
  scale: (x: number, z: number) => number,
): SidePoint {
  const plan = planShape(front);
  return (s, z, side) => {
    const x = front.length - s;
    const k = straight(z);
    const reach = front.length - setback(z);
    if (x <= k || reach - k < EPS) {
      const p = surface(side, z);
      const at = Math.min(x, p[0]);
      return [at, (p[1] * scale(at, z)) / Math.max(EPS, scale(p[0], z)), z];
    }
    const u = plan.fraction(Math.min(1, (x - k) / (reach - k)));
    return surface(side * u, z);
  };
}

/** The cab side window as a pane just off the front surface, its front edge raked back. */
/** Offset of the cab window band: clears the facets of a lofted nose, whose chords lie inside the curve. */
const BAND_LIFT = 0.05;
/** Gap between the windscreen's side edge and the front of the cab window band. */
const BAND_CLEARANCE = 0.3;
/** The same gap on a coarse nose, whose painted windscreen edge is a staircase of faces. */
const BAND_CLEARANCE_COARSE = 0.6;

function liftedPoint(point: SidePoint, side: 1 | -1, lift = RIBBON_LIFT) {
  return (s: number, z: number): Vec3 => {
    const e = 1e-3;
    const ds = sub(point(s + e, z, side), point(s - e, z, side));
    const dz = sub(point(s, z + e, side), point(s, z - e, side));
    const n = normalize(scale(cross(ds, dz), side));
    return add(point(s, z, side), scale(n, lift));
  };
}

/** Offset of the band on the emitted facets: its points lie on the triangles, so only the chords between them sag. */
const FACET_BAND_LIFT = 0.015;
/** Extra lift of the cab glass over its band, metres. */
const GLASS_LIFT = 0.006;

/**
 * A side point on the emitted lid where the nose curves round (the plan inverted to a lateral
 * fraction, then evaluated on the triangles), and on the analytic straight cab side behind it.
 */
function facetSide(
  front: FrontSpec,
  facets: Facets,
  analytic: SidePoint,
  straight: (z: number) => number,
  setback: (z: number) => number,
): SidePoint {
  const plan = planShape(front);
  return (s, z, side) => {
    const x = front.length - s;
    const k = straight(z);
    const reach = front.length - setback(z);
    if (x <= k || reach - k < EPS) return analytic(s, z, side);
    const u = plan.fraction(Math.min(1, (x - k) / (reach - k)));
    return facets(side * u, z).point;
  };
}

/** The cab window band along a measured curve of [setback, bottom, top] points, on both sides. */
function emitBandCurve(
  mesh: MeshBuilder,
  curve: readonly (readonly [number, number, number])[],
  point: SidePoint,
  edge: (z: number) => number,
  shape: {
    readonly steps: number;
    readonly rows: number;
    readonly lift: number;
    readonly slot?: Slot;
  },
) {
  const { steps, rows } = shape;
  const sorted = [...curve].sort((a, b) => a[0] - b[0]);
  const samples: (readonly [number, number, number])[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i] as readonly [number, number, number];
    const b = sorted[i + 1] as readonly [number, number, number];
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  samples.push(sorted[sorted.length - 1] as readonly [number, number, number]);
  for (const side of [1, -1] as const) {
    const lifted = liftedPoint(point, side, shape.lift);
    const at = (s: number, z: number) => lifted(Math.max(s, edge(z)), z);
    for (let i = 0; i < samples.length - 1; i++) {
      const [s0, b0, t0] = samples[i] as readonly [number, number, number];
      const [s1, b1, t1] = samples[i + 1] as readonly [number, number, number];
      for (let r = 0; r < rows; r++) {
        const lo = r / rows;
        const hi = (r + 1) / rows;
        const quad: [Vec3, Vec3, Vec3, Vec3] = [
          at(s1, b1 + (t1 - b1) * lo),
          at(s0, b0 + (t0 - b0) * lo),
          at(s0, b0 + (t0 - b0) * hi),
          at(s1, b1 + (t1 - b1) * hi),
        ];
        mesh.facingQuad(quad, [0, side, 0], shape.slot ?? "window");
      }
    }
  }
}

function emitSideWindow(
  mesh: MeshBuilder,
  front: FrontSpec,
  window: NonNullable<FrontSpec["sideWindow"]>,
  bands: FrontBands,
  point: SidePoint,
  limit: (z: number) => number,
  steps: number,
) {
  const z0 = front.sideWindowBand?.bottom ?? bands.sill;
  const z1 = front.sideWindowBand?.top ?? bands.top;
  const rear = Math.min(window.to, front.length);
  const round = front.sideWindowRound ?? 0;
  const count = round > 0 ? Math.max(2, Math.round(steps * 0.8)) : 2;
  const ts = Array.from({ length: count + 1 }, (_, k) => -Math.cos((Math.PI * k) / count));
  const zs = ts.map((t) => (z0 + z1) / 2 + (t * (z1 - z0)) / 2);
  const rounding = (z: number) => {
    const t = (2 * z - z0 - z1) / Math.max(EPS, z1 - z0);
    return round * (1 - Math.sqrt(Math.max(0, 1 - t * t)));
  };
  for (const side of [1, -1] as const) {
    const lifted = (s: number, z: number): Vec3 => {
      const e = 1e-3;
      const ds = sub(point(s + e, z, side), point(s - e, z, side));
      const dz = sub(point(s, z + e, side), point(s, z - e, side));
      const n = normalize(scale(cross(ds, dz), side));
      return add(point(s, z, side), scale(n, RIBBON_LIFT));
    };
    const rows = zs.map((z) => {
      const raked =
        window.from + (z - z0) * (front.sideWindowRake ?? SIDE_WINDOW_RAKE) + rounding(z);
      const from = Math.min(rear - 0.05, Math.max(raked, limit(z)));
      return Array.from({ length: steps + 1 }, (_, i) =>
        lifted(from + ((rear - from) * i) / steps, z),
      );
    });
    for (let r = 0; r < rows.length - 1; r++) {
      for (let i = 0; i < steps; i++) {
        const lo = rows[r] as Vec3[];
        const hi = rows[r + 1] as Vec3[];
        const quad: [Vec3, Vec3, Vec3, Vec3] = [
          lo[i] as Vec3,
          lo[i + 1] as Vec3,
          hi[i + 1] as Vec3,
          hi[i] as Vec3,
        ];
        mesh.facingQuad(quad, [0, side, 0], "window");
      }
    }
  }
}

/** UIC side buffers: centres 1.75 m apart at 1.06 m above rail, standing about 0.45 m off the beam. */
const BUFFER = { y: 0.875, z: 1.06, reach: 0.45, shaft: 0.11, head: 0.22, plate: 0.06 } as const;

/** Lateral fraction of the front at height z whose point lies `y` metres off the centre line. */
function fractionAt(facets: Facets, y: number, z: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (facets(mid, z).point[1] < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A cylinder along x from x0 to x1 round (y, z), capped at its front end when asked; its rear end is open. */
function cylinderX(
  mesh: MeshBuilder,
  x0: number,
  x1: number,
  y: number,
  z: number,
  r: number,
  slot: Slot,
  cap: boolean,
) {
  const n = 6;
  const at = (x: number, i: number): Vec3 => {
    const a = (2 * Math.PI * i) / n;
    return [x, y + r * Math.cos(a), z + r * Math.sin(a)];
  };
  const radial = (k: number): Vec3 => {
    const a = (2 * Math.PI * k) / n;
    return [0, Math.cos(a), Math.sin(a)];
  };
  for (let i = 0; i < n; i++) {
    const normals = [radial(i), radial(i + 1), radial(i + 1), radial(i)] as const;
    mesh.quad(at(x0, i), at(x0, i + 1), at(x1, i + 1), at(x1, i), slot, normals);
  }
  if (!cap) return;
  for (let i = 1; i < n - 1; i++) mesh.triangle(at(x1, 0), at(x1, i), at(x1, i + 1), slot);
}

/** Two side buffers with round heads and a coupler hook between them, on the buffer beam. */
function emitBuffers(mesh: MeshBuilder, facets: Facets) {
  for (const side of [1, -1]) {
    const u = fractionAt(facets, BUFFER.y, BUFFER.z);
    const base = facets(u, BUFFER.z).point[0];
    const y = side * BUFFER.y;
    cylinderX(
      mesh,
      base - 0.05,
      base + BUFFER.reach - BUFFER.plate,
      y,
      BUFFER.z,
      BUFFER.shaft,
      "underframe",
      false,
    );
    cylinderX(
      mesh,
      base + BUFFER.reach - BUFFER.plate,
      base + BUFFER.reach,
      y,
      BUFFER.z,
      BUFFER.head,
      "underframe",
      true,
    );
  }
  const tip = facets(0, BUFFER.z).point[0];
  mesh.box([tip - 0.05, -0.09, BUFFER.z - 0.1], [tip + 0.3, 0.09, BUFFER.z + 0.06], "underframe", [
    "top",
  ]);
}
