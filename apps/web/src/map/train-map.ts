import type { Layer } from "@deck.gl/core";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import {
  type EaseToOptions,
  type FlyToOptions,
  LngLat,
  Map as MapLibreMap,
  setWorkerUrl,
} from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { CarModels, pickedCarKey, selectedMarkerFade } from "../cars/car-layers.ts";
import { loadWithRetry } from "../cars/load-retry.ts";
import { warnCars } from "../cars/warn.ts";
import type { Place } from "../inview/model.ts";
import { adoptEarlyWorker, takeEarlyWorker } from "../live/early-start.ts";
import type { PlaybackState } from "../live/playback/driver.ts";
import { liveConfigOf, overrideModeOf } from "../live/source.ts";
import { liveTrainId } from "../live/train-ids.ts";
import type { ColourMode } from "../modes/colour-mode.ts";
import { LABEL_MIN_ZOOM, type LabelMode } from "../modes/label-mode.ts";
import type { OperatorGroup } from "../modes/operator-groups.ts";
import type { CategoryKey } from "../motion/categories.ts";
import type { Frame, SelectedFrame } from "../motion/frame.ts";
import type {
  ContinuityTotals,
  DataStatus,
  LiveDiagnostics,
  LiveSelectionInfo,
  NearestTrains,
  PlaybackCommand,
  SelectionStops,
} from "../motion/protocol.ts";
import { createMotionClient, type MotionClient } from "../motion/worker-client.ts";
import type { ProfileHover, ProfileOverlay } from "../profile/model.ts";
import { isPitched } from "../signature/camera-plan.ts";
import { fadeIn } from "../signature/fade.ts";
import { SelectionCamera, type SignatureMap } from "../signature/selection-camera.ts";
import { SelectionMoment } from "../signature/selection-moment.ts";
import { colorValue, hexToRgb, type ThemeName, trainPalette } from "../theme/tokens.ts";
import { type CheckSnapshot, snapshotOf } from "./check-hook.ts";
import { createChevronAtlas } from "./chevron-atlas.ts";
import { FollowController, type FollowMap } from "./follow-controller.ts";
import { nearestTrains, type ProbedTrain } from "./frame-probe.ts";
import { geoFilesFor } from "./geo-base.ts";
import {
  buildLabelLayer,
  type LabelItem,
  labelItems,
  placeLabels,
  splitSelectedLabel,
} from "./label-layer.ts";
import { focusLand } from "./land-focus.ts";
import { type LookState, lookStyle, MapLook } from "./map-look.ts";
import { onMediaChange, pickingRadius } from "./media.ts";
import { ProfileLayers } from "./profile-layers.ts";
import { drawsEveryFrame, type GateView, nearScale, RepaintGate } from "./repaint-gate.ts";
import { acceptRoute, type RouteSlot } from "./route-slot.ts";
import { RouteSplitter } from "./route-split.ts";
import { SlotEase } from "./slot-ease.ts";
import { GERMANY_BOX, hardBounds, type LngLatLike, unionBounds } from "./soft-bounds.ts";
import { attachSoftBounds, type SoftBounds } from "./soft-bounds-control.ts";
import { TERRAIN_SOURCE_ID } from "./style/build-style.ts";
import type { LandCode, MapStyleKind } from "./style/map-styles.ts";
import { themeForStyle } from "./style/map-styles.ts";
import { BridgeDeck } from "./terrain/bridge-deck.ts";
import type { DeckWindows } from "./terrain/deck-windows.ts";
import { markerLiftM, selectedCover } from "./terrain/elevation.ts";
import { MeasureRetry } from "./terrain/measure-retry.ts";
import { ReliefControl, TERRAIN_MAX_PITCH, TERRAIN_PITCH } from "./terrain/relief-control.ts";
import { buildTrainLayers, chevronOpacity, chevronPixels } from "./train-layers.ts";
import { type ViewPadding, viewPadding } from "./view-padding.ts";

setWorkerUrl(maplibreWorkerUrl);

const GERMANY_BOUNDS: [[number, number], [number, number]] = [
  [GERMANY_BOX.west, GERMANY_BOX.south],
  [GERMANY_BOX.east, GERMANY_BOX.north],
];
const PHONE_QUERY = "(max-width: 640px)";
const FOCUS_FLIGHT_MS = 900;
const MAX_ZOOM = 17;
const INTERACTION_EVENTS = ["pointerdown", "wheel", "keydown"] as const;

