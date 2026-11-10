import { DEFAULT_CONTROLLER, lonLatToMercator } from "@gerlines/geo";
import { decodeHead, FrameDecodeError, type Head } from "@gerlines/live-frame";
import { type CarFrame, type CarView, carFade } from "../cars/car-instances.ts";
import { type CarCatalog, parseCatalog } from "../cars/catalog.ts";
import { FleetMerger } from "../cars/fleet.ts";
import { carBuffers, carsOnTheWire } from "../cars/wire.ts";
import {
  DECK_MIN_ZOOM,
  type DeckBox,
  DeckSchedule,
  type DeckWindows,
  emptyDeck,
} from "../map/terrain/deck-windows.ts";
import { type Elevation, markerLiftM, terrainElevation } from "../map/terrain/elevation.ts";
import type { ColourMode } from "../modes/colour-mode.ts";
import type { LabelMode } from "../modes/label-mode.ts";
import type { OperatorGroup } from "../modes/operator-groups.ts";
import type { CategoryKey } from "../motion/categories.ts";
import type { Frame, Palette } from "../motion/frame.ts";
import type {
  CarViewInput,
  DataState,
  DataStatus,
  ErrorCode,
  LiveConfig,
  LiveDiagnostics,
  LiveSelectionInfo,
  SelectionStops,
  WorkerMessage,
  WorkerRequest,
} from "../motion/protocol.ts";
import { ChainError, ChainFollower } from "./chain.ts";
import { ContinuityProbe } from "./continuity-probe.ts";
import { LiveTrains, type SelectedRoute } from "./live-trains.ts";
import { nearestTrains } from "./nearest-trains.ts";
import { PackSetLoader } from "./pack-sets.ts";
import { PlanClock, RESTART_AFTER_S } from "./plan-clock.ts";
import { PlaybackController } from "./playback/controller.ts";
import { type FrameNotice, PushChannel, type PushSocket } from "./push-channel.ts";
import { Samples } from "./samples.ts";
import { ScheduledChanges } from "./schedule.ts";
import { ShapeStore } from "./shape-store.ts";
import { liveKeyOf } from "./train-ids.ts";

export const STALE_AFTER_MS = 180_000;
const RETRY_AFTER_CHAIN_ERROR_MS = 1_000;
const STATUS_EVERY_MS = 1_000;
const SELECTION_EVERY_MS = 1_000;
const STOPS_CHECK_EVERY_MS = 2_000;
/** A head's time is a whole second, the floor of the server's clock: its middle is half a second on. */
const HEAD_TIME_CENTRE_S = 0.5;
/**
 * The display runs behind the newest head so that the frames of the next head are still ahead of the
 * display when that head arrives, and each can be applied exactly at its time (schedule.ts). Wall
 * seconds of that gap: one poll interval plus one and a half times the slowest recent cycle (head and
 * frames fetched), never under MIN_LAG_WALL_S; the lag in plan seconds is that times the time scale.
 */
const MIN_LAG_WALL_S = 1.5;
const CYCLE_MEMORY = 8;
const MAX_HOLD_MS = 5_000;
/** A playback fade is only visual: plans are never faded for longer than this, however slow the fleet. */
const NO_FADE_SECONDS = 1e-6;
const NO_FADES = {
  ...DEFAULT_CONTROLLER,
  fadeOutDuration: NO_FADE_SECONDS,
  fadeInDuration: NO_FADE_SECONDS,
};
const ERROR_AFTER_FAILURES = 2;
/** While push notices arrive, the head is still read after this long without one (a quiet or silent channel). */
export const SAFETY_POLL_MS = 10_000;
/** A head older than the notice that asked for it (an edge cache) is read again this soon, a few times. */
export const STALE_HEAD_RETRY_MS = 250;
const STALE_HEAD_RETRIES = 4;
/** A head served as a web page comes from a page server without a live engine behind it (Vite's fallback). */
const WEB_PAGE = /^\s*text\/html\b/i;

export interface LiveEnvironment {
  now(): number;
  perf(): number;
  /** Bytes on the wire so far for frames (head, keyframes, deltas) and for shape packs. */
  transferred?(): { frames: number; packs: number } | null;
  /** Starts recording transfer sizes (resource timing); only for probe runs, it keeps entries. */
  measureTransfer?(): void;
  post(message: WorkerMessage, transfer: Transferable[]): void;
  fetch(
    url: string,
    init?: { cache?: "no-store"; method?: "HEAD"; signal?: AbortSignal },
  ): Promise<Response>;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** A WebSocket to the push server; without it the head is polled. */
  openSocket?(url: string): PushSocket;
  random?(): number;
}

