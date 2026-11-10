import { catchUp, type Head } from "@gerlines/live-frame";
import { type ChainChanges, ChainError, ChainFollower, type ObjectReader } from "../chain.ts";
import { PlaybackClock } from "./clock.ts";
import { SeekDip } from "./dip.ts";
import { headAt, parseWindowIndex, type WindowIndex, windowStartOf } from "./window-index.ts";

export type PlaybackErrorCode =
  | "not_rendered"
  | "not_settled"
  | "too_old"
  | "epoch_mismatch"
  | "offline"
  | "unreadable";

export type PlaybackPhase = "opening" | "playing" | "paused" | "seeking" | "ended" | "error";

/**
 * What the page shows of a playback. `position` is the target while a seek is under way. `error`
 * stops the playback (phase error); `notice` is a seek that could not start while the old position
 * plays on.
 */
export interface PlaybackState {
  readonly phase: PlaybackPhase;
  /** What the visitor asked for: playing or paused, also while a seek or a load is under way. */
  readonly playing: boolean;
  /** Unix seconds. */
  readonly position: number;
  readonly speed: number;
  readonly windowStart: number | null;
  readonly windowEnd: number | null;
  readonly error: PlaybackErrorCode | null;
  readonly notice: PlaybackErrorCode | null;
}

export interface PlaybackHost {
  now(): number;
  /** A JSON resource under the playback base; rejects on a network failure. */
  json(path: string): Promise<{ readonly status: number; readonly body: unknown }>;
  /** An object of a window's revision (`k/10.bin`), null on 404; rejects on a network failure. */
  object(start: number, revision: string, path: string): Promise<Uint8Array | null>;
  /** Whether the pack of a shape in the epoch is published. */
  packExists(epoch: number, shapeId: string | number): Promise<boolean>;
}

export interface PlaybackSink {
  /** Frames to apply at their own times (a reload is due at once). */
  enqueue(steps: readonly ChainChanges[]): void;
  /** Every train and every queued frame of the time before goes. */
  clear(): void;
  setSpeed(speed: number): void;
  setOpacity(opacity: number): void;
  publish(state: PlaybackState): void;
  /** The playback is over and its trains are gone: the live source starts again. */
  leave(): void;
}

export interface PlaybackOptions {
  readonly host: PlaybackHost;
  readonly sink: PlaybackSink;
  /** Wall milliseconds of the fade out and in around a seek; 0 for reduced motion. */
  readonly fadeMs: number;
}

interface LoadedWindow {
  readonly index: WindowIndex;
  readonly follower: ChainFollower;
  verified: boolean;
  /** No frame has been queued yet (or the follower was reset): the first follow stops at the instant. */
  fresh: boolean;
}

interface PendingSeek {
  readonly start: number;
  readonly target: number;
  readonly immediate: boolean;
  readonly leave?: boolean;
}

type IndexOrError = WindowIndex | PlaybackErrorCode;

const MIN_LOOKAHEAD_S = 15;
const LOOKAHEAD_WALL_S = 4;
const NEXT_LEAD_S = 300;
const NEXT_LEAD_WALL_S = 20;
const FAILURES_BEFORE_ERROR = 3;
const OFFLINE_RETRY_MS = 5_000;
const MISSING_RECHECK_MS = 15_000;
const PUBLISH_EVERY_MS = 200;
const MAX_WARM = 40;

const HTTP_CODES: Readonly<Record<string, PlaybackErrorCode>> = {
  TOO_OLD: "too_old",
  NOT_SETTLED: "not_settled",
  NOT_RENDERED: "not_rendered",
};

function errorCodeOf(reply: { status: number; body: unknown }): PlaybackErrorCode {
  if (reply.status === 404) return "not_rendered";
  const code = (reply.body as { error?: { code?: unknown } } | null)?.error?.code;
  return (typeof code === "string" ? HTTP_CODES[code] : undefined) ?? "unreadable";
}

/**
 * The playback of past hours in the live worker (ADR-0014): a virtual clock over rendered windows.
 * It follows the head of an instant a few plan seconds ahead of the clock, reads the frames of the
 * window's revision (warmed in parallel) and hands them to the sink, which applies each at its own
 * time. A seek fades the trains out, swaps the state and fades them in; the next hour is a new chain
 * that starts when the clock reaches the end of the window, applied as a reload.
 */