export interface TrainMapOptions {
  readonly container: HTMLElement;
  readonly style: MapStyleKind;
  readonly labelLanguage: string;
  readonly buildings: boolean;
  /** The relief is on from the first frame, so the style is built once and the map starts tilted. */
  readonly terrain3d: boolean;
  /** A selection tilts the map: the user's switch, on by default. */
  readonly selectionTilt?: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onStatus: (status: DataStatus) => void;
  readonly onLiveSelectionInfo: (info: LiveSelectionInfo | null) => void;
  readonly onSelectionDrawn: (drawn: boolean, key: number) => void;
  readonly onZoom: (zoom: number) => void;
  readonly onInteract: () => void;
  /** The user moved or zoomed the map (a drag, wheel, keys, pinch or the zoom buttons); not a camera flight the page started. */
  readonly onUserMove?: () => void;
  readonly onFollowEnd: () => void;
  /** Whether a card or panel holds the left slot of the desktop shell, read each time the view is fitted. */
  readonly leftSlotOpen?: () => boolean;
  readonly onPlayback?: (state: PlaybackState | null) => void;
  /** Where each stop of the selected train lies on its drawn route (fractional vertex indices), null when unknown. */
  readonly onRouteStops?: (stops: SelectionStops | null) => void;
  /** The segment profile leg under the pointer or tapped; null when none. */
  readonly onProfileHover?: (hover: ProfileHover | null) => void;
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const VIEW_MARGIN = 1.15;
/** Zoom from which the page fetches the train models, a little before the car tier. */
const CAR_LOAD_ZOOM = 15.3;
/** Segments that wait for their terrain tile are measured again at most this often. */
const DECK_RETRY_MS = 1000;
/** Terrain lookups one frame spends on measuring the deck: about 1,300 segments, a few milliseconds. */
const DECK_LOOKUPS_PER_FRAME = 4000;

/** Probe runs only: `?carCull=0` places cars beyond the screen too, for frame budget runs. */
function carCullOverride(search: string): boolean {
  const params = new URLSearchParams(search);
  return !(params.has("probe") && params.get("carCull") === "0");
}

/** Probe runs only: `?carRadiusKm=` widens the car tier to load the frame budget with many trains. */
function carRadiusOverride(search: string): number | undefined {
  const params = new URLSearchParams(search);
  const km = Number(params.get("carRadiusKm"));
  return params.has("probe") && km > 0 ? km * 1000 : undefined;
}

interface PickInfo {
  readonly index: number;
  readonly layer?: { readonly id: string } | null;
  readonly object?: { readonly leg?: number } | null;
  readonly x?: number;
  readonly y?: number;
}

const PROFILE_LAYER = /^profile-/;
/** The pointer has to move this far over a profile leg before the tooltip follows. */
const HOVER_MOVE_PX = 3;
/** The camera counts as tilted from this pitch, so the profile curtain is drawn. */
const CURTAIN_MIN_PITCH = 5;

function profileHoverOf(info: PickInfo): ProfileHover | null {
  const leg = info.object?.leg;
  if (!PROFILE_LAYER.test(info.layer?.id ?? "") || typeof leg !== "number") return null;
  return { leg, x: info.x ?? 0, y: info.y ?? 0 };
}

export class TrainMap {
  private readonly options: TrainMapOptions;
  private readonly map: MapLibreMap;
  private readonly look: MapLook;
  private readonly softBounds: SoftBounds;
  private overlay: MapLibreOverlay | undefined;
  private readonly client: MotionClient;
  private readonly worker: Worker;
  private readonly startedEarly: boolean;
  private readonly atlas: HTMLCanvasElement;
  private readonly phone = window.matchMedia(PHONE_QUERY);
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly ids: string[][] = [[], []];
  private latest: Frame | undefined;
  private route: RouteSlot | undefined;
  private profile: ProfileOverlay | null = null;
  private readonly profileLayers = new ProfileLayers();
  private profileHover: ProfileHover | null = null;
  private readonly splitter = new RouteSplitter();
  private readonly bridges = new BridgeDeck();
  private readonly deckRetry = new MeasureRetry(DECK_RETRY_MS);
  private deckWindows: DeckWindows | undefined;
  private selectedId: string | null = null;
  private theme: ThemeName;
  private hiddenCategories: readonly CategoryKey[] = [];
  private hiddenOperatorGroups: readonly OperatorGroup[] = [];
  private colourMode: ColourMode = "category";
  private labelMode: LabelMode = "off";
  private labels: (string[] | undefined)[] = [undefined, undefined];
  private labelItemList: LabelItem[] = [];
  private labelTick = 0;
  private readonly follow: FollowController;
  private readonly signature: SelectionCamera;
  private readonly moment: SelectionMoment;
  private selectionTilt: boolean;
  private readonly relief: ReliefControl;
  private frameRequest = 0;
  private disposed = false;
  private readonly cars = new CarModels(() => this.render());
  private readonly repaintGate = new RepaintGate();
  private readonly repaintAlways = drawsEveryFrame(window.location.search);
  private bridgesDrawn = 0;
  private viewSent = "";
  private zoomRequested = false;
  private carsRequested = false;
  private cancelCarLoad: (() => void) | undefined;
  private readonly carRadiusM = carRadiusOverride(window.location.search);
  private readonly carCull = carCullOverride(window.location.search);
  private readonly stopWatchingPhone: () => void;