type PollTrigger = "start" | "timer" | "notice";

export interface LiveRuntime {
  handle(message: WorkerRequest): void;
}

function packSetCounts(loader: PackSetLoader, store: ShapeStore | undefined) {
  const { sets, shapes, failures, failuresByCode } = loader.stats();
  const longestSliceMs = Math.round((store?.longestSetSliceMs ?? 0) * 10) / 10;
  return { sets, shapes, failures, failuresByCode, longestSliceMs };
}

/** Request deadlines: a stalled stream fails and is retried instead of holding a slot. */
export const HEAD_TIMEOUT_MS = 10_000;
export const OBJECT_TIMEOUT_MS = 30_000;
export const PACK_TIMEOUT_MS = 20_000;

function deadline(ms: number): { signal?: AbortSignal } {
  return typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(ms) } : {};
}

function untrackedOf(head: Head | undefined): number | undefined {
  const row = head?.counts?.find(
    (count) => count.metric === "untracked" && count.category === null,
  );
  return row?.count;
}

export function createLiveRuntime(environment: LiveEnvironment): LiveRuntime {
  let config: LiveConfig | undefined;
  let clock = new PlanClock(1);
  let follower: ChainFollower | undefined;
  let shapes: ShapeStore | undefined;
  let packSets: PackSetLoader | undefined;
  let trains: LiveTrains | undefined;
  let probe: ContinuityProbe | undefined;
  const liveSchedule = new ScheduledChanges(MAX_HOLD_MS);
  const playbackSchedule = new ScheduledChanges(Number.POSITIVE_INFINITY);
  let schedule = liveSchedule;
  let livePaused = false;
  let palette: Palette | undefined;
  let hiddenCategories: readonly CategoryKey[] = [];
  let pollTimer: number | undefined;
  let polling = false;
  let hidden = false;
  let colourMode: ColourMode = "category";
  let hiddenOperatorGroups: readonly OperatorGroup[] = [];
  let labelMode: LabelMode = "off";
  let elevationScale = 0;
  const deckSchedule = new DeckSchedule();
  let deckActive = false;
  let lastHead: Head | undefined;
  let lastAdvanceWall = 0;
  let error: ErrorCode | undefined;
  let selectedKey: number | null = null;
  let timelineRestarting = false;
  let keyframeApplied = false;
  let chainErrorsWithoutKeyframe = 0;
  let drawnSent: boolean | null = null;
  let timelineEpoch = 0;
  let behindSeen = false;
  let pathKeySent: string | undefined;
  let stopsKeySent: string | undefined;
  let stopsCheckedAt = Number.NEGATIVE_INFINITY;
  let selectionSentAt = Number.NEGATIVE_INFINITY;
  let selectionSent: LiveSelectionInfo | null = null;
  let statusSentAt = Number.NEGATIVE_INFINITY;
  let bytesFetched = 0;
  let objectsFetched = 0;
  let followErrors = 0;
  let ticks = 0;
  let idsVersionSent = -1;
  let carCatalog: CarCatalog | undefined;
  let carCounts = { trains: 0, instances: 0, layers: 0, slots: 0, slotMoves: 0 };
  const fleetMerger = new FleetMerger();
  let carView:
    | { view: CarView; lat: number; pitch: number; selection: CarViewInput["selection"] }
    | undefined;
  const tickMs = new Samples();
  const followMs = new Samples();
  const applyLagS = new Samples();
  const cycles: number[] = [];
  let failures = 0;
  let push: PushChannel | undefined;
  let pushSilent = false;
  let noticedSequence = -1;
  let wanted: FrameNotice | undefined;
  let staleRetries = 0;
  let pendingTrigger: PollTrigger | undefined;
  let headReads = 0;
  let noticeReads = 0;

  /** Plan time in Unix seconds: the playback's virtual clock while its trains are on screen, else the live clock. */
  function planTime(wall: number): number | null {
    return playback.position() ?? clock.now(wall);
  }

  function dataState(wall: number): DataState {
    if (playback.active) return keyframeApplied && !timelineRestarting ? "recorded" : "loading";
    if (error !== undefined) return "error";
    if (lastHead === undefined || !keyframeApplied || timelineRestarting) return "loading";
    if (wall - lastAdvanceWall > STALE_AFTER_MS) return "stale";
    return config?.replay ? "recorded" : "live";
  }

  /** Counts are the trains of a frame once one is drawn, or when none waits for its track (an empty network). */
  function firstTrainsDrawn(): boolean {
    return (trains?.size ?? 0) > 0 || (trains?.waitingCount ?? 0) === 0;
  }

  function publishStatus(): void {
    const wall = environment.now();
    statusSentAt = wall;
    const stats = trains?.stats();
    const planNow = planTime(wall);
    const state = dataState(wall);
    const untracked = untrackedOf(lastHead) ?? stats?.untracked ?? 0;
    const status: DataStatus = {
      state,
      dataTimeMs: planNow === null ? undefined : Math.floor(planNow * 1000),
      trips: stats?.trips ?? 0,
      realtime: stats?.realtime ?? 0,
      untracked,
      counts: stats?.counts ?? { hsr: 0, ld: 0, night: 0, rfast: 0, reg: 0, sbahn: 0, foreign: 0 },
      ...(stats?.delayCounts ? { delayCounts: stats.delayCounts } : {}),
      ...(stats?.operatorCounts ? { operatorCounts: stats.operatorCounts } : {}),
      error,
      framed: keyframeApplied && !timelineRestarting && firstTrainsDrawn(),
      timelineEpoch,
      ...(lastHead !== undefined && !config?.replay ? { frameWallMs: lastAdvanceWall } : {}),
    };
    environment.post({ type: "status", status }, []);
  }

  async function read(path: string): Promise<Uint8Array | null> {
    const response = await environment.fetch(
      `${config?.baseUrl ?? ""}/${path}`,
      deadline(OBJECT_TIMEOUT_MS),
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    bytesFetched += bytes.length;
    objectsFetched++;
    return bytes;
  }

  function errorCodeOf(failure: unknown, status?: number): ErrorCode {
    if (failure instanceof FrameDecodeError) return "unreadable";
    if (status === 404 || status === 503) return "upstream_unavailable";
    if (status !== undefined && status >= 500) return "server_error";
    return "unreachable";
  }

  async function readHead(): Promise<Head | null> {
    headReads++;
    const response = await environment.fetch(`${config?.baseUrl ?? ""}/head`, {
      cache: "no-store",
      ...deadline(HEAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      error = errorCodeOf(null, response.status);
      return null;
    }
    if (WEB_PAGE.test(response.headers.get("Content-Type") ?? "")) {
      error = "no_live_server";
      return null;
    }
    return decodeHead(new Uint8Array(await response.arrayBuffer()));
  }

  function displayLagS(): number {
    const slowest = cycles.length === 0 ? 0 : Math.max(...cycles);
    const wallS = Math.max(
      MIN_LAG_WALL_S,
      (config?.pollMs ?? 1000) / 1000 + (1.5 * slowest) / 1000,
    );
    return HEAD_TIME_CENTRE_S + wallS * (config?.timeScale ?? 1);
  }

  /**
   * A head whose time did not move (the server or an edge stalled) says nothing new about time, so
   * the clock keeps running and the data goes stale; one that moves, forward or back, is observed.
   */
  function observeHead(head: Head, wall: number): void {
    const moved = lastHead === undefined || head.timeBase !== lastHead.timeBase;
    if (moved && clock.observe(head.timeBase + HEAD_TIME_CENTRE_S - displayLagS(), wall)) {
      restartTimeline();
    }
    if (lastHead === undefined || head.timeBase > lastHead.timeBase) lastAdvanceWall = wall;
    lastHead = head;
  }

  /**
   * A head far behind the one before it is one of two things: a looping replay or a reset engine,
   * which the next head confirms by being behind too, or another edge answering with an old head,
   * which the next head contradicts. The first such head is skipped, so the second decides.
   */
  function isDoubtfulBackJump(head: Head): boolean {
    const scale = config?.timeScale ?? 1;
    const behind =
      lastHead !== undefined && lastHead.timeBase - head.timeBase > RESTART_AFTER_S * scale;
    if (!behind) {
      behindSeen = false;
      return false;
    }
    if (behindSeen) return false;
    behindSeen = true;
    return true;
  }

  /** Follows the head; true when a reload of the keyframe came with it (the join cycle). */
  async function followHead(head: Head): Promise<boolean> {
    if (livePaused || isDoubtfulBackJump(head)) return false;
    behindSeen = false;
    const wall = environment.now();
    observeHead(head, wall);
    const chain = follower as ChainFollower;
    const started = environment.perf();
    const steps = await chain.followSteps(head);
    if (livePaused) return false;
    if (steps.length > 0) followMs.add(environment.perf() - started);
    for (const step of steps) schedule.push(step, environment.now());
    applyDue();
    failures = 0;
    error = undefined;
    return steps.some((step) => step.reloaded);
  }

  /** Applies the frames whose time the display clock has reached (a reload is due at once). */
  function applyDue(): void {
    const wall = environment.now();
    const planNow = planTime(wall);
    if (planNow === null || !trains) return;
    for (const entry of schedule.due(planNow, wall)) {
      if (entry.changes.reloaded) {
        timelineRestarting = false;
        keyframeApplied = true;
      } else applyLagS.add(Math.max(0, planNow - entry.changes.time));
      trains.apply(entry.changes, planNow);
      if (playback.engaged) playback.frameApplied(entry.changes.reloaded);
    }
  }

  /** The server's time went another way (a replay looped): the trains of the old time line go. */
  function restartTimeline(): void {
    timelineRestarting = true;
    timelineEpoch++;
    follower?.reset();
    schedule.reset();
    trains?.clear();
    idsVersionSent = -1;
  }

  /** The delay before the next poll after a failure (a broken chain is read again at once). */
  function failedPoll(failure: unknown, pollMs: number): number {
    if (failure instanceof ChainError) {
      followErrors++;
      chainErrorsWithoutKeyframe =
        keyframeApplied && !timelineRestarting ? 0 : chainErrorsWithoutKeyframe + 1;
      error = chainErrorsWithoutKeyframe >= ERROR_AFTER_FAILURES ? "unreadable" : undefined;
      return RETRY_AFTER_CHAIN_ERROR_MS;
    }
    failures++;
    if (failure instanceof FrameDecodeError || failures >= ERROR_AFTER_FAILURES) {
      error = errorCodeOf(failure);
    }
    return pollMs;
  }

  /** Notices arrive and none was found missing: the head waits for the next notice. */
  function pushDelivering(): boolean {
    return push?.up === true && !pushSilent;
  }

  /**
   * A head read by the safety timer that names frames no notice announced shows a channel that is
   * up but silent (the engine sends no notices): the head is polled again until a notice arrives.
   */
  function checkDelivery(trigger: PollTrigger, before: number | undefined, head: Head): void {
    const announced = head.sequence <= noticedSequence || head.sequence === before;
    if (trigger === "timer" && pushDelivering() && !announced) pushSilent = true;
  }

  /**
   * The wait after a successful read: the poll interval without working push, else at once when
   * the channel came up or a notice came during the read, soon while the head is still behind its
   * notice, and the safety interval otherwise.
   */
  function nextDelay(pollMs: number): number {
    const pending = pendingTrigger;
    pendingTrigger = undefined;
    if (wanted && (lastHead?.sequence ?? -1) >= wanted.seq) wanted = undefined;
    if (!pushDelivering()) {
      wanted = undefined;
      return pollMs;
    }
    if (pending === "start" || (pending === "notice" && wanted)) return 0;
    if (wanted && staleRetries < STALE_HEAD_RETRIES) {
      staleRetries++;
      return STALE_HEAD_RETRY_MS;
    }
    wanted = undefined;
    return SAFETY_POLL_MS;
  }

  /** Starts the pack sets the head names before its frames, so their shapes come first. */
  function offerPackSets(head: Head): void {
    if (!follower) return;
    packSets?.offer(head, follower.sequence === null ? null : follower.shapeEpoch);
  }

  async function readAndFollow(trigger: PollTrigger): Promise<void> {
    const started = environment.now();
    const before = lastHead?.sequence;
    if (trigger === "notice") noticeReads++;
    const head = await readHead();
    if (head) offerPackSets(head);
    const reloaded = head !== null && (await followHead(head));
    if (head) checkDelivery(trigger, before, head);
    if (!reloaded) {
      cycles.push(environment.now() - started);
      if (cycles.length > CYCLE_MEMORY) cycles.shift();
    }
  }

  async function poll(trigger: PollTrigger = "timer"): Promise<void> {
    polling = true;
    let delay = config?.pollMs ?? 1000;
    let failed = false;
    try {
      await readAndFollow(trigger);
    } catch (failure) {
      failed = true;
      delay = failedPoll(failure, delay);
    } finally {
      polling = false;
      publishStatus();
      if (!failed) delay = nextDelay(delay);
      schedulePoll(delay);
    }
  }

  function schedulePoll(delay: number): void {
    if (pollTimer !== undefined) environment.clearTimeout(pollTimer);
    pollTimer = hidden || livePaused ? undefined : environment.setTimeout(() => void poll(), delay);
  }

  /** Reads the head now, or right after the read in flight. */
  function pollNow(trigger: PollTrigger): void {
    if (hidden || livePaused || !config) return;
    if (polling) {
      if (pendingTrigger !== "start") pendingTrigger = trigger;
      return;
    }
    if (pollTimer !== undefined) environment.clearTimeout(pollTimer);
    pollTimer = undefined;
    void poll(trigger);
  }

  function onNotice(notice: FrameNotice): void {
    pushSilent = false;
    noticedSequence = Math.max(noticedSequence, notice.seq);
    const held =
      lastHead !== undefined &&
      lastHead.sequence === notice.seq &&
      lastHead.keyframeSequence === notice.keyframe &&
      lastHead.timetableVersion === notice.tv;
    if (held) return;
    wanted = notice;
    staleRetries = 0;
    pollNow("notice");
  }

  /** Up: the head is read at once (notices may have been missed); down: polling resumes. */
  function onPushState(up: boolean): void {
    pushSilent = false;
    if (up) {
      pollNow("start");
      return;
    }
    if (!(polling || hidden || livePaused || pollTimer === undefined)) {
      schedulePoll(config?.pollMs ?? 1000);
    }
  }

  function startPush(): void {
    if (!(config?.pushUrl && environment.openSocket)) return;
    const open = environment.openSocket.bind(environment);
    push ??= new PushChannel(
      {
        open,
        setTimeout: (callback, ms) => environment.setTimeout(callback, ms),
        clearTimeout: (id) => environment.clearTimeout(id),
        random: () => environment.random?.() ?? Math.random(),
        now: () => environment.now(),
      },
      config.pushUrl,
      { notice: onNotice, state: onPushState },
    );
    push.start();
  }

  /** New trains with the current settings; without fades the fleet cuts instead of blending. */
  function makeTrains(noFades: boolean): void {
    if (!(shapes && palette)) return;
    trains?.clear();
    trains = new LiveTrains(shapes, palette, noFades ? NO_FADES : undefined);
    trains.setTimeScale(config?.timeScale ?? 1);
    trains.setColourMode(colourMode);
    trains.setHiddenOperatorGroups(hiddenOperatorGroups);
    trains.setLabelMode(labelMode);
    trains.setHiddenCategories(hiddenCategories);
    trains.setElevation(currentElevation());
    trains.select(selectedKey);
    idsVersionSent = -1;
  }

  const playback = new PlaybackController({
    environment,
    config: () => config,
    hasTrains: () => (trains?.size ?? 0) > 0,
    enqueue: (steps) => {
      for (const step of steps) schedule.push(step, environment.now());
    },
    clearTrains: () => restartTimeline(),
    setSpeed: (speed) => trains?.setTimeScale(speed),
    setOpacity: (opacity) => trains?.setOpacity(opacity),
    pauseLive: () => {
      livePaused = true;
      schedule = playbackSchedule;
      if (pollTimer !== undefined) environment.clearTimeout(pollTimer);
      pollTimer = undefined;
      push?.stop();
    },
    resumeLive: () => {
      livePaused = false;
      schedule = liveSchedule;
      schedule.reset();
      clock = new PlanClock(config?.timeScale ?? 1);
      follower?.reset();
      lastHead = undefined;
      error = undefined;
      trains?.setTimeScale(config?.timeScale ?? 1);
      if (!hidden) startPush();
      if (!(hidden || polling)) void poll("start");
    },
    freshTrains: makeTrains,
    counted: (bytes) => {
      bytesFetched += bytes;
      objectsFetched++;
    },
  });

  function handleInit(message: Extract<WorkerRequest, { type: "init-live" }>): void {
    config = message.config;
    if (config.probe) environment.measureTransfer?.();
    clock = new PlanClock(config.timeScale);
    follower = new ChainFollower(read);
    liveSchedule.reset();
    shapes = new ShapeStore({
      fetchPack: async (packEpoch, shapeId) => {
        const response = await environment.fetch(
          `${config?.baseUrl ?? ""}/s/${packEpoch}/${shapeId}.bin`,
          deadline(PACK_TIMEOUT_MS),
        );
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`pack ${packEpoch}/${shapeId}: ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        bytesFetched += bytes.length;
        objectsFetched++;
        return bytes;
      },
      onLoaded: (id) => trains?.onShapeLoaded(id, planTime(environment.now()) ?? 0),
      now: () => environment.now(),
      held: config.holdPacks === true,
    });
    packSets = new PackSetLoader({ store: shapes, read });
    palette = message.palette;
    makeTrains(false);
    if (pollTimer !== undefined) environment.clearTimeout(pollTimer);
    push?.stop();
    push = undefined;
    publishStatus();
    if (hidden) return;
    startPush();
    void poll("start");
  }

  function reportDrawn(key: number, drawn: boolean): void {
    if (drawn === drawnSent) return;
    drawnSent = drawn;
    environment.post({ type: "selection-drawn", key, drawn }, []);
  }

  /** A selected train without a frame is kept while its time line loads or its track is awaited. */
  function selectionPending(key: number): boolean {
    return timelineRestarting || !keyframeApplied || trains?.holds(key) === true;
  }

  /** Whether the selected train has a frame is known once its time line is loaded. */
  function reportDrawnWhenKnown(frame: Frame): void {
    if (selectedKey !== null && keyframeApplied && !timelineRestarting) {
      reportDrawn(selectedKey, frame.selected !== null);
    }
  }

  function endSelection(): void {
    selectedKey = null;
    selectionSent = null;
    trains?.select(null);
    environment.post({ type: "live-selection", info: null }, []);
  }

  /** A selected train that waits has no plan to evaluate: its last speed is withdrawn once. */
  function withdrawSpeed(): void {
    if (selectionSent === null || selectionSent.speedMps === null) return;
    selectionSent = { ...selectionSent, speedMps: null };
    environment.post({ type: "live-selection", info: selectionSent }, []);
  }

  function followSelection(frame: Frame, wall: number): SelectedRoute | undefined {
    reportDrawnWhenKnown(frame);
    if (selectedKey !== null && frame.selected === null) {
      pathKeySent = undefined;
      if (selectionPending(selectedKey)) withdrawSpeed();
      else endSelection();
      return undefined;
    }
    const selected = frame.selected;
    if (!selected || !trains) return undefined;
    if (wall - selectionSentAt >= SELECTION_EVERY_MS) publishSelection(wall);
    if (selected.legKey === pathKeySent) return undefined;
    pathKeySent = selected.legKey;
    return trains.selectedRoute() ?? undefined;
  }

  /**
   * The stops go with the route, and again whenever the times the trip holds for them change: a delay moves them,
   * and the card matches them against the detail it has now.
   */
  function stopsToSend(
    frame: Frame,
    route: SelectedRoute | undefined,
    wall: number,
  ): SelectionStops | undefined {
    if (!frame.selected || !trains) {
      stopsKeySent = undefined;
      return undefined;
    }
    if (!route && wall - stopsCheckedAt < STOPS_CHECK_EVERY_MS) return undefined;
    stopsCheckedAt = wall;
    const stops = route ? route.stops : trains.selectedStops();
    const key =
      stops &&
      `${frame.selected.id}|${stops.firstStop}|${stops.arrivals}|${stops.departures}|${stops.cancelled}`;
    if (!route && key === stopsKeySent) return undefined;
    stopsKeySent = key;
    return stops;
  }

  function publishSelection(wall: number): void {
    selectionSentAt = wall;
    const entry = selectedKey === null ? undefined : trains?.entry(selectedKey);
    if (!entry) return;
    const planNow = planTime(wall) ?? 0;
    const info: LiveSelectionInfo = {
      key: entry.key,
      line: entry.trip.line,
      trainNumber: entry.trip.trainNumber,
      category: entry.category,
      foreign: entry.trip.foreign,
      realtime: entry.trip.realtime,
      delaySeconds: entry.trip.delay,
      dataTimeMs: Math.floor(planNow * 1000),
      speedMps: trains?.selectedSpeed() ?? null,
    };
    selectionSent = info;
    environment.post({ type: "live-selection", info }, []);
  }

  function currentElevation(): Elevation {
    const lift = carView ? markerLiftM(carView.view.zoom, carView.lat, carView.pitch) : 0;
    return terrainElevation(elevationScale, lift);
  }

  function deckFor(live: LiveTrains, wall: number): DeckWindows | undefined {
    const wanted =
      elevationScale > 0 && carView !== undefined && carView.view.zoom >= DECK_MIN_ZOOM;
    if (!(wanted && carView)) {
      deckSchedule.reset();
      live.resetDeck();
      if (!deckActive) return undefined;
      deckActive = false;
      return emptyDeck();
    }
    const box = deckSchedule.due(viewBoxOf(carView.view), live.hiddenVersion, wall);
    if (!box) return undefined;
    const deck = live.deckWindows(box);
    if (deck) deckActive = true;
    return deck;
  }

  function buildCars(live: LiveTrains, planNow: number): CarFrame | undefined {
    const cars =
      carCatalog && carView && carFade(carView.view.zoom, carView.lat) > 0
        ? live.buildCars(
            carCatalog,
            carView.view,
            carView.selection,
            environment.perf() / 1000,
            planNow,
          )
        : undefined;
    carCounts = {
      trains: cars?.trainKeys.length ?? 0,
      instances: cars?.meshes.reduce((sum, mesh) => sum + mesh.count, 0) ?? 0,
      layers: cars?.meshes.length ?? 0,
      slots: 0,
      slotMoves: 0,
    };
    const wire = cars && carsOnTheWire(cars, fleetMerger);
    carCounts.slots = wire ? fleetMerger.stats().slots : 0;
    carCounts.slotMoves = fleetMerger.stats().moves;
    return wire;
  }

  function frameTransfer(
    frame: Frame,
    route: SelectedRoute | undefined,
    stops: SelectionStops | undefined,
    deck: DeckWindows | undefined,
    cars: CarFrame | undefined,
  ): Transferable[] {
    const transfer: Transferable[] = frame.groups.flatMap((group) => [
      group.positions.buffer,
      group.iconAngles.buffer,
      group.sizes.buffer,
      group.fillColors.buffer,
      group.lineColors.buffer,
    ]);
    if (route) {
      transfer.push(route.path.buffer);
      if (route.heights) transfer.push(route.heights.buffer);
    }
    if (stops) {
      transfer.push(
        stops.vertices.buffer,
        stops.arrivals.buffer,
        stops.departures.buffer,
        stops.cancelled.buffer,
      );
    }
    if (deck) transfer.push(deck.paths.buffer, deck.first.buffer, deck.counts.buffer);
    if (cars) transfer.push(...carBuffers(cars));
    return transfer;
  }

  function handleTick(): void {
    ticks++;
    const started = environment.perf();
    const wall = environment.now();
    if (playback.engaged) playback.tick();
    const planNow = planTime(wall);
    if (!trains || planNow === null) {
      environment.post(
        { type: "frame", frame: { groups: [], selected: null }, selectionPath: undefined },
        [],
      );
      return;
    }
    shapes?.pump();
    applyDue();
    if (playback.standing()) trains.fleet.settleFades(planNow);
    trains.advance(planNow);
    probe?.observe(trains, planNow);
    trains.setElevation(currentElevation());
    const includeIds = trains.idsVersion !== idsVersionSent;
    const cars = buildCars(trains, planNow);
    const frame = trains.buildFrame({ includeIds, cars });
    if (includeIds) idsVersionSent = trains.idsVersion;
    const route = followSelection(frame, wall);
    const selectionPath = route?.path;
    const selectionHeights = route?.heights;
    const deck = deckFor(trains, wall);
    const selectionStops = stopsToSend(frame, route, wall);
    const transfer = frameTransfer(frame, route, selectionStops, deck, cars);
    environment.post(
      { type: "frame", frame, selectionPath, selectionHeights, selectionStops, deck },
      transfer,
    );
    if (wall - statusSentAt >= STATUS_EVERY_MS) publishStatus();
    tickMs.add(environment.perf() - started);
  }

  function diagnostics(): LiveDiagnostics {
    const tick = tickMs.summary();
    const follow = followMs.summary();
    return {
      trains: trains?.size ?? 0,
      waitingForShapes: trains?.waitingCount ?? 0,
      withoutShape: trains?.failedCount ?? 0,
      updates: trains?.updates ?? 0,
      crossfades: { ...(trains?.crossfades ?? {}) },
      crossfadeSamples: trains?.crossfadeSamples ?? [],
      sequence: follower?.sequence ?? null,
      shapes: shapes?.stats() ?? { loaded: 0, pending: 0, inFlight: 0, missing: 0 },
      ...(packSets ? { packSets: packSetCounts(packSets, shapes) } : {}),
      bytesFetched,
      objectsFetched,
      transferredBytes: environment.transferred?.() ?? null,
      followErrors,
      ticks,
      tickMs: { p50: tick.p50, p95: tick.p95, max: tick.max },
      followMs: follow,
      applyLagS: applyLagS.summary(),
      displayLagS: displayLagS(),
      cars: carCounts,
      planTime: planTime(environment.now()),
      timeScale: playback.speed() ?? config?.timeScale ?? 1,
      push: push
        ? { up: push.up, silent: pushSilent, notices: push.notices, connects: push.connects }
        : null,
      headReads: { total: headReads, onNotice: noticeReads },
    };
  }

  function handleVisibility(nowHidden: boolean): void {
    if (nowHidden === hidden) return;
    hidden = nowHidden;
    playback.setHidden(nowHidden);
    if (hidden) {
      if (pollTimer !== undefined) {
        environment.clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      push?.stop();
      return;
    }
    if (livePaused) return;
    startPush();
    if (trains && !polling) void poll("start");
  }

  function handleSelect(id: string | null): void {
    selectedKey = liveKeyOf(id);
    drawnSent = null;
    pathKeySent = undefined;
    selectionSentAt = Number.NEGATIVE_INFINITY;
    selectionSent = null;
    trains?.select(selectedKey);
  }

  function handleNearest(message: Extract<WorkerRequest, { type: "nearest" }>): void {
    const live = trains;
    const result = live
      ? nearestTrains(live.values(), live.fleet, message.request, (entry) => live.isShown(entry))
      : { inView: 0, trains: [] };
    environment.post({ type: "nearest-trains", id: message.id, result }, []);
  }

  function handleContinuity(message: Extract<WorkerRequest, { type: "continuity" }>): void {
    if (message.action === "start") {
      probe = new ContinuityProbe(message.sample ?? 1);
      return;
    }
    const report = probe?.report() ?? null;
    if (message.action === "stop") probe = undefined;
    environment.post({ type: "continuity", report }, []);
  }

  return {
    handle(message) {
      switch (message.type) {
        case "init-live":
          handleInit(message);
          break;
        case "release-packs":
          shapes?.resume();
          break;
        case "tick":
          handleTick();
          break;
        case "select":
          handleSelect(message.id);
          break;
        case "visibility":
          handleVisibility(message.hidden);
          break;
        case "palette":
          palette = message.palette;
          trains?.setPalette(message.palette);
          break;
        case "categories":
          hiddenCategories = message.hidden;
          trains?.setHiddenCategories(message.hidden);
          break;
        case "playback":
          playback.handle(message.command);
          break;
        case "label-mode":
          labelMode = message.mode;
          trains?.setLabelMode(message.mode);
          break;
        case "operator-groups":
          hiddenOperatorGroups = message.hidden;
          trains?.setHiddenOperatorGroups(message.hidden);
          break;
        case "colour-mode":
          colourMode = message.mode;
          trains?.setColourMode(message.mode);
          break;
        case "continuity":
          handleContinuity(message);
          break;
        case "nearest":
          handleNearest(message);
          break;
        case "reduced-motion":
          if (config) config = { ...config, reducedMotion: message.reduced };
          break;
        case "diagnostics":
          environment.post({ type: "diagnostics", data: diagnostics() }, []);
          break;
        case "car-catalog":
          try {
            carCatalog = parseCatalog(message.manifest);
          } catch {
            carCatalog = undefined;
          }
          break;
        case "view":
          carView = viewOf(message.view);
          break;
        case "elevation":
          elevationScale = message.scale;
          trains?.setElevation(currentElevation());
          pathKeySent = undefined;
          deckSchedule.reset();
          trains?.resetDeck();
          break;
      }
    },
  };
}

function viewBoxOf(view: CarView): DeckBox {
  return (
    view.visible ?? {
      minX: view.centerX - view.radiusM,
      minY: view.centerY - view.radiusM,
      maxX: view.centerX + view.radiusM,
      maxY: view.centerY + view.radiusM,
    }
  );
}

function visibleBox(bounds: readonly [number, number, number, number]) {
  const southWest = lonLatToMercator(bounds[0], bounds[1]);
  const northEast = lonLatToMercator(bounds[2], bounds[3]);
  return { minX: southWest.x, minY: southWest.y, maxX: northEast.x, maxY: northEast.y };
}

function viewOf(input: CarViewInput): {
  view: CarView;
  lat: number;
  pitch: number;
  selection: CarViewInput["selection"];
} {
  const center = lonLatToMercator(input.lon, input.lat);
  return {
    view: {
      zoom: input.zoom,
      centerX: center.x,
      centerY: center.y,
      radiusM: input.radiusM,
      fineRadiusM: input.fineRadiusM,
      ...(input.bounds ? { visible: visibleBox(input.bounds) } : {}),
      ready: new Set(input.ready),
    },
    lat: input.lat,
    pitch: input.pitch ?? 0,
    selection: input.selection,
  };
}
