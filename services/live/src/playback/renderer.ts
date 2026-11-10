import { rm } from "node:fs/promises";
import type { PlaybackCache, PlaybackIndex, RenderedWindow } from "./cache.ts";

/** Renders the window [start, end] into the empty directory `out`. */
export type RenderWindow = (start: number, end: number, out: string) => Promise<RenderedWindow>;

export interface RendererOptions {
  /** Windows rendering or waiting at once; a request beyond is refused as busy. */
  readonly maxPending: number;
  readonly onError?: (start: number, error: unknown) => void;
}

/** A busy request's `done` is null at once; the others end with the window's index, null on failure. */
export interface RenderRequest {
  readonly status: "started" | "pending" | "busy";
  readonly done: Promise<PlaybackIndex | null>;
}

/**
 * One render at a time over a cache: a window asked for again while it renders joins that render,
 * a window already cached is answered from the cache, and no more than `maxPending` windows wait or
 * run. A failed render leaves nothing in the cache.
 */
export class PlaybackRenderer {
  readonly #cache: PlaybackCache;
  readonly #render: RenderWindow;
  readonly #options: RendererOptions;
  readonly #inFlight = new Map<number, Promise<PlaybackIndex | null>>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(cache: PlaybackCache, render: RenderWindow, options: RendererOptions) {
    this.#cache = cache;
    this.#render = render;
    this.#options = options;
  }

  get pending(): number {
    return this.#inFlight.size;
  }

  request(start: number, end: number): RenderRequest {
    const running = this.#inFlight.get(start);
    if (running) return { status: "pending", done: running };
    if (this.#inFlight.size >= this.#options.maxPending)
      return { status: "busy", done: Promise.resolve(null) };
    const done = this.#tail.then(() => this.#run(start, end));
    this.#tail = done;
    this.#inFlight.set(start, done);
    return { status: "started", done };
  }

  async #run(start: number, end: number): Promise<PlaybackIndex | null> {
    let out: string | null = null;
    try {
      const existing = await this.#cache.index(start);
      if (existing) return existing;
      out = await this.#cache.scratchDirectory(start);
      const window = await this.#render(start, end, out);
      const index = await this.#cache.put(window, out);
      out = null;
      return index;
    } catch (error) {
      this.#options.onError?.(start, error);
      return null;
    } finally {
      if (out) await rm(out, { recursive: true, force: true });
      this.#inFlight.delete(start);
    }
  }
}