export class PlaybackDriver {
  private readonly host: PlaybackHost;
  private readonly sink: PlaybackSink;
  private readonly dip: SeekDip;
  private readonly clock: PlaybackClock;
  private readonly windows = new Map<number, Promise<IndexOrError>>();
  private readonly missing = new Map<number, { code: PlaybackErrorCode; at: number }>();
  private readonly warm = new Map<string, Promise<Uint8Array | null>>();
  private current: LoadedWindow | undefined;
  private next: WindowIndex | undefined;
  private busy = false;
  private seekTarget: number | null = null;
  private seekToken = 0;
  private pending: PendingSeek | undefined;
  private awaitingFirstFrame = false;
  private error: PlaybackErrorCode | null = null;
  private notice: PlaybackErrorCode | null = null;
  private pausedByHost = false;
  private userPlaying: boolean;
  private failures = 0;
  private retryAt = 0;
  private lastPublish = Number.NEGATIVE_INFINITY;
  private lastOpacity = 1;
  private closed = false;
  private leaving = false;
  private clockOwned = false;

  constructor(
    options: PlaybackOptions,
    at: number,
    speed: number,
    playing: boolean,
    fromTrains = false,
  ) {
    this.host = options.host;
    this.sink = options.sink;
    this.dip = new SeekDip(options.fadeMs, options.fadeMs);
    this.clock = new PlaybackClock(at, speed, false, options.host.now());
    this.userPlaying = playing;
    this.sink.setSpeed(speed);
    this.requestSeek(at, !fromTrains);
  }

  get position(): number {
    return this.clock.now(this.host.now());
  }

  /** True once Back to live has swapped the sources and the live trains have faded in. */
  get done(): boolean {
    return this.leaving && !this.awaitingFirstFrame && !this.dip.active;
  }

  get isLeaving(): boolean {
    return this.leaving;
  }

  /**
   * True from the first swap to the swap back to live: only then are the trains on screen those of
   * the playback, so only then does the virtual clock stand for the plan time.
   */
  get ownsClock(): boolean {
    return this.clockOwned;
  }

  /** The virtual clock is stopped (paused, or waiting for the first frame of a seek): no fade can run on it. */
  get standing(): boolean {
    return !this.clock.playing;
  }

  /** Back to live: the trains fade out, the playback's state goes, the live source starts. */
  leave(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.seekToken++;
    this.seekTarget = null;
    this.error = null;
    this.notice = null;
    this.pending = { start: 0, target: 0, immediate: false, leave: true };
    this.clock.pause(this.host.now());
    if (!this.dip.fadingOut) this.dip.begin(this.host.now());
  }

  close(): void {
    this.closed = true;
    this.warm.clear();
    this.windows.clear();
    this.sink.setOpacity(1);
  }

  play(): void {
    if (this.leaving) return;
    this.userPlaying = true;
    if (this.canRun()) this.clock.play(this.host.now());
  }

  pause(): void {
    this.userPlaying = false;
    this.clock.pause(this.host.now());
  }

  setSpeed(speed: number): void {
    this.clock.setSpeed(this.host.now(), speed);
    this.sink.setSpeed(speed);
  }

  /** The page went to the background: the clock stops and goes on from where it was. */
  setHidden(hidden: boolean): void {
    const wall = this.host.now();
    if (hidden) {
      if (this.clock.playing) {
        this.clock.pause(wall);
        this.pausedByHost = true;
      }
    } else if (this.pausedByHost) {
      this.pausedByHost = false;
      if (this.canRun()) this.clock.play(wall);
    }
  }

  seek(target: number): void {
    if (!this.leaving) this.requestSeek(target, false);
  }

  /** A frame of the playback is on screen; the reload of a seek, an opening or a seam ends the wait. */
  frameApplied(reloaded: boolean): void {
    if (!(reloaded && this.awaitingFirstFrame)) return;
    this.awaitingFirstFrame = false;
    this.dip.release(this.host.now());
    if (this.userPlaying && this.canRun()) this.clock.play(this.host.now());
  }

  /** Called with every display tick: the fade, the swap, the fetches and the state for the page. */
  tick(): void {
    if (this.closed) return;
    const wall = this.host.now();
    this.applyOpacity(wall);
    this.publishState(wall);
    if (this.busy || (this.error === "offline" && wall < this.retryAt)) return;
    this.busy = true;
    void this.pump(wall).finally(() => {
      this.busy = false;
    });
  }

  private canRun(): boolean {
    return (
      this.current !== undefined &&
      !this.awaitingFirstFrame &&
      this.error === null &&
      this.pending === undefined
    );
  }

  private requestSeek(target: number, opening: boolean): void {
    const token = ++this.seekToken;
    this.seekTarget = target;
    this.notice = null;
    const start = windowStartOf(target);
    void this.windowAt(start).then((found) => {
      if (token !== this.seekToken || this.closed) return;
      if (typeof found === "string") {
        this.seekTarget = null;
        if (opening || this.current === undefined) this.fail(found);
        else this.notice = found;
        return;
      }
      this.error = null;
      this.pending = { start, target, immediate: opening };
      this.clock.pause(this.host.now());
      if (!this.dip.fadingOut) this.dip.begin(this.host.now());
    });
  }

