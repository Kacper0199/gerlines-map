import type { PlaybackState } from "../live/playback/driver.ts";
import type { DeckWindows } from "../map/terrain/deck-windows.ts";
import type { ColourMode } from "../modes/colour-mode.ts";
import type { DelayClass } from "../modes/delay.ts";
import type { LabelMode } from "../modes/label-mode.ts";
import type { OperatorGroup } from "../modes/operator-groups.ts";
import type { CategoryKey } from "./categories.ts";
import type { Frame, Palette, Rgb } from "./frame.ts";

export type DataState = "loading" | "live" | "recorded" | "stale" | "error";

export const ERROR_CODES = [
  "upstream_unavailable",
  "unreachable",
  "unreadable",
  "server_error",
  "no_live_server",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface DataStatus {
  readonly state: DataState;
  readonly dataTimeMs: number | undefined;
  readonly trips: number;
  readonly realtime: number;
  readonly untracked: number;
  readonly counts: Readonly<Record<CategoryKey, number>>;
  /** Trains per delay class (live trains only), for the legend of the delay colour mode. */
  readonly delayCounts?: Readonly<Record<DelayClass, number>>;
  /** Trains per operator group (live trains only), for the legend of the operator colour mode. */
  readonly operatorCounts?: Readonly<Record<OperatorGroup, number>>;
  readonly error: ErrorCode | undefined;
  /** False until the first keyframe is applied and its first train is drawn, or no train waits for its track: the counts above are then not yet the trains of a frame. Absent in fixtures, which count as framed. */
  readonly framed?: boolean;
  /** Wall time (epoch ms) of the newest live head that moved the time on; none before one or in a replay. */
  readonly frameWallMs?: number;
  /** Counts the time lines the live source started again (a looping replay, a reset engine); frame keys of an older one may name other trips. */
  readonly timelineEpoch?: number;
}

export interface LiveConfig {
  /** Where `/head`, `/k/<n>.bin`, `/d/<n>.bin` and `/s/<epoch>/<id>.bin` live. */
  readonly baseUrl: string;
  readonly pollMs: number;
  /**
   * The push server's WebSocket (Centrifugo, `live:frames`): with it the head is read when a notice
   * names a new one and polled only while the channel is down. Without it the head is polled.
   */
  readonly pushUrl?: string;
  /** Plan seconds per wall second: 1 live, more for a replay of recorded frames. */
  readonly timeScale: number;
  readonly replay: boolean;
  /** Probe run: the worker records transfer sizes. */
  readonly probe: boolean;
  /** The visitor asks for less motion: a playback seek swaps without a fade. */
  readonly reducedMotion?: boolean;
  /**
   * The worker started before the map code arrived: it reads the head and the keyframe at once and keeps the shape
   * packs queued until `release-packs`, so the packs do not share the link with the map code.
   */
  readonly holdPacks?: boolean;
}

/** What the page asks of a playback of a past hour (ADR-0014). Times are Unix seconds. */
export type PlaybackCommand =
  | {
      readonly action: "start";
      readonly at: number;
      readonly speed: number;
      readonly playing: boolean;
    }
  | { readonly action: "play" }
  | { readonly action: "pause" }
  | { readonly action: "speed"; readonly speed: number }
  | { readonly action: "seek"; readonly at: number }
  | { readonly action: "stop" };

/** What a frame holds about the selected train (stop names come with the train detail). */
export interface LiveSelectionInfo {
  readonly key: number;
  readonly line: string | null;
  readonly trainNumber: number | null;
  readonly category: CategoryKey;
  readonly foreign: boolean;
  readonly realtime: boolean;
  readonly delaySeconds: number | null;
  readonly dataTimeMs: number;
  /**
   * Speed in m/s along the track of the motion plan at the display clock (zero at a stop, in the playback clock's
   * own plan seconds); null when the plan has ended or the train has none to evaluate.
   */
  readonly speedMps: number | null;
}

export interface ContinuityTotals {
  readonly measuredTrains: number;
  readonly frames: number;
  readonly judgedPairs: number;
  readonly jumps: number;
  readonly stalls: number;
  readonly backwardSteps: number;
  readonly visibleSwaps: number;
  readonly overspeedSteps: number;
  readonly offTrackFrames: number;
  readonly maxRatio: number;
  readonly minRatio: number;
  readonly maxSpeed: number;
  readonly maxAcceleration: number;
  readonly maxTrackDistance: number;
}

export interface LiveDiagnostics {
  readonly trains: number;
  readonly waitingForShapes: number;
  readonly withoutShape: number;
  readonly updates: number;
  readonly crossfades: Readonly<Record<string, number>>;
  readonly crossfadeSamples: readonly Readonly<Record<string, number>>[];
  readonly sequence: number | null;
  readonly shapes: {
    readonly loaded: number;
    readonly pending: number;
    readonly inFlight: number;
    readonly missing: number;
  };
  /** Pack sets read (FORMAT.md 4.2) and the shapes they added, absent before the worker starts. */
  readonly packSets?: {
    readonly sets: number;
    readonly shapes: number;
    readonly failures: number;
    readonly failuresByCode: Readonly<Record<string, number>>;
    /** The longest the worker ran without a break while reading sets. */
    readonly longestSliceMs: number;
  };
  readonly bytesFetched: number;
  /** Compressed bytes on the wire (resource timing), null where the environment cannot say. */
  readonly transferredBytes: { readonly frames: number; readonly packs: number } | null;
  readonly objectsFetched: number;
  readonly followErrors: number;
  readonly ticks: number;
  readonly tickMs: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly followMs: {
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
    readonly count: number;
  };
  /** Plan seconds between a frame's publication time and its application (excluding reloads). */
  readonly applyLagS: {
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
    readonly count: number;
  };
  readonly displayLagS: number;
  /** Trains drawn as 3D cars and car plus bogie instances in the last frame. */
  readonly cars: {
    readonly trains: number;
    readonly instances: number;
    readonly layers: number;
    /** Slots in the merged fleet arrays (the instances plus the room between the meshes). */
    readonly slots: number;
    /** Mesh slots that moved since the first car frame; a moved slot makes luma build a pipeline. */
    readonly slotMoves: number;
  };
  readonly planTime: number | null;
  readonly timeScale: number;
  /** The push channel of head notices, null when the page has none (a replay, or no push server). */
  readonly push: {
    readonly up: boolean;
    readonly silent: boolean;
    readonly notices: number;
    readonly connects: number;
  } | null;
  /** Heads read, and how many of them a push notice asked for. */
  readonly headReads: { readonly total: number; readonly onNotice: number };
}

/** What the worker needs of the map view to choose and place 3D cars. */
export interface CarViewInput {
  readonly zoom: number;
  readonly lon: number;
  readonly lat: number;
  /** Tilt of the map in degrees; markers on the relief rise higher in a tilted view. */
  readonly pitch?: number;
  /** Ground metres from the centre within which trains are drawn as cars. */
  readonly radiusM: number;
  /** Ground metres beyond which cars take one coarser level of detail. */
  readonly fineRadiusM: number;
  /** Ground the screen shows, degrees (west, south, east, north); trains outside it are not placed. */
  readonly bounds?: readonly [number, number, number, number];
  /** Meshes the page has loaded (`mesh@lod`). */
  readonly ready: readonly string[];
  /** Mode band colour of the selected train. */
  readonly selection: Rgb;
}

/** The shown trains nearest a point; `area` is the polygon of the screen on the ground (longitude and latitude corners) that limits what counts as in view. */
export interface NearestRequest {
  readonly lon: number;
  readonly lat: number;
  readonly count: number;
  readonly area?: readonly (readonly [number, number])[];
}

/** A train of the nearest list, with what its row shows and the selection id its card opens by. */
export interface NearTrain {
  readonly key: number;
  readonly id: string;
  readonly line: string | null;
  readonly trainNumber: number | null;
  readonly category: CategoryKey;
  readonly foreign: boolean;
  readonly delaySeconds: number | null;
  readonly lon: number;
  readonly lat: number;
  readonly distanceM: number;
}

export interface NearestTrains {
  /** Shown trains inside the request's area (all shown trains without one). */
  readonly inView: number;
  readonly trains: readonly NearTrain[];
}

export type WorkerRequest =
  | { readonly type: "init-live"; readonly palette: Palette; readonly config: LiveConfig }
  | {
      readonly type: "continuity";
      readonly action: "start" | "report" | "stop";
      readonly sample?: number;
    }
  | { readonly type: "release-packs" }
  | { readonly type: "diagnostics" }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "select"; readonly id: string | null }
  | { readonly type: "palette"; readonly palette: Palette }
  | { readonly type: "categories"; readonly hidden: readonly CategoryKey[] }
  | { readonly type: "operator-groups"; readonly hidden: readonly OperatorGroup[] }
  | { readonly type: "colour-mode"; readonly mode: ColourMode }
  | { readonly type: "label-mode"; readonly mode: LabelMode }
  | { readonly type: "visibility"; readonly hidden: boolean }
  | { readonly type: "car-catalog"; readonly manifest: unknown }
  | { readonly type: "elevation"; readonly scale: number }
  | { readonly type: "view"; readonly view: CarViewInput }
  | { readonly type: "playback"; readonly command: PlaybackCommand }
  | { readonly type: "nearest"; readonly id: number; readonly request: NearestRequest }
  | { readonly type: "reduced-motion"; readonly reduced: boolean };