  constructor(options: TrainMapOptions) {
    this.options = options;
    this.selectionTilt = options.selectionTilt ?? true;
    this.theme = themeForStyle(options.style);
    this.atlas = createChevronAtlas();
    const terrain3d = options.terrain3d && options.style === "terrain";
    const look: LookState = {
      style: options.style,
      labelLanguage: options.labelLanguage,
      focus: null,
      terrain3d,
      buildings: options.buildings,
    };
    const origin = window.location.origin;
    const files = geoFilesFor(origin);
    const style = lookStyle(look, origin, undefined, files.data);
    this.map = new MapLibreMap({
      container: options.container,
      style,
      bounds: GERMANY_BOUNDS,
      fitBoundsOptions: { padding: this.paddingFor(false) },
      maxBounds: this.hardBoundsForView(),
      minZoom: 3.5,
      maxZoom: MAX_ZOOM,
      pitch: terrain3d ? TERRAIN_PITCH : 0,
      maxPitch: terrain3d ? TERRAIN_MAX_PITCH : 0,
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: false,
      attributionControl: false,
      fadeDuration: 0,
      canvasContextAttributes: { antialias: true },
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.look = new MapLook(this.map, look, origin, files, style);
    this.softBounds = attachSoftBounds(this.map, {
      reducedMotion: () => this.reducedMotion.matches,
      selected: () => this.selectedPosition(),
    });
    this.map.on("resize", () => this.map.setMaxBounds(this.hardBoundsForView()));
    this.map.on("zoom", () => {
      options.onZoom(this.map.getZoom());
      this.render();
    });
    this.relief = new ReliefControl({
      map: this.map,
      look: this.look,
      setElevation: (scale) => this.client.setElevation(scale),
      flightMs: (ms) => this.flightMs(ms),
      holdsTilt: () => this.signature.holdsTilt,
    });
    this.signature = new SelectionCamera({
      map: this.signatureMap(),
      viewport: () => ({
        width: options.container.clientWidth || window.innerWidth,
        height: options.container.clientHeight || window.innerHeight,
      }),
      padding: () => viewPadding(this.phone.matches, true),
      reducedMotion: () => this.reducedMotion.matches,
      tilt: () => this.selectionTilt,
      terrain3d: () => this.look.current.terrain3d,
      endGesture: () => this.softBounds.endGesture(),
      fade: () => fadeIn(this.map.getCanvasContainer()),
      now: () => performance.now(),
      maxZoom: MAX_ZOOM,
    });
    this.moment = new SelectionMoment(this.signature, () => performance.now());
    this.follow = new FollowController({
      map: this.followMap(),
      padding: () => viewPadding(this.phone.matches, true),
      followPadding: () => this.signature.followPadding(this.selectedFrame()?.bearing ?? 0),
      followPitch: () => this.signature.holdFollowPitch(),
      routePitch: () => this.signature.routePitch(),
      flightMs: (ms) => this.flightMs(ms),
      endGesture: () => this.softBounds.endGesture(),
      onFollowEnd: options.onFollowEnd,
      now: () => performance.now(),
    });
    this.map.on("dragstart", () => this.follow.dragStart());
    this.map.on("movestart", (event) =>
      this.follow.moveStart(event.originalEvent as { key?: string } | undefined),
    );
    const early = takeEarlyWorker();
    this.startedEarly = early !== undefined;
    this.worker =
      early ?? new Worker(new URL("../live/live.worker.ts", import.meta.url), { type: "module" });
    this.client = createMotionClient(this.worker, {
      onFrame: (frame, path, heights, deck, stops) =>
        this.receiveFrame(frame, path, heights, deck, stops),
      onStatus: options.onStatus,
      onLiveSelection: options.onLiveSelectionInfo,
      onSelectionDrawn: options.onSelectionDrawn,
      ...(options.onPlayback ? { onPlayback: options.onPlayback } : {}),
    });
    this.relief.start();
    this.map.on("sourcedata", (event) => {
      if (event.sourceId === TERRAIN_SOURCE_ID && event.tile) this.deckRetry.changed();
    });
    this.map.on("moveend", (event) => {
      this.deckRetry.changed();
      const requested = this.zoomRequested;
      this.zoomRequested = false;
      if (event.originalEvent || requested) options.onUserMove?.();
    });
    this.map.on("idle", () => {
      if (!this.bridges.pending && this.deckRetry.due(performance.now(), this.bridges.unmeasured)) {
        this.measureDeck();
      }
    });
    this.map.once("load", () => {
      this.attachOverlay();
      void this.look.laender();
    });
    this.stopWatchingPhone = onMediaChange(this.phone, (phone) =>
      this.overlay?.setProps({ pickingRadius: pickingRadius(phone) }),
    );
    document.addEventListener("visibilitychange", this.onVisibility);
    this.reducedMotion.addEventListener("change", this.onReducedMotion);
    this.client.setHidden(document.hidden);
    for (const type of INTERACTION_EVENTS) {
      options.container.addEventListener(type, this.onUserInput, { passive: true });
    }
    options.container.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    options.container.addEventListener("wheel", this.onWheel, { passive: true });
    window.addEventListener("pointerup", this.onPointerUp, { passive: true });
    window.addEventListener("pointercancel", this.onPointerUp, { passive: true });
  }

  setSelected(id: string | null): void {
    if (id === this.selectedId) {
      return;
    }
    this.selectedId = id;
    this.moment.select(id);
    this.follow.reset();
    this.route = undefined;
    this.profileHover = null;
    this.client.select(id);
    this.render();
  }

  /** The camera keeps the selected train in view until the user drags the map or the train changes. */
  setFollowing(on: boolean): void {
    this.follow.setFollowing(on, this.selectedFrame());
  }

  setSelectionTilt(on: boolean): void {
    if (on === this.selectionTilt) return;
    this.selectionTilt = on;
    this.moment.tiltSwitched(on);
  }

  /** The segment profile drawn over the selected train's route; null removes it. */
  setProfile(profile: ProfileOverlay | null): void {
    if (profile === this.profile) return;
    this.profile = profile;
    if (profile === null) this.profileHover = null;
    this.render();
  }

  /** Fits the camera to the route ahead of the selected train, as soon as the route is known. */
  showRoute(): void {
    this.moment.routeRequested();
    this.follow.showRoute(this.selectedFrame(), this.route);
  }

  setMapStyle(style: MapStyleKind): void {
    this.relief.setStyle(style);
    const theme = themeForStyle(style);
    if (theme !== this.theme) {
      this.theme = theme;
      this.client.setPalette(trainPalette(theme));
      this.render();
    }
  }

  setTerrain3d(on: boolean): void {
    this.relief.setTerrain3d(on);
  }

  setBuildings(on: boolean): void {
    this.look.update({ buildings: on });
  }

  setLabelLanguage(language: string): void {
    this.look.update({ labelLanguage: language });
  }

  focusLand(code: LandCode | null): Promise<void> {
    return focusLand(this.look, this.focusCamera, code);
  }

  get maplibre(): MapLibreMap {
    return this.map;
  }

  /** Development check (gerlinesCheck): the selected train's place and whether its cars are drawn. */
  checkSnapshot(): CheckSnapshot | null {
    return snapshotOf(this.selectedFrame(), this.latest?.cars);
  }

  /** Development probes of the live worker: continuity of the drawn frames and its counters. */
  continuity(
    action: "start" | "report" | "stop",
    sample?: number,
  ): Promise<ContinuityTotals | null> {
    return this.client.continuity(action, sample);
  }

  /** Starts, steers or ends the playback of a past hour. */
  playback(command: PlaybackCommand): void {
    this.client.playback(command);
  }

  /** Development probe: the trains of the latest frame by id and position, nearest to `near` first. */
  trainsNear(near: readonly [number, number], limit: number): ProbedTrain[] {
    return nearestTrains(this.latest?.groups ?? [], this.ids, near, limit);
  }

  diagnostics(): Promise<LiveDiagnostics> {
    return this.client.diagnostics();
  }

  setHiddenCategories(hidden: readonly CategoryKey[]): void {
    this.hiddenCategories = hidden;
    this.client.setHiddenCategories(hidden);
  }

  setHiddenOperatorGroups(hidden: readonly OperatorGroup[]): void {
    this.hiddenOperatorGroups = hidden;
    this.client.setHiddenOperatorGroups(hidden);
  }

  setLabelMode(mode: LabelMode): void {
    this.labelMode = mode;
    if (mode === "off") {
      this.labels = [undefined, undefined];
      this.labelItemList = [];
    }
    this.client.setLabelMode(mode);
    this.render();
  }

  setColourMode(mode: ColourMode): void {
    this.colourMode = mode;
    this.client.setColourMode(mode);
  }

  zoomBy(delta: number): void {
    this.zoomRequested = true;
    this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: this.flightMs(300) });
  }

