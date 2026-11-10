import type { LiveConfig, PlaybackCommand } from "../../motion/protocol.ts";
import type { ChainChanges } from "../chain.ts";
import type { LiveEnvironment } from "../live-runtime.ts";
import { playbackBaseOf } from "./base.ts";
import {
  PlaybackDriver,
  type PlaybackHost,
  type PlaybackSink,
  type PlaybackState,
} from "./driver.ts";
import { PackChecker } from "./pack-check.ts";

const FADE_MS = 160;

/** What the controller needs of the runtime around it. */
export interface PlaybackContext {
  readonly environment: Pick<LiveEnvironment, "now" | "fetch" | "post">;
  config(): LiveConfig | undefined;
  hasTrains(): boolean;
  /** Frames to apply at their own times. */
  enqueue(steps: readonly ChainChanges[]): void;
  /** Drops every train and queued frame, and the live chain with them. */
  clearTrains(): void;
  setSpeed(speed: number): void;
  setOpacity(opacity: number): void;
  /** Live polling stops (the playback has the screen). */
  pauseLive(): void;
  /** Live polling starts again from a fresh chain. */
  resumeLive(): void;
  /** Fresh trains (a fleet without fades for reduced motion, the normal one otherwise). */
  freshTrains(noFades: boolean): void;
  counted(bytes: number): void;
}

/** Runs the playback of a past hour beside the live source in the worker, one at a time. */
export class PlaybackController {
  private readonly context: PlaybackContext;
  private driver: PlaybackDriver | undefined;
  private noFades = false;
  private readonly packs: PackChecker;

  constructor(context: PlaybackContext) {
    this.context = context;
    this.packs = new PackChecker(
      (url, init) => context.environment.fetch(url, init),
      () => context.config()?.baseUrl ?? "",
      () => context.environment.now(),
    );
  }

  /** A playback owns the screen: from the command to start until Back to live has begun. */
  get active(): boolean {
    return this.driver !== undefined && !this.driver.isLeaving;
  }

  /** The driver still has work, also while the live trains fade back in. */
  get engaged(): boolean {
    return this.driver !== undefined;
  }

  /** Plan seconds per wall second of the running playback, null when none runs. */
  speed(): number | null {
    return this.driver && !this.driver.isLeaving ? this.driver.snapshot().speed : null;
  }

  /** The virtual clock while the trains on screen are the playback's (from its first swap to the swap back), else null. */
  position(): number | null {
    return this.driver?.ownsClock ? this.driver.position : null;
  }

  /** The playback's clock owns the time and is stopped. */
  standing(): boolean {
    return this.driver?.ownsClock === true && this.driver.standing;
  }

  handle(command: PlaybackCommand): void {
    const driver = this.driver;
    switch (command.action) {
      case "start":
        this.start(command.at, command.speed, command.playing);
        break;
      case "play":
        driver?.play();
        break;
      case "pause":
        driver?.pause();
        break;
      case "speed":
        driver?.setSpeed(command.speed);
        break;
      case "seek":
        driver?.seek(command.at);
        break;
      case "stop":
        this.stop();
        break;
    }
  }

  tick(): void {
    const driver = this.driver;
    if (!driver) return;
    driver.tick();
    if (driver.done) {
      driver.close();
      this.driver = undefined;
    }
  }

  frameApplied(reloaded: boolean): void {
    this.driver?.frameApplied(reloaded);
  }

  setHidden(hidden: boolean): void {
    this.driver?.setHidden(hidden);
  }

  private start(at: number, speed: number, playing: boolean): void {
    if (this.driver && !this.driver.isLeaving) {
      this.driver.seek(at);
      this.driver.setSpeed(speed);
      if (playing) this.driver.play();
      else this.driver.pause();
      return;
    }
    this.driver?.close();
    const config = this.context.config();
    this.noFades = config?.reducedMotion === true;
    const fromTrains = this.context.hasTrains();
    this.context.pauseLive();
    if (this.noFades) this.context.freshTrains(true);
    this.driver = new PlaybackDriver(
      { host: this.host(), sink: this.sink(), fadeMs: this.noFades ? 0 : FADE_MS },
      at,
      speed,
      playing,
      fromTrains && !this.noFades,
    );
  }

  private stop(): void {
    if (!this.driver || this.driver.isLeaving) return;
    this.driver.leave();
    this.context.environment.post({ type: "playback", state: null }, []);
  }

  private base(): string {
    return playbackBaseOf(this.context.config()?.baseUrl ?? "");
  }

  private host(): PlaybackHost {
    const { environment } = this.context;
    return {
      now: () => environment.now(),
      json: async (path) => {
        const response = await environment.fetch(`${this.base()}/${path}`);
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
      },
      object: async (start, revision, path) => {
        const response = await environment.fetch(`${this.base()}/w/${start}/${revision}/${path}`);
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        this.context.counted(bytes.length);
        return bytes;
      },
      packExists: (epoch, shapeId) => this.packs.exists(epoch, shapeId),
    };
  }

  private sink(): PlaybackSink {
    const { environment } = this.context;
    return {
      enqueue: (steps) => this.context.enqueue(steps),
      clear: () => this.context.clearTrains(),
      setSpeed: (speed) => this.context.setSpeed(speed),
      setOpacity: (opacity) => this.context.setOpacity(opacity),
      publish: (state: PlaybackState) => {
        if (this.active) environment.post({ type: "playback", state }, []);
      },
      leave: () => {
        if (this.noFades) this.context.freshTrains(false);
        this.noFades = false;
        this.context.resumeLive();
      },
    };
  }
}