/**
 * The stops of the selected trip on its drawn route. `vertices` holds every stop of the shape's stop list as a
 * fractional vertex index of `selectionPath`; the other arrays describe the stops the frame still holds, the ones
 * ahead, which start at stop `firstStop` of that list. Times are Unix seconds, NaN where unknown.
 */
export interface SelectionStops {
  readonly vertices: Float32Array;
  readonly firstStop: number;
  readonly arrivals: Float64Array;
  readonly departures: Float64Array;
  readonly cancelled: Uint8Array;
}

export interface FrameMessage {
  readonly type: "frame";
  readonly frame: Frame;
  readonly selectionPath: Float32Array | undefined;
  /** Height of each vertex of `selectionPath` on the relief, metres; sent with it, undefined on a flat map. */
  readonly selectionHeights?: Float32Array | undefined;
  /** Where the stops of the selected trip lie on `selectionPath` and the times the worker holds for them; sent with the path and again when the times change. */
  readonly selectionStops?: SelectionStops | undefined;
  /** The track around the trains in view at its drawn height, now and then; empty to clear it. */
  readonly deck?: DeckWindows | undefined;
}

export interface StatusMessage {
  readonly type: "status";
  readonly status: DataStatus;
}

export interface LiveSelectionMessage {
  readonly type: "live-selection";
  readonly info: LiveSelectionInfo | null;
}

/** Whether the selected train has a frame on the map (a train waiting for its track has none). */
export interface SelectionDrawnMessage {
  readonly type: "selection-drawn";
  readonly key: number;
  readonly drawn: boolean;
}

export interface ContinuityMessage {
  readonly type: "continuity";
  readonly report: ContinuityTotals | null;
}

export interface DiagnosticsMessage {
  readonly type: "diagnostics";
  readonly data: LiveDiagnostics;
}

/** The state of the playback, null once it is over and the live source runs again. */
export interface PlaybackMessage {
  readonly type: "playback";
  readonly state: PlaybackState | null;
}

/** The answer to a `nearest` request, matched by `id`. */
export interface NearestMessage {
  readonly type: "nearest-trains";
  readonly id: number;
  readonly result: NearestTrains;
}

export type WorkerMessage =
  | NearestMessage
  | PlaybackMessage
  | FrameMessage
  | StatusMessage
  | LiveSelectionMessage
  | SelectionDrawnMessage
  | ContinuityMessage
  | DiagnosticsMessage;
