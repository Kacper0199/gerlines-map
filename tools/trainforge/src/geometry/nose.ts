import type { FrontDecalInput, FrontInput, NoseShape } from "../catalog.ts";
import { type FrontDecal, type FrontSpec, PLAN_EXPONENTS } from "./front.ts";
import type { NoseLoft } from "./loft.ts";

/** Body heights a front class is drawn against. */
export interface NoseLevels {
  readonly floor: number;
  readonly sill: number;
  readonly top: number;
  readonly height: number;
}

/** Nose length of each class, metres; a stylisation used only without a measured front. */
export const NOSE_LENGTH: Readonly<Record<NoseShape, number>> = {
  streamlined: 6.5,
  wedge: 4.2,
  rounded: 2.0,
  blunt: 1.2,
  cab_car: 1.8,
  locomotive: 1.0,
};

function bullet(l: NoseLevels, length: number, tipLift: number, width: number): FrontSpec {
  const tipZ = l.floor + tipLift;
  const screenBottom = Math.max(tipZ + 0.6, l.floor + 1.05);
  return {
    length,
    tipZ,
    faceTop: tipZ,
    bottom: null,
    bottomSetback: 0.22 * length,
    screenBottom,
    screenTop: Math.max(screenBottom + 0.5, l.height - 0.5),
    screenBottomSetback: 0.3 * length,
    screenTopSetback: 0.62 * length,
    screenWidth: width,
    plan: length > 5 ? PLAN_EXPONENTS.pointed : PLAN_EXPONENTS.round,
    straight: 0,
    mask: null,
    lamps: { bottom: l.floor - 0.12, top: l.floor + 0.2, inner: 0.45, outer: 0.8 },
    skirtTop: null,
    stripe: "sides",
    frontStripe: null,
    cabWindow: false,
    sideWindow: null,
    cabLength: length,
  };
}

function cab(
  l: NoseLevels,
  length: number,
  screenBottom: number,
  screenTop: number,
  incline: number,
): FrontSpec {
  return {
    length,
    tipZ: Math.min(screenBottom - 0.3, l.floor + 0.4),
    faceTop: screenBottom - 0.15,
    bottom: null,
    bottomSetback: Math.min(0.25, length / 4),
    screenBottom,
    screenTop,
    screenBottomSetback: 0.05,
    screenTopSetback: Math.min(length * 0.8, incline),
    screenWidth: 0.86,
    plan: PLAN_EXPONENTS.flat,
    straight: Math.max(0, length - 0.5),
    mask: {
      bottom: screenBottom - 0.25,
      top: Math.min(l.height - 0.1, screenTop + 0.12),
      width: 0.94,
    },
    lamps: {
      bottom: Math.max(0.6, screenBottom - 1.1),
      top: Math.max(0.85, screenBottom - 0.8),
      inner: 0.55,
      outer: 0.86,
    },
    skirtTop: null,
    stripe: "across",
    frontStripe: null,
    cabWindow: true,
    sideWindow: null,
    cabLength: length + 1.4,
  };
}

/** The class front of a nose shape: every value a stylisation listed as estimated. */
export function classFront(shape: NoseShape, l: NoseLevels): FrontSpec {
  const length = NOSE_LENGTH[shape];
  const regionalScreen = Math.max(l.sill, l.floor + 1.0, 1.7);
  switch (shape) {
    case "streamlined":
      return bullet(l, length, 0.15, 0.62);
    case "wedge":
      return bullet(l, length, 0.45, 0.7);
    case "rounded":
      return cab(l, length, regionalScreen, l.height - 0.4, 0.8);
    case "blunt":
      return cab(l, length, regionalScreen, l.height - 0.35, 0.45);
    case "cab_car":
      return cab(l, length, Math.max(1.9, l.floor + 1.2), l.height - 0.75, 0.7);
    case "locomotive":
      return cab(l, length, l.height - 1.6, l.height - 0.55, 0.45);
  }
}

function band(bottom: number | null | undefined, top: number | null | undefined) {
  return bottom != null && top != null ? { bottom, top } : null;
}

function measuredLamps(input: FrontInput): FrontSpec["lamps"] {
  const heights = band(input.lamp_bottom_m, input.lamp_top_m);
  const widths = band(input.lamp_inner, input.lamp_outer);
  return heights && widths ? { ...heights, inner: widths.bottom, outer: widths.top } : null;
}

function measuredMask(input: FrontInput, l: NoseLevels): FrontSpec["mask"] {
  if (input.mask_bottom_m == null || input.mask_width == null) return null;
  return {
    bottom: input.mask_bottom_m,
    top: input.mask_top_m ?? Math.min(l.height - 0.05, input.screen_top_m + 0.12),
    width: input.mask_width,
  };
}

function measuredLoft(input: FrontInput): NoseLoft | null {
  const l = input.loft;
  if (!l) return null;
  return {
    waist: l.waist_m,
    top: l.top_m,
    bottom: l.bottom_m,
    exponent: l.exponent,
    taper: l.taper,
    widths: l.widths ?? null,
  };
}

