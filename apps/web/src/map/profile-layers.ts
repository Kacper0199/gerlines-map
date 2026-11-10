import type { Layer } from "@deck.gl/core";
import { PathLayer, SolidPolygonLayer } from "@deck.gl/layers";
import { dashPieces, legPath, ribbonRing } from "../profile/geometry.ts";
import {
  type LegMeasure,
  legMeasure,
  type ProfileLeg,
  type ProfileOverlay,
} from "../profile/model.ts";
import { type GainClass, MISSING_COLOUR, profileColour } from "../profile/scale.ts";
import { colorValue, hexToRgb, type ThemeName } from "../theme/tokens.ts";
import { TRAIN_ANCHOR_LAYER_ID } from "./style/build-style.ts";
import { metresPerPixel } from "./terrain/elevation.ts";

/** How tall one minute of delay gain stands on screen, whatever the zoom. */
export const CURTAIN_PX_PER_MINUTE = 12;
const CURTAIN_HALF_WIDTH_PX = 2;
const ROUTE_PX = 6;
const CASING_PX = 10;
const HOVER_PX = 12;
const HIT_PX = 16;
const MISSING_PX = 4;
const DASH_PX = 12;
const GAP_PX = 9;
const SPACING_PX = 1.5;
const PASSED_ALPHA = 120;
const CURTAIN_ALPHA = 120;
/** Soft shading, so the top edge and the two faces of the wall read apart without shifting the colour of the scale. */
const CURTAIN_MATERIAL: {
  ambient: number;
  diffuse: number;
  shininess: number;
  specularColor: [number, number, number];
} = { ambient: 0.7, diffuse: 0.5, shininess: 1, specularColor: [0, 0, 0] };

const OVER_RELIEF = { depthCompare: "always", depthWriteEnabled: false } as const;
const NO_DEPTH_WRITE = { depthWriteEnabled: false } as const;

type Rgba = [number, number, number, number];

export interface ProfileRouteInput {
  readonly path: Float32Array;
  readonly heights: Float32Array | undefined;
  readonly stops: Float32Array;
}

export interface ProfileLayerInput {
  readonly overlay: ProfileOverlay;
  readonly route: ProfileRouteInput;
  /** What the route layers are raised by, so the profile lies on the same line. */
  readonly lift: number;
  readonly zoom: number;
  readonly lat: number;
  readonly theme: ThemeName;
  readonly terrain: boolean;
  /** The camera is tilted, so the curtain is drawn. */
  readonly pitched: boolean;
  /** The selected train's position on the route as a fractional vertex index; legs behind it are dimmed. */
  readonly vertex: number;
  readonly hover: number | null;
}

export interface AssembledLeg {
  readonly leg: ProfileLeg;
  readonly measure: LegMeasure;
  readonly path: Float32Array;
  readonly dashes: readonly Float32Array[];
  readonly ring: number[][] | null;
}

interface Key {
  readonly path: Float32Array;
  readonly heights: Float32Array | undefined;
  readonly stops: Float32Array;
  readonly overlay: ProfileOverlay;
  readonly lift: number;
  readonly bucket: number;
  readonly curtain: boolean;
}

function rgba(hex: string, alpha = 255): Rgba {
  const [r, g, b] = hexToRgb(hex);
  return [r, g, b, alpha];
}

function sameKey(a: Key, b: Key): boolean {
  return (
    a.path === b.path &&
    a.heights === b.heights &&
    a.stops === b.stops &&
    a.overlay === b.overlay &&
    a.lift === b.lift &&
    a.bucket === b.bucket &&
    a.curtain === b.curtain
  );
}

/**
 * The layers of the segment profile on the selected train's route (WP-7.4b): the route in the colour of each
 * leg's delay gain against all trains, missing legs dashed, and in a tilted view a translucent curtain
 * above the track whose height is the minutes this train loses on the leg. The geometry is cut from the
 * route's own vertices between the stop positions the worker sent, so it follows the shape and its baked
 * height; it is rebuilt when the route, the legs or half a zoom step change, not every frame.
 */
export class ProfileLayers {
  private key: Key | undefined;
  private cached: readonly AssembledLeg[] = [];
  private derived: Derived | undefined;

  assembled(input: ProfileLayerInput): readonly AssembledLeg[] {
    const bucket = Math.round(input.zoom * 2) / 2;
    const key: Key = {
      path: input.route.path,
      heights: input.route.heights,
      stops: input.route.stops,
      overlay: input.overlay,
      lift: input.lift,
      bucket,
      curtain: input.pitched,
    };
    if (this.key && sameKey(this.key, key)) return this.cached;
    this.key = key;
    this.cached = assemble(input, bucket);
    return this.cached;
  }

  /** The layer data of one assembly and theme; the same arrays are handed to deck until either changes. */
  private derive(assembled: readonly AssembledLeg[], theme: ThemeName): Derived {
    if (this.derived && this.derived.source === assembled && this.derived.theme === theme) {
      return this.derived;
    }
    const drawn = assembled.filter((entry) => entry.path.length > 0);
    const known = drawn.filter((entry) => entry.measure.status === "known");
    const missing = drawn.filter((entry) => entry.measure.status === "missing");
    const piece = (entry: AssembledLeg, path: Float32Array) => ({ path, leg: entry.leg.index });
    this.derived = {
      source: assembled,
      theme,
      whole: drawn.map((entry) => piece(entry, entry.path)),
      hit: missing.map((entry) => piece(entry, entry.path)),
      dashes: missing.flatMap((entry) =>
        entry.dashes.map((dash) => ({ ...piece(entry, dash), toVertex: entry.leg.toVertex ?? 0 })),
      ),
      route: known.map((entry) => ({
        ...piece(entry, entry.path),
        gain: entry.measure.status === "known" ? entry.measure.gain : (0 as GainClass),
        toVertex: entry.leg.toVertex ?? 0,
      })),
      curtain: known.flatMap((entry) => {
        const measure = entry.measure;
        if (measure.status !== "known" || measure.curtainMinutes <= 0 || !entry.ring) return [];
        return [
          {
            leg: entry.leg.index,
            ring: entry.ring,
            minutes: measure.curtainMinutes,
            colour: rgba(profileColour(measure.gain, theme), CURTAIN_ALPHA),
          },
        ];
      }),
      hovers: new Map(),
    };
    return this.derived;
  }