  private fail(code: PlaybackErrorCode): void {
    this.error = code;
    this.clock.pause(this.host.now());
  }

  private applyOpacity(wall: number): void {
    const opacity = this.dip.opacity(wall);
    if (opacity === this.lastOpacity) return;
    this.lastOpacity = opacity;
    this.sink.setOpacity(opacity);
  }

  private phaseAt(wall: number): PlaybackState["phase"] {
    if (this.error !== null) return "error";
    if (this.current === undefined && this.pending === undefined && this.seekTarget === null) {
      return "opening";
    }
    if (this.seekTarget !== null || this.pending || this.awaitingFirstFrame) return "seeking";
    if (this.clock.atLimit(wall) && !this.next) return "ended";
    return this.userPlaying ? "playing" : "paused";
  }

  snapshot(): PlaybackState {
    const wall = this.host.now();
    const index = this.current?.index;
    return {
      phase: this.phaseAt(wall),
      playing: this.userPlaying,
      position: this.seekTarget ?? this.pending?.target ?? this.clock.now(wall),
      speed: this.clock.speed,
      windowStart: index?.start ?? null,
      windowEnd: index?.end ?? null,
      error: this.error,
      notice: this.notice,
    };
  }

  private publishState(wall: number): void {
    if (wall - this.lastPublish < PUBLISH_EVERY_MS) return;
    this.lastPublish = wall;
    this.sink.publish(this.snapshot());
  }

  private windowAt(start: number): Promise<IndexOrError> {
    const missed = this.missing.get(start);
    if (missed && this.host.now() - missed.at < MISSING_RECHECK_MS) {
      return Promise.resolve(missed.code);
    }
    const held = this.windows.get(start);
    if (held) return held;
    const loading = this.loadWindow(start).then((found) => {
      if (typeof found === "string") {
        this.windows.delete(start);
        if (found !== "offline") this.missing.set(start, { code: found, at: this.host.now() });
      } else {
        this.missing.delete(start);
      }
      return found;
    });
    this.windows.set(start, loading);
    return loading;
  }

  private async loadWindow(start: number): Promise<IndexOrError> {
    let reply: { readonly status: number; readonly body: unknown };
    try {
      reply = await this.host.json(`w/${start}`);
    } catch {
      return "offline";
    }
    if (reply.status !== 200) return errorCodeOf(reply);
    const index = parseWindowIndex(reply.body);
    return index && index.start === start ? index : "unreadable";
  }

  private lookaheadS(): number {
    return Math.max(MIN_LOOKAHEAD_S, LOOKAHEAD_WALL_S * this.clock.speed);
  }

  private readerFor(index: WindowIndex): ObjectReader {
    return async (path) => {
      const key = `${index.start}/${path}`;
      const warmed = this.warm.get(key);
      this.warm.delete(key);
      if (warmed) {
        try {
          return await warmed;
        } catch {
          return this.host.object(index.start, index.revision, path);
        }
      }
      return this.host.object(index.start, index.revision, path);
    };
  }

  private warmFor(index: WindowIndex, follower: ChainFollower, head: Head): void {
    const plan = catchUp(
      head,
      follower.sequence === null || follower.timetableVersion === null
        ? null
        : { sequence: follower.sequence, timetableVersion: follower.timetableVersion },
    );
    const paths: string[] = [];
    if (plan.keyframe !== null) paths.push(`k/${plan.keyframe}.bin`);
    for (let sequence = plan.firstDelta; sequence <= plan.lastDelta; sequence++) {
      paths.push(`d/${sequence}.bin`);
    }
    for (const path of paths.slice(0, MAX_WARM)) {
      const key = `${index.start}/${path}`;
      if (this.warm.has(key)) continue;
      const request = this.host.object(index.start, index.revision, path);
      request.catch(() => undefined);
      this.warm.set(key, request);
    }
  }

  private async pump(wall: number): Promise<void> {
    try {
      const pending = this.pending;
      if (pending && (pending.immediate || this.dip.swapDue(wall))) await this.swap(pending, wall);
      const win = this.current;
      if (!win || this.pending || (this.error !== null && this.error !== "offline")) return;
      const position = this.clock.now(wall);
      if (position >= win.index.end) await this.crossSeam(win, position);
      else await this.follow(win, position);
      await this.prepareNext(win, position);
      this.recovered();
    } catch (failure) {
      await this.onFailure(failure);
    }
  }

  private recovered(): void {
    this.failures = 0;
    if (this.error !== "offline") return;
    this.error = null;
    if (this.userPlaying && this.canRun()) this.clock.play(this.host.now());
  }

  private async onFailure(failure: unknown): Promise<void> {
    this.failures++;
    if (failure instanceof ChainError) {
      if (await this.republished()) return;
      if (this.failures >= FAILURES_BEFORE_ERROR) this.fail("unreadable");
      return;
    }
    if (this.failures < FAILURES_BEFORE_ERROR) return;
    if (this.error === null) this.fail("offline");
    this.retryAt = this.host.now() + OFFLINE_RETRY_MS;
  }

