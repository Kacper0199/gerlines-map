import { SELECT_PITCH, TILT_MAX_PITCH } from "../map/camera-constants.ts";
import { easeOutDesign } from "../map/easing.ts";
import { TERRAIN_PITCH } from "../map/terrain/relief-control.ts";
import type { ViewPadding } from "../map/view-padding.ts";
import {
  atTarget,
  type CameraState,
  chasePadding,
  metresPerPixel,
  planSelection,
} from "./camera-plan.ts";

const RELEASE_MS = 600;
/** How far the route draw reaches, in screen diagonals at the end of the flight (a tilted view sees further than flat). */
const REACH_DIAGONALS = 1.5;

type CameraOptions = Record<string, unknown>;

/** The part of the MapLibre map the selection camera moves. */
export interface SignatureMap {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getPitch(): number;
  setMaxPitch(pitch: number): unknown;
  jumpTo(options: CameraOptions): unknown;
  easeTo(options: CameraOptions): unknown;
  flyTo(options: CameraOptions): unknown;
  onceMoveEnd(callback: () => void): void;
}

export interface SelectionCameraDeps {
  readonly map: SignatureMap;
  readonly viewport: () => { width: number; height: number };
  /** The padding that keeps the selected train clear of the card and the live bar. */
  readonly padding: () => ViewPadding;
  readonly reducedMotion: () => boolean;
  /** Whether a selection tilts the map (the user's switch). */
  readonly tilt: () => boolean;
  readonly terrain3d: () => boolean;
  readonly endGesture: () => void;
  /** Dips the map to a lower opacity and back, after a cut. */
  readonly fade: () => void;
  readonly now: () => number;
  readonly maxZoom: number;
}

export interface Flight {
  readonly startedAt: number;
  readonly durationMs: number;
  /** Metres from the train the route draw covers: what the screen shows at the end of the flight. */
  readonly reachMetres: number;
}

export interface SelectedPlace {
  readonly lon: number;
  readonly lat: number;
  readonly bearing: number;
}

/**
 * The camera of the signature moment: a click on a train flies and tilts the map to it, and closing the card
 * tilts it back. Dark, Light and Satellite are flat styles whose pitch limit is 0, so the limit is lifted
 * for as long as a selection holds the tilt and dropped again once the map is flat; Terrain 3D keeps the
 * tilt it had. Anything the user does with the map (drag, wheel, keys, another selection) replaces the move
 * under way, which is MapLibre's own behaviour for a move that is not essential.
 */
export class SelectionCamera {
  private readonly deps: SelectionCameraDeps;
  private held = false;

  constructor(deps: SelectionCameraDeps) {
    this.deps = deps;
  }

  /** Whether a selection holds the map tilted, so a style change must not flatten it. */
  get holdsTilt(): boolean {
    return this.held;
  }

  go(selected: SelectedPlace): Flight {
    const { map, viewport } = this.deps;
    const tilt = this.deps.tilt();
    if (tilt) this.holdTilt();
    const centre = map.getCenter();
    const from: CameraState = {
      lng: centre.lng,
      lat: centre.lat,
      zoom: map.getZoom(),
      pitch: map.getPitch(),
    };
    const size = viewport();
    const target = { lng: selected.lon, lat: selected.lat };
    const planned = planSelection(from, target, size, {
      reducedMotion: this.deps.reducedMotion(),
      tilt,
      maxZoom: this.deps.maxZoom,
    });
    const plan = tilt ? planned : { ...planned, pitch: this.restingPitch() };
    const padding = chasePadding(this.deps.padding(), selected.bearing, plan.pitch, size.height);
    const camera = {
      center: [selected.lon, selected.lat],
      zoom: plan.zoom,
      pitch: plan.pitch,
      bearing: 0,
      padding,
    };
    this.deps.endGesture();
    const startedAt = this.deps.now();
    if (plan.mode === "cut") {
      map.jumpTo(camera);
      if (!atTarget(from, target, plan)) this.deps.fade();
    } else {
      const move = { ...camera, duration: plan.durationMs, easing: easeOutDesign };
      if (plan.mode === "fly") {
        map.flyTo({ ...move, curve: plan.curve, minZoom: plan.minZoom });
      } else {
        map.easeTo(move);
      }
    }
    if (!tilt) this.dropLimitWhenFlat();
    const diagonal = Math.hypot(size.width, size.height);
    return {
      startedAt,
      durationMs: plan.durationMs,
      reachMetres: diagonal * metresPerPixel(plan.zoom, selected.lat) * REACH_DIAGONALS,
    };
  }

  /** The selection ended: tilt back to the pitch the map rests at, flat except on the relief. */
  release(): void {
    const { map } = this.deps;
    if (!this.held) return;
    this.held = false;
    const target = this.restingPitch();
    if (Math.abs(map.getPitch() - target) > 0.5) {
      if (this.deps.reducedMotion()) map.jumpTo({ pitch: target });
      else map.easeTo({ pitch: target, duration: RELEASE_MS, easing: easeOutDesign });
    }
    this.dropLimitWhenFlat();
  }

  /** The pitch Follow settles at, or undefined when the tilt is off. Takes hold of the tilt. */
  holdFollowPitch(): number | undefined {
    if (!this.deps.tilt()) return undefined;
    this.holdTilt();
    return Math.max(this.deps.map.getPitch(), SELECT_PITCH);
  }

  /** The pitch Route fits the route at: a plan view, except on the tilted relief. */
  routePitch(): number | undefined {
    return this.deps.terrain3d() ? undefined : 0;
  }

  /** The padding Follow keeps the train at: the card padding with the chase offset of its heading. */
  followPadding(bearing: number): ViewPadding {
    const pitch = this.deps.tilt() ? SELECT_PITCH : this.deps.map.getPitch();
    return chasePadding(this.deps.padding(), bearing, pitch, this.deps.viewport().height);
  }

  private holdTilt(): void {
    this.held = true;
    this.deps.map.setMaxPitch(TILT_MAX_PITCH);
  }

  private restingPitch(): number {
    return this.deps.terrain3d() ? TERRAIN_PITCH : 0;
  }

  /**
   * Flat styles have a pitch limit of 0: once the move that tilts or untilts the map ends, whatever the pitch
   * it ended at (a drag can interrupt the tilt-back), the limit drops and an unfinished tilt snaps flat.
   */
  private dropLimitWhenFlat(): void {
    if (this.deps.terrain3d()) return;
    const { map } = this.deps;
    const drop = () => {
      if (!this.held && !this.deps.terrain3d()) map.setMaxPitch(0);
    };
    if (this.deps.reducedMotion() || map.getPitch() < 0.5) drop();
    else map.onceMoveEnd(drop);
  }
}