/** Lamp fill, lens margin, logo plate, its red letters and panel seam flags of a catalogue decal. */
function decalKind(d: FrontDecalInput) {
  return {
    ...(d.fill ? { fill: true } : {}),
    ...(d.lens_margin_m != null ? { lensMargin: d.lens_margin_m } : {}),
    ...(d.logo ? { logo: true } : {}),
    ...(d.logo_red_letters ? { redLetters: true } : {}),
    ...(d.seam ? { seam: true } : {}),
    ...(d.clear_lens ? { clearLens: d.clear_lens } : {}),
  };
}

function tailSide(d: FrontDecalInput): Partial<FrontDecal> {
  const mode = d.tail_mode === "combined" ? { combinedTail: true } : {};
  if (d.tail_side === "inner") return { tailInner: true, ...mode };
  return d.tail_side === "below" ? { tailBelow: true, ...mode } : mode;
}

function measuredPanes(input: FrontInput): Partial<FrontSpec> {
  return {
    screenRound: input.screen_round ?? null,
    ...(input.screen_columns ? { screenColumns: true } : {}),
    ...(input.screen_tone === "light" ? { lightGlass: true } : {}),
    ...(input.mask_slot ? { maskSlot: input.mask_slot } : {}),
    ...(input.buffers ? { buffers: true } : {}),
    decals: (input.decals ?? []).map((d) => ({
      slot: d.slot,
      bottom: d.bottom_m,
      top: d.top_m,
      inner: d.inner,
      outer: d.outer,
      round: d.round ?? 6,
      slant: d.slant ?? 0,
      ...(d.under ? { under: true } : {}),
      ...(d.tilt_deg ? { tilt: d.tilt_deg } : {}),
      ...(d.tail != null ? { tail: d.tail } : {}),
      ...tailSide(d),
      ...decalKind(d),
    })),
    ...(input.cab_glass_curve ? { cabGlassCurve: input.cab_glass_curve } : {}),
    ...(input.band_from_curve_start ? { bandFromCurveStart: true } : {}),
    ...(input.lettering
      ? {
          lettering: {
            text: input.lettering.text,
            from: input.lettering.from_m,
            to: input.lettering.to_m,
            bottom: input.lettering.bottom_m,
            top: input.lettering.top_m,
            italic: input.lettering.italic ?? 0,
            stripeGap: input.lettering.stripe_gap_m ?? null,
          },
        }
      : {}),
    ...(input.plain_cab_side ? { plainCabSide: true } : {}),
    sideWindowBand: band(input.side_window_bottom_m, input.side_window_top_m),
    sideWindowRound: input.side_window_round_m ?? 0,
    ...(input.side_window_rake != null ? { sideWindowRake: input.side_window_rake } : {}),
  };
}

/** The opt-in measured shape of a nose: side profile or profile by height, plan, tip gap and stripe. */
function measuredShape(input: FrontInput): Partial<FrontSpec> {
  return {
    ...(input.side_profile ? { sideProfile: input.side_profile } : {}),
    ...(input.profile_by_height ? { profileByHeight: input.profile_by_height } : {}),
    ...(input.plan_widths ? { planWidths: input.plan_widths } : {}),
    ...(input.tip_gap_m != null ? { tipGap: input.tip_gap_m } : {}),
    ...(input.stripe_curve ? { stripeCurve: input.stripe_curve } : {}),
  };
}

/** A measured front from vehicles.yaml in the forge's terms. */
export function measuredFront(input: FrontInput, l: NoseLevels): FrontSpec {
  const side = band(input.side_window_from_m, input.side_window_to_m);
  return {
    length: input.length_m,
    tipZ: input.tip_height_m,
    faceTop: input.face_top_m ?? input.tip_height_m,
    bottom: input.bottom_m ?? null,
    bottomSetback: input.bottom_setback_m,
    screenBottom: input.screen_bottom_m,
    screenTop: input.screen_top_m,
    screenBottomSetback: input.screen_bottom_setback_m,
    screenTopSetback: input.screen_top_setback_m,
    screenWidth: input.screen_width,
    plan: input.plan_exponents ?? PLAN_EXPONENTS[input.plan],
    straight: input.straight_m ?? 0,
    mask: measuredMask(input, l),
    lamps: measuredLamps(input),
    skirtTop: input.front_skirt_top_m ?? input.skirt_top_m ?? null,
    stripe: input.stripe ?? "sides",
    frontStripe: band(input.front_stripe_bottom_m, input.front_stripe_top_m),
    cabWindow: input.cab_window ?? false,
    sideWindow: side ? { from: side.bottom, to: side.top } : null,
    cabLength: input.cab_length_m ?? input.length_m,
    loft: measuredLoft(input),
    faceBulge: input.face_bulge_m ?? 0,
    bandCurve: input.band_curve ?? null,
    screenWidths: input.screen_widths ?? null,
    ...measuredShape(input),
    chin:
      input.chin_bottom_m != null && input.chin_top_m != null && input.chin_width != null
        ? { bottom: input.chin_bottom_m, top: input.chin_top_m, width: input.chin_width }
        : null,
    cheeks: input.cheeks
      ? {
          bottom: input.cheeks.bottom_m,
          top: input.cheeks.top_m,
          inner: input.cheeks.inner,
          outer: input.cheeks.outer,
          reach: input.cheeks.reach_m,
          recess: input.cheeks.recess_m,
        }
      : null,
    ...measuredPanes(input),
  };
}