  /** The shown trains nearest the middle of the map and how many are in view, from the worker. */
  async nearestTrains(count: number): Promise<{ centre: Place; result: NearestTrains }> {
    const centre = this.map.getCenter();
    const container = this.map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    const corners: readonly (readonly [number, number])[] = [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ];
    const result = await this.client.nearest({
      lon: centre.lng,
      lat: centre.lat,
      count,
      area: corners.map(([x, y]) => {
        const point = this.map.unproject([x, y]);
        return [point.lng, Math.max(-85, Math.min(85, point.lat))] as const;
      }),
    });
    return { centre: { lon: centre.lng, lat: centre.lat }, result };
  }

  dispose(): void {
    this.disposed = true;
    this.look.dispose();
    for (const type of INTERACTION_EVENTS) {
      this.options.container.removeEventListener(type, this.onUserInput);
    }
    this.options.container.removeEventListener("pointerdown", this.onPointerDown);
    this.options.container.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.reducedMotion.removeEventListener("change", this.onReducedMotion);
    this.stopWatchingPhone();
    this.softBounds.detach();
    cancelAnimationFrame(this.frameRequest);
    this.cancelCarLoad?.();
    this.client.terminate();
    this.map.remove();
  }

  private readonly focusCamera = {
    fitGermany: () => this.fitView(GERMANY_BOUNDS),
    fitLand: (bounds: readonly [readonly [number, number], readonly [number, number]]) =>
      this.fitView(bounds as [[number, number], [number, number]]),
    alive: () => !this.disposed,
  };