  build(input: ProfileLayerInput): Layer[] {
    const { legs } = input.overlay;
    if (input.route.stops.length !== legs.length + 1) return [];
    const { theme } = input;
    const derived = this.derive(this.assembled(input), theme);
    const passed = derived.route.filter((entry) => entry.toVertex <= input.vertex).length;
    const passedMissing = new Set(
      derived.dashes.filter((entry) => entry.toVertex <= input.vertex).map((entry) => entry.leg),
    ).size;
    const parameters = input.terrain ? OVER_RELIEF : NO_DEPTH_WRITE;
    const path = (
      id: string,
      data: readonly { path: Float32Array; leg: number }[],
      getColor: Rgba | ((d: never) => Rgba),
      width: number,
      extra: Record<string, unknown> = {},
    ) =>
      new PathLayer({
        id,
        data: data as never,
        positionFormat: "XYZ",
        getPath: (d: { path: Float32Array }) => d.path as never,
        getColor: getColor as never,
        getWidth: width,
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
        parameters,
        beforeId: TRAIN_ANCHOR_LAYER_ID,
        ...extra,
      });
    const layers: Layer[] = [
      path("profile-casing", derived.whole, rgba(colorValue("surface", theme), 230), CASING_PX),
    ];
    const hovered = derived.whole.find((entry) => entry.leg === input.hover);
    if (hovered) {
      let data = derived.hovers.get(hovered.leg);
      if (!data) {
        data = [hovered];
        derived.hovers.set(hovered.leg, data);
      }
      layers.push(path("profile-hover", data, rgba(colorValue("ink", theme)), HOVER_PX));
    }
    layers.push(path("profile-hit", derived.hit, [128, 128, 128, 3], HIT_PX, { pickable: true }));
    const colour = (entry: { gain: GainClass; toVertex: number }): Rgba =>
      rgba(profileColour(entry.gain, theme), entry.toVertex <= input.vertex ? PASSED_ALPHA : 255);
    layers.push(
      path("profile-route", derived.route, colour as never, ROUTE_PX, {
        pickable: true,
        updateTriggers: { getColor: [passed, theme] },
      }),
    );
    const missingColour = (entry: { toVertex: number }): Rgba =>
      rgba(MISSING_COLOUR[theme], entry.toVertex <= input.vertex ? PASSED_ALPHA : 255);
    layers.push(
      path("profile-missing", derived.dashes, missingColour as never, MISSING_PX, {
        capRounded: false,
        jointRounded: false,
        updateTriggers: { getColor: [passedMissing, theme] },
      }),
    );
    if (input.pitched) layers.push(curtainLayer(derived.curtain, input, parameters));
    return layers;
  }
}

interface Derived {
  readonly source: readonly AssembledLeg[];
  readonly theme: ThemeName;
  readonly whole: readonly Piece[];
  readonly hit: readonly Piece[];
  readonly dashes: readonly (Piece & { toVertex: number })[];
  readonly route: readonly (Piece & { gain: GainClass; toVertex: number })[];
  readonly curtain: readonly CurtainPiece[];
  readonly hovers: Map<number, readonly Piece[]>;
}

interface Piece {
  readonly path: Float32Array;
  readonly leg: number;
}

interface CurtainPiece {
  readonly leg: number;
  readonly ring: number[][];
  readonly minutes: number;
  readonly colour: Rgba;
}

function curtainLayer(
  data: readonly CurtainPiece[],
  input: ProfileLayerInput,
  parameters: object,
): Layer {
  const scale = CURTAIN_PX_PER_MINUTE * metresPerPixel(input.zoom, input.lat);
  return new SolidPolygonLayer({
    id: "profile-curtain",
    data: data as never,
    extruded: true,
    material: CURTAIN_MATERIAL,
    getPolygon: (d: { ring: number[][] }) => d.ring as never,
    getElevation: (d: { minutes: number }) => d.minutes,
    getFillColor: (d: { colour: Rgba }) => d.colour,
    elevationScale: scale,
    pickable: true,
    parameters: parameters as never,
    beforeId: TRAIN_ANCHOR_LAYER_ID,
  });
}

function assemble(input: ProfileLayerInput, bucket: number): AssembledLeg[] {
  const mpp = metresPerPixel(bucket, input.lat);
  const { path, heights, stops } = input.route;
  return input.overlay.legs.map((leg, index) => {
    const from = stops[index] as number;
    const to = stops[index + 1] as number;
    const line = legPath(path, heights, from, to, input.lift, SPACING_PX * mpp);
    const measure = legMeasure(leg, input.overlay.quantile);
    return {
      leg: { ...leg, fromVertex: from, toVertex: to },
      measure,
      path: line,
      dashes: measure.status === "missing" ? dashPieces(line, DASH_PX * mpp, GAP_PX * mpp) : [],
      ring:
        input.pitched && measure.status === "known" && measure.curtainMinutes > 0
          ? ribbonRing(line, CURTAIN_HALF_WIDTH_PX * mpp)
          : null,
    };
  });
}