  /** A missing object may mean the hour was rendered again: reread its index and seek on a new revision. */
  private async republished(): Promise<boolean> {
    const win = this.current;
    if (!win || this.pending) return false;
    this.windows.delete(win.index.start);
    const found = await this.windowAt(win.index.start);
    if (typeof found === "string" || this.current !== win) return false;
    if (found.revision === win.index.revision) return false;
    this.failures = 0;
    this.requestSeek(this.clock.now(this.host.now()), false);
    return true;
  }

  private swapToLive(): void {
    this.pending = undefined;
    this.sink.clear();
    this.warm.clear();
    this.current = undefined;
    this.next = undefined;
    this.clockOwned = false;
    this.awaitingFirstFrame = true;
    this.dip.swapped();
    this.sink.leave();
  }

  private async swap(pending: PendingSeek, wall: number): Promise<void> {
    if (pending.leave) {
      this.swapToLive();
      return;
    }
    const found = await this.windowAt(pending.start);
    if (typeof found === "string") {
      this.pending = undefined;
      this.seekTarget = null;
      this.dip.swapped();
      this.dip.release(wall);
      if (this.current === undefined) this.fail(found);
      else {
        this.notice = found;
        if (this.userPlaying) this.clock.play(wall);
      }
      return;
    }
    if (this.pending !== pending) return;
    this.pending = undefined;
    this.seekTarget = null;
    this.sink.clear();
    this.warm.clear();
    const loaded: LoadedWindow = {
      index: found,
      follower: new ChainFollower(this.readerFor(found)),
      verified: false,
      fresh: true,
    };
    this.current = loaded;
    this.next = undefined;
    this.clock.setLimit(found.end);
    this.clock.seek(wall, pending.target);
    this.clockOwned = true;
    this.awaitingFirstFrame = true;
    this.dip.swapped();
    await this.follow(loaded, pending.target);
  }

  private async follow(win: LoadedWindow, position: number): Promise<void> {
    const ahead = win.fresh ? 0 : this.lookaheadS();
    const head = headAt(win.index, Math.min(position + ahead, win.index.end));
    if (!head) return;
    const follower = win.follower;
    if (win.verified && follower.sequence !== null && follower.sequence >= head.sequence) return;
    this.warmFor(win.index, follower, head);
    const steps = await follower.followSteps(head);
    if (steps.length === 0 || this.current !== win) return;
    if (!(await this.verified(win, steps))) return;
    win.fresh = false;
    this.sink.enqueue(steps);
  }

  private async verified(win: LoadedWindow, steps: readonly ChainChanges[]): Promise<boolean> {
    try {
      return await this.checked(win, steps);
    } catch (failure) {
      win.follower.reset();
      win.fresh = true;
      throw failure;
    }
  }

  private async checked(win: LoadedWindow, steps: readonly ChainChanges[]): Promise<boolean> {
    if (win.verified) return true;
    const first = steps.find((step) => step.reloaded);
    if (!first) return true;
    const sample = first.changed[0];
    const mismatch = first.shapeEpoch !== win.index.shapeEpoch;
    if (mismatch || (sample && !(await this.host.packExists(first.shapeEpoch, sample.shapeId)))) {
      win.follower.reset();
      this.awaitingFirstFrame = false;
      this.dip.release(this.host.now());
      this.fail("epoch_mismatch");
      return false;
    }
    win.verified = true;
    return true;
  }

  private async prepareNext(win: LoadedWindow, position: number): Promise<void> {
    if (this.next || (this.error !== null && this.error !== "offline") || this.current !== win)
      return;
    const lead = Math.max(NEXT_LEAD_S, NEXT_LEAD_WALL_S * this.clock.speed);
    if (win.index.end - position > lead) return;
    const found = await this.windowAt(win.index.end);
    if (typeof found === "string") {
      this.clock.setLimit(win.index.end);
      return;
    }
    this.next = found;
    this.clock.setLimit(Number.POSITIVE_INFINITY);
    const head = headAt(found, found.start + this.lookaheadS());
    if (head) this.warmFor(found, new ChainFollower(async () => null), head);
  }

  private async crossSeam(win: LoadedWindow, position: number): Promise<void> {
    await this.prepareNext(win, position);
    const index = this.next;
    if (!index) return;
    const loaded: LoadedWindow = {
      index,
      follower: new ChainFollower(this.readerFor(index)),
      verified: false,
      fresh: true,
    };
    this.current = loaded;
    this.next = undefined;
    this.clock.setLimit(index.end);
    await this.follow(loaded, Math.max(position, index.start));
  }
}