  private fitView(bounds: [[number, number], [number, number]]): void {
    this.softBounds.endGesture();
    this.map.fitBounds(bounds, {
      padding: this.paddingFor(this.selectedId !== null),
      duration: this.flightMs(FOCUS_FLIGHT_MS),
    });
  }

  /** Holds the overview with the left slot open and closed, so opening or closing never clamps it. */
  private hardBoundsForView(): [[number, number], [number, number]] {
    return unionBounds(
      this.hardBoundsFor(this.paddingFor(false, true)),
      this.hardBoundsFor(this.paddingFor(false, false)),
    );
  }

  private hardBoundsFor(padding: ViewPadding): [[number, number], [number, number]] {
    const { clientWidth: width, clientHeight: height } = this.options.container;
    if (width === 0 || height === 0) {
      return hardBounds();
    }
    return hardBounds({ width, height, padding });
  }

  /**
   * The left slot opened or closed. Over the untouched national overview the view eases to the
   * padding of the new state, so a panel never covers western Germany; elsewhere it stays put.
   */
  setLeftSlot(open: boolean, panelOnly: boolean): void {
    this.slotEase.change({
      before: this.paddingFor(false, !open),
      after: this.paddingFor(false, open),
      refit: panelOnly || !open,
      selected: this.selectedId !== null,
    });
  }

  private readonly slotEase = new SlotEase({
    camera: () => ({ center: this.map.getCenter(), zoom: this.map.getZoom() }),
    target: (padding) => {
      const camera = this.map.cameraForBounds(GERMANY_BOUNDS, { padding });
      return camera?.center === undefined || camera.zoom === undefined
        ? undefined
        : { center: LngLat.convert(camera.center), zoom: camera.zoom };
    },
    fit: (padding, duration) => this.map.fitBounds(GERMANY_BOUNDS, { padding, duration }),
    isMoving: () => this.map.isMoving(),
    onceIdle: (callback) => this.map.once("moveend", callback),
    endGesture: () => this.softBounds.endGesture(),
    duration: () => this.flightMs(FOCUS_FLIGHT_MS),
  });

  private paddingFor(withSheet: boolean, slotOpen?: boolean): ViewPadding {
    const { clientWidth, clientHeight } = this.options.container;
    const viewport =
      clientWidth > 0 && clientHeight > 0
        ? { width: clientWidth, height: clientHeight }
        : { width: window.innerWidth, height: window.innerHeight };
    return viewPadding(this.phone.matches, withSheet, {
      ...viewport,
      leftSlotOpen: slotOpen ?? this.options.leftSlotOpen?.() ?? false,
    });
  }

  private selectedPosition(): LngLatLike | null {
    const selected = this.selectedId === null ? undefined : this.latest?.selected;
    return selected ? { lng: selected.lon, lat: selected.lat } : null;
  }

  private flightMs(ms: number): number {
    return this.reducedMotion.matches ? 0 : ms;
  }

