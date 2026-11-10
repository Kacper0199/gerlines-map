/** The engine's notice of a new head on `live:frames` (services/live/src/publish/notice.ts). */
export interface FrameNotice {
  readonly seq: number;
  readonly keyframe: number;
  readonly oldest: number;
  readonly tv: number;
}

/** The part of a browser WebSocket the channel uses. */
export interface PushSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface PushEnvironment {
  open(url: string): PushSocket;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  random(): number;
  now(): number;
}

export interface PushHandlers {
  notice(notice: FrameNotice): void;
  state(up: boolean): void;
}

export const FRAMES_CHANNEL = "live:frames";
export const MIN_RECONNECT_MS = 1_000;
export const MAX_RECONNECT_MS = 60_000;
/** Centrifugo pings every 25 s: a connection without any message for longer is taken as dead. */
export const SILENCE_MS = 35_000;
/** A start (the tab shown again) keeps the grown wait unless the last failure is this old. */
export const RESET_AFTER_MS = 60_000;
const CONNECT_ID = 1;
const SUBSCRIBE_ID = 2;

interface Reply {
  readonly id?: number;
  readonly connect?: unknown;
  readonly subscribe?: unknown;
  readonly error?: unknown;
  readonly push?: { readonly channel?: unknown; readonly pub?: { readonly data?: unknown } };
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function noticeOf(data: unknown): FrameNotice | null {
  if (typeof data !== "object" || data === null) return null;
  const { seq, keyframe, oldest, tv } = data as Record<string, unknown>;
  if (!(isSequence(seq) && isSequence(keyframe) && isSequence(oldest) && isSequence(tv))) {
    return null;
  }
  return { seq, keyframe, oldest, tv };
}

function parsed(line: string): Reply | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Reply) : null;
  } catch {
    return null;
  }
}

/** Close codes after which Centrifugo asks a client not to reconnect (its terminal ranges). */
function refusedForGood(code: number): boolean {
  return (code >= 3500 && code < 4000) || (code >= 4500 && code < 5000);
}

/**
 * The head notices of Centrifugo's JSON protocol over one WebSocket: connect, subscribe to
 * `live:frames`, answer pings, hand on each notice. Up only while subscribed; a close, an error
 * reply or 35 s without a message drops the socket and connects again after a wait that doubles
 * from 1 s to 60 s (half to all of it, at random, so clients spread out). A start connects at once
 * but keeps the grown wait for the next failure unless the last failure is a minute old, so a tab
 * shown and hidden again and again against a refusing server does not reset it.
 */
export class PushChannel {
  readonly #environment: PushEnvironment;
  readonly #url: string;
  readonly #handlers: PushHandlers;
  #socket: PushSocket | null = null;
  #running = false;
  #up = false;
  #failures = 0;
  #lastFailureAt = Number.NEGATIVE_INFINITY;
  #reconnectTimer: number | undefined;
  #silenceTimer: number | undefined;
  notices = 0;
  connects = 0;

  constructor(environment: PushEnvironment, url: string, handlers: PushHandlers) {
    this.#environment = environment;
    this.#url = url;
    this.#handlers = handlers;
  }

  get up(): boolean {
    return this.#up;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (this.#environment.now() - this.#lastFailureAt >= RESET_AFTER_MS) this.#failures = 0;
    this.#connect();
  }

  stop(): void {
    this.#running = false;
    this.#clearTimer("reconnect");
    this.#drop();
  }

  #connect(): void {
    this.#reconnectTimer = undefined;
    this.connects++;
    let socket: PushSocket;
    try {
      socket = this.#environment.open(this.#url);
    } catch {
      this.#retry(MAX_RECONNECT_MS);
      return;
    }
    this.#socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ id: CONNECT_ID, connect: {} }));
    socket.onmessage = (event) => this.#receive(socket, event.data);
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (socket !== this.#socket) return;
      this.#drop();
      this.#retry(refusedForGood(event.code) ? MAX_RECONNECT_MS : undefined);
    };
    this.#watchSilence();
  }

  #receive(socket: PushSocket, data: unknown): void {
    if (socket !== this.#socket || typeof data !== "string") return;
    this.#watchSilence();
    for (const line of data.split("\n")) {
      if (line === "") continue;
      if (line === "{}") {
        socket.send("{}");
        continue;
      }
      const reply = parsed(line);
      if (reply) this.#handle(socket, reply);
      if (socket !== this.#socket) return;
    }
  }

  #handle(socket: PushSocket, reply: Reply): void {
    if (reply.error !== undefined) {
      this.#fail();
      return;
    }
    if (reply.id === CONNECT_ID && reply.connect !== undefined) {
      socket.send(JSON.stringify({ id: SUBSCRIBE_ID, subscribe: { channel: FRAMES_CHANNEL } }));
      return;
    }
    if (reply.id === SUBSCRIBE_ID && reply.subscribe !== undefined) {
      this.#failures = 0;
      this.#setUp(true);
      return;
    }
    if (reply.push?.channel !== FRAMES_CHANNEL) return;
    const notice = noticeOf(reply.push.pub?.data);
    if (!notice) return;
    this.notices++;
    this.#handlers.notice(notice);
  }

  #fail(): void {
    this.#drop();
    this.#retry();
  }

  #watchSilence(): void {
    this.#clearTimer("silence");
    this.#silenceTimer = this.#environment.setTimeout(() => {
      this.#silenceTimer = undefined;
      this.#fail();
    }, SILENCE_MS);
  }

  #drop(): void {
    this.#clearTimer("silence");
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    this.#setUp(false);
  }

  #retry(waitMs?: number): void {
    if (!this.#running) return;
    const base =
      waitMs ?? Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * 2 ** Math.min(this.#failures, 16));
    this.#failures++;
    this.#lastFailureAt = this.#environment.now();
    const delay = Math.round(base * (0.5 + 0.5 * this.#environment.random()));
    this.#clearTimer("reconnect");
    this.#reconnectTimer = this.#environment.setTimeout(() => this.#connect(), delay);
  }

  #setUp(up: boolean): void {
    if (up === this.#up) return;
    this.#up = up;
    this.#handlers.state(up);
  }

  #clearTimer(which: "reconnect" | "silence"): void {
    const id = which === "reconnect" ? this.#reconnectTimer : this.#silenceTimer;
    if (id !== undefined) this.#environment.clearTimeout(id);
    if (which === "reconnect") this.#reconnectTimer = undefined;
    else this.#silenceTimer = undefined;
  }
}
