import { SELECT_MIN_ZOOM } from "./camera-constants.ts";
import { routeBounds, splitRoute } from "./route-split.ts";
import type { ViewPadding } from "./view-padding.ts";

const ENGAGE_MS = 600;
const PAUSE_AFTER_WHEEL_MS = 250;
const ROUTE_MAX_ZOOM = 14;
/** Room around the route inside the card padding: the top edge, and the live bar and the credits at the bottom. */
const ROUTE_MARGIN = { top: 56, bottom: 104, left: 32, right: 32 };
const FIT_MS = 900;

export interface FollowSelected {
  readonly lon: number;
  readonly lat: number;
  readonly vertex: number;
  readonly legKey: string;
}

export interface FollowRoute {
  readonly legKey: string;
  readonly path: Float32Array;
}

interface CameraTarget {
  readonly center?: unknown;
  readonly zoom?: number;
}

/** The part of the MapLibre map the camera logic of the selected train uses. */
export interface FollowMap {
  jumpTo(options: { center: [number, number] }): unknown;
  easeTo(options: Record<string, unknown>): unknown;
  setPadding(padding: ViewPadding): unknown;
  cameraForBounds(
    bounds: [[number, number], [number, number]],
    options: { padding: ViewPadding; maxZoom: number },
  ): CameraTarget | undefined | null;
  isMoving(): boolean;
  getZoom(): number;
  onceMoveEnd(callback: () => void): void;
}

export interface FollowDeps {
  readonly map: FollowMap;
  readonly padding: () => ViewPadding;
  /** The padding Follow keeps the train at, when it differs from the card padding. */
  readonly followPadding?: () => ViewPadding;
  /** The pitch Follow settles at (undefined keeps the map's own). */
  readonly followPitch?: () => number | undefined;
  /** The pitch Route fits the route at (undefined keeps the map's own). */
  readonly routePitch?: () => number | undefined;
  readonly flightMs: (ms: number) => number;
  readonly endGesture: () => void;
  readonly onFollowEnd: () => void;
  readonly now: () => number;
}

const PAN_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/**
 * The camera of the selected train: Follow keeps it in the middle of the free map area and Route
 * fits the route ahead. A camera jump cancels every gesture and animation of the map, so Follow
 * jumps only while the map is still, no pointer or wheel is on it and no flight is under way;
 * dragging or panning with the arrow keys ends it, zoom keeps it.
 */
export class FollowController {
  private readonly deps: FollowDeps;
  private following = false;
  private engaging = false;
  private needsEngage = false;
  private routeRequested = false;
  private readonly pointers = new Set<number>();
  private lastWheelAt = Number.NEGATIVE_INFINITY;

  constructor(deps: FollowDeps) {
    this.deps = deps;
  }

  get isFollowing(): boolean {
    return this.following;
  }

  /** The selection changed: nothing asked for the old train applies. */
  reset(): void {
    this.following = false;
    this.engaging = false;
    this.needsEngage = false;
    this.routeRequested = false;
  }

  setFollowing(on: boolean, selected: FollowSelected | null): void {
    if (on === this.following) return;
    this.following = on;
    this.engaging = false;
    this.needsEngage = on;
    if (on) {
      this.routeRequested = false;
      if (selected) this.engage(selected);
    }
  }

  /** Fits the route ahead now, or as soon as the route of the selected train is known. */
  showRoute(selected: FollowSelected | null, route: FollowRoute | undefined): void {
    this.routeRequested = true;
    this.fitRoute(selected, route);
  }

  pointerDown(id: number): void {
    this.pointers.add(id);
  }

  pointerUp(id: number): void {
    this.pointers.delete(id);
  }

  wheel(): void {
    this.lastWheelAt = this.deps.now();
  }

  dragStart(): void {
    this.end();
  }

  /** A movement of the map began; `origin` is the event behind it (a key, a pointer, none). */
  moveStart(origin: { readonly key?: string } | undefined): void {
    if (origin?.key !== undefined && PAN_KEYS.has(origin.key)) this.end();
  }

  /** One frame of the selected train (null without one) and the route of its shape. */
  frame(
    selected: FollowSelected | null,
    route: FollowRoute | undefined,
    pendingFlight: boolean,
  ): void {
    if (this.following && selected && !pendingFlight) {
      if (this.needsEngage) this.engage(selected);
      else if (!this.busy()) this.deps.map.jumpTo({ center: [selected.lon, selected.lat] });
    }
    this.fitRoute(selected, route);
  }

  private busy(): boolean {
    return (
      this.engaging ||
      this.pointers.size > 0 ||
      this.deps.now() - this.lastWheelAt < PAUSE_AFTER_WHEEL_MS ||
      this.deps.map.isMoving()
    );
  }

  private engage(selected: FollowSelected): void {
    const { map } = this.deps;
    this.deps.endGesture();
    this.needsEngage = false;
    this.engaging = true;
    map.onceMoveEnd(() => {
      this.engaging = false;
    });
    const pitch = this.deps.followPitch?.();
    map.easeTo({
      center: [selected.lon, selected.lat],
      zoom: Math.max(map.getZoom(), SELECT_MIN_ZOOM),
      padding: (this.deps.followPadding ?? this.deps.padding)(),
      ...(pitch === undefined ? {} : { pitch }),
      duration: this.deps.flightMs(ENGAGE_MS),
      essential: true,
    });
  }

  private end(): void {
    if (!this.following) return;
    this.following = false;
    this.engaging = false;
    this.needsEngage = false;
    this.deps.onFollowEnd();
  }

  private fitRoute(selected: FollowSelected | null, route: FollowRoute | undefined): void {
    if (!(this.routeRequested && selected && route?.legKey === selected.legKey)) return;
    const { ahead } = splitRoute(route.path, selected.vertex, selected.lon, selected.lat);
    const bounds = routeBounds(ahead);
    if (!bounds) return;
    this.routeRequested = false;
    this.end();
    this.deps.endGesture();
    const padding = this.deps.padding();
    this.deps.map.setPadding(padding);
    const camera = this.deps.map.cameraForBounds(bounds, {
      padding: ROUTE_MARGIN,
      maxZoom: ROUTE_MAX_ZOOM,
    });
    if (!camera) return;
    const pitch = this.deps.routePitch?.();
    this.deps.map.easeTo({
      ...camera,
      padding,
      ...(pitch === undefined ? {} : { pitch }),
      duration: this.deps.flightMs(FIT_MS),
      essential: true,
    });
  }
}