  private attachOverlay(): void {
    if (this.disposed) {
      return;
    }
    this.overlay = new MapLibreOverlay({
      interleaved: true,
      layers: [],
      pickingRadius: pickingRadius(this.phone.matches),
      onClick: (info: PickInfo) => {
        if (this.hoverProfile(info, 0)) return;
        this.pick(info);
      },
      onHover: (info: PickInfo) => {
        this.map.getCanvas().style.cursor = info.index >= 0 ? "pointer" : "";
        this.hoverProfile(info, HOVER_MOVE_PX);
      },
    });
    this.map.addControl(this.overlay);
    this.startLive();
    this.client.setHiddenCategories(this.hiddenCategories);
    this.client.setHiddenOperatorGroups(this.hiddenOperatorGroups);
    this.client.setColourMode(this.colourMode);
    this.client.setLabelMode(this.labelMode);
    this.options.onZoom(this.map.getZoom());
    this.frameRequest = requestAnimationFrame(this.loop);
  }

  /** Starts the live worker, or takes over the one started before the map code arrived and lets its packs go. */
  private startLive(): void {
    if (this.startedEarly) {
      adoptEarlyWorker(this.client, trainPalette(this.theme), this.reducedMotion.matches);
      return;
    }
    this.client.startLive(trainPalette(this.theme), {
      ...liveConfigOf(
        window.location.search,
        overrideModeOf(window.location.search, import.meta.env.DEV),
      ),
      reducedMotion: this.reducedMotion.matches,
    });
  }

  private readonly onReducedMotion = (): void => {
    this.client.setReducedMotion(this.reducedMotion.matches);
  };

  private readonly onUserInput = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.key === "Tab") {
      return;
    }
    this.options.onInteract();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.follow.pointerDown(event.pointerId);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.follow.pointerUp(event.pointerId);
  };

  private readonly onWheel = (): void => {
    this.follow.wheel();
  };

  private readonly onVisibility = (): void => {
    this.client.setHidden(document.hidden);
  };

  private readonly loop = (): void => {
    this.sendView();
    this.stepDeck();
    if (this.bridges.published !== this.bridgesDrawn) this.render();
    this.client.requestFrame(Date.now());
    this.frameRequest = requestAnimationFrame(this.loop);
  };

  private receiveFrame(
    frame: Frame,
    path: Float32Array | undefined,
    heights: Float32Array | undefined,
    deck: DeckWindows | undefined,
    stops: SelectionStops | undefined,
  ): void {
    if (deck) this.measureDeck(deck);
    frame.groups.forEach((group, index) => {
      if (group.ids) {
        this.ids[index] = group.ids;
        this.labels[index] = group.labels;
        this.labelItemList = labelItems(this.labels);
      }
    });
    const accepted = acceptRoute(
      this.selectedId,
      frame.selected,
      { path, heights, stops },
      this.route,
    );
    this.route = accepted.route;
    if (accepted.report !== undefined) this.options.onRouteStops?.(accepted.report);
    this.latest = frame;
    this.moment.frame(frame.selected ?? null, this.route?.legKey);
    this.follow.frame(
      this.selectedId === null ? null : (frame.selected ?? null),
      this.route,
      this.moment.flightPending,
    );
    const draw =
      this.repaintAlways || this.repaintGate.shouldDraw(frame, this.gateView(), performance.now());
    if (draw && !this.render()) this.repaintGate.forget();
  }

  private gateView(): GateView {
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    const canvas = this.map.getCanvas();
    const padding = this.map.getPadding();
    return {
      zoom,
      lng: center.lng,
      lat: center.lat,
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
      chevronPixels: chevronOpacity(zoom) > 0 ? chevronPixels(zoom) : 0,
      nearScale: this.nearRowScale(center.lat, zoom),
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      padding: `${padding.top},${padding.right},${padding.bottom},${padding.left}`,
    };
  }

  /** How much finer the bottom row of a pitched view resolves the ground than the centre, terrain included. */
  private nearRowScale(latitude: number, zoom: number): number {
    if (this.map.getPitch() === 0) return 1;
    const { clientWidth: width, clientHeight: height } = this.map.getCanvas();
    const left = this.map.unproject([width / 2, height - 1]);
    const right = this.map.unproject([width / 2 + 1, height - 1]);
    const centre =
      (EARTH_CIRCUMFERENCE_M * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom);
    return nearScale(centre, left.distanceTo(right));
  }

  /**
   * Starts finding the stretches of the track windows that run high above the relief. Only the DEM
   * of the tile drawn at a place counts: until it loads the segment stays unmeasured and the next
   * idle measures it again. Segments off screen are skipped, and `stepDeck` spends a budget of
   * lookups per frame on the rest, so a new deck never stalls one frame.
   */
  private measureDeck(deck: DeckWindows | undefined = this.deckWindows): void {
    this.deckWindows = deck;
    this.deckRetry.settled();
    if (!deck || deck.counts.length === 0 || !this.look.current.terrain3d) {
      this.bridges.clear();
      return;
    }
    const bounds = this.map.getBounds();
    this.bridges.begin(deck, {
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    });
    this.stepDeck();
  }

  private stepDeck(): void {
    if (!this.bridges.pending) return;
    this.bridges.step(
      (lon, lat) => this.map.terrain?.getDrawnElevationForLngLat(new LngLat(lon, lat), true),
      DECK_LOOKUPS_PER_FRAME,
    );
  }

  private selectedFrame(): SelectedFrame | null {
    return this.selectedId === null ? null : (this.latest?.selected ?? null);
  }

  private followMap(): FollowMap {
    return {
      jumpTo: (options) => this.map.jumpTo(options),
      easeTo: (options) => this.map.easeTo(options as EaseToOptions),
      setPadding: (padding) => this.map.setPadding(padding),
      cameraForBounds: (bounds, options) => this.map.cameraForBounds(bounds, options),
      isMoving: () => this.map.isMoving(),
      getZoom: () => this.map.getZoom(),
      onceMoveEnd: (callback) => {
        this.map.once("moveend", callback);
      },
    };
  }

  private signatureMap(): SignatureMap {
    return {
      getCenter: () => this.map.getCenter(),
      getZoom: () => this.map.getZoom(),
      getPitch: () => this.map.getPitch(),
      setMaxPitch: (pitch) => this.map.setMaxPitch(pitch),
      jumpTo: (options) => this.map.jumpTo(options),
      easeTo: (options) => this.map.easeTo(options as EaseToOptions),
      flyTo: (options) => this.map.flyTo(options as FlyToOptions),
      onceMoveEnd: (callback) => {
        this.map.once("moveend", callback);
      },
    };
  }

  /** The view the worker chooses and places cars for, sent when it changes. */
  private sendView(): void {
    const zoom = this.map.getZoom();
    if (!this.carsRequested && zoom >= CAR_LOAD_ZOOM) {
      this.carsRequested = true;
      this.cancelCarLoad = loadWithRetry(
        () => this.cars.load(),
        (manifest) => this.client.setCarCatalog(manifest),
        (error, attempt, delayMs) =>
          warnCars(
            `train models failed to load (attempt ${attempt}), retrying in ${delayMs} ms`,
            error,
          ),
      );
    }
    const center = this.map.getCenter();
    const canvas = this.map.getCanvas();
    const metresPerPixel =
      (EARTH_CIRCUMFERENCE_M * Math.cos((center.lat * Math.PI) / 180)) / (512 * 2 ** zoom);
    const halfDiagonal = (Math.hypot(canvas.clientWidth, canvas.clientHeight) / 2) * metresPerPixel;
    const ready = this.cars.ready();
    const box = this.carCull ? this.map.getBounds() : undefined;
    const bounds = box && ([box.getWest(), box.getSouth(), box.getEast(), box.getNorth()] as const);
    const pitch = Math.round(this.map.getPitch());
    const key = `${zoom.toFixed(3)} ${center.lng.toFixed(6)} ${center.lat.toFixed(6)} ${pitch} ${halfDiagonal.toFixed(0)} ${this.theme} ${ready.length} ${bounds?.map((v) => v.toFixed(6)).join(" ")}`;
    if (key === this.viewSent) return;
    this.viewSent = key;
    this.client.setView({
      zoom,
      lon: center.lng,
      lat: center.lat,
      pitch,
      radiusM: this.carRadiusM ?? halfDiagonal * VIEW_MARGIN,
      fineRadiusM: halfDiagonal,
      ...(bounds ? { bounds } : {}),
      ready,
      selection: hexToRgb(colorValue("primary", this.theme)),
    });
  }

  /** Pushes the latest frame into the layers; false when there is nothing to draw it with yet. */
  private render(): boolean {
    const frame = this.latest;
    if (!(frame && this.overlay)) {
      return false;
    }
    const { selected } = frame;
    const lift = this.look.current.terrain3d
      ? markerLiftM(this.map.getZoom(), this.map.getCenter().lat, Math.round(this.map.getPitch()))
      : 0;
    const split =
      selected && this.route?.legKey === selected.legKey
        ? this.splitter.split(
            this.route.path,
            this.route.heights,
            selected.vertex,
            selected.lon,
            selected.lat,
            selected.z,
            lift,
          )
        : undefined;
    const route = split && this.moment.drawn(split);
    const labels = this.labelLayers(frame, selected?.id ?? null);
    this.overlay.setProps({
      layers: buildTrainLayers({
        groups: frame.groups,
        selected: route ? selected : null,
        route,
        zoom: this.map.getZoom(),
        theme: this.theme,
        terrain: this.look.current.terrain3d,
        pitched: isPitched(this.map.getPitch()),
        deck: this.drawnBridges(lift),
        routeExtras: this.profileLayerList(selected, route !== undefined, lift),
        iconAtlas: this.atlas,
        carFade: selected ? this.markerFadeOf(frame, selected, lift) : 0,
      })
        .concat(labels.under)
        .concat(this.cars.layers(frame.cars, { outline: this.look.current.style === "satellite" }))
        .concat(labels.top),
    });
    return true;
  }

  private drawnBridges(lift: number): ReturnType<BridgeDeck["data"]> {
    this.bridgesDrawn = this.bridges.published;
    return this.bridges.data(lift);
  }

  /** The opacity the selected train's chevron gives way by: its cars' share, less what the relief buries. */
  private markerFadeOf(frame: Frame, selected: SelectedFrame, lift: number): number {
    const zoom = this.map.getZoom();
    const lat = this.map.getCenter().lat;
    if (selectedMarkerFade(frame.cars, selected.id, zoom, lat) === 0) return 0;
    const terrain = this.map.terrain;
    const cover = selectedCover(
      terrain
        ? (lon, lat2) => terrain.getDrawnElevationForLngLat(new LngLat(lon, lat2), false)
        : undefined,
      selected,
      lift,
      this.look.current.terrain3d,
    );
    return selectedMarkerFade(frame.cars, selected.id, zoom, lat, cover);
  }

  /** Follows the pointer over a profile leg; false when the pick is not a profile leg. */
  private hoverProfile(info: PickInfo, minMovePx: number): boolean {
    const hover = this.profile === null ? null : profileHoverOf(info);
    const held = this.profileHover;
    if (hover === null && held === null) return false;
    if (
      hover !== null &&
      held !== null &&
      hover.leg === held.leg &&
      Math.hypot(hover.x - held.x, hover.y - held.y) < minMovePx
    ) {
      return true;
    }
    this.profileHover = hover;
    this.options.onProfileHover?.(hover);
    this.render();
    return hover !== null;
  }

  private profileLayerList(selected: SelectedFrame | null, drawn: boolean, lift: number): Layer[] {
    const route = this.route;
    if (!(this.profile && selected && drawn && route?.stops)) return [];
    const terrain = this.look.current.terrain3d;
    return this.profileLayers.build({
      overlay: this.profile,
      route: { path: route.path, heights: route.heights, stops: route.stops },
      lift,
      zoom: this.map.getZoom(),
      lat: this.map.getCenter().lat,
      theme: this.theme,
      terrain,
      pitched: terrain || this.map.getPitch() > CURTAIN_MIN_PITCH,
      vertex: selected.vertex,
      hover: this.profileHover?.leg ?? null,
    });
  }

  /** The label layer under the labels of the map, and the selected train's own label for the top group after its marker. */
  private labelLayers(
    frame: Frame,
    selectedId: string | null,
  ): { readonly under: Layer[]; readonly top: Layer[] } {
    if (this.labelMode === "off" || this.map.getZoom() < LABEL_MIN_ZOOM) {
      return { under: [], top: [] };
    }
    this.labelTick += 1;
    const source = { groups: frame.groups, tick: this.labelTick };
    const canvas = this.map.getCanvas();
    const shown = placeLabels(
      this.labelItemList,
      source,
      (lon, lat) => this.map.project([lon, lat]),
      canvas.clientWidth,
      canvas.clientHeight,
    );
    const split = splitSelectedLabel(this.labelItemList, shown, this.ids, selectedId);
    return {
      under: [buildLabelLayer(this.labelItemList, source, split.under, this.theme)],
      top: split.top
        ? [buildLabelLayer([split.top.item], source, Uint8Array.of(1), this.theme, { top: true })]
        : [],
    };
  }

  private pick(info: PickInfo): void {
    const carKey = pickedCarKey(this.latest?.cars, info.layer?.id ?? "", info.index);
    if (carKey !== undefined) {
      this.options.onSelect(liveTrainId(carKey));
      return;
    }
    const group = info.layer?.id.endsWith("night") ? 1 : 0;
    const id = info.index >= 0 ? this.ids[group]?.[info.index] : undefined;
    this.options.onSelect(id ?? null);
  }
}
