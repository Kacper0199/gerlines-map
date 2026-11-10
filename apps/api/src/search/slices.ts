/**
 * Long synchronous work (building the search index of a day takes about 300 ms) cut into slices, so
 * the event loop answers other requests between them. A sliced job is a generator that yields after
 * each slice; it runs at once with `runNow` or with a pause after each slice with `runSliced`.
 */
export type SlicedJob<T> = Generator<void, T, void>;

export type Pause = () => Promise<void>;

export const SLICE_SIZE = 1_000;

/** Waits for one turn of the event loop, after the timers and I/O already due. */
export const nextTurn: Pause = () => new Promise((resolve) => setImmediate(resolve));

export function runNow<T>(job: SlicedJob<T>): T {
  for (;;) {
    const step = job.next();
    if (step.done) return step.value;
  }
}

export async function runSliced<T>(job: SlicedJob<T>, pause: Pause = nextTurn): Promise<T> {
  for (;;) {
    const step = job.next();
    if (step.done) return step.value;
    await pause();
  }
}

export function* mapSliced<T, U>(
  items: readonly T[],
  map: (item: T) => U,
  size = SLICE_SIZE,
): SlicedJob<U[]> {
  const result: U[] = [];
  for (const item of items) {
    result.push(map(item));
    if (result.length % size === 0 && result.length < items.length) yield;
  }
  return result;
}

export function* filterSliced<T>(
  items: readonly T[],
  keep: (item: T) => boolean,
  size = SLICE_SIZE,
): SlicedJob<T[]> {
  const result: T[] = [];
  let seen = 0;
  for (const item of items) {
    if (keep(item)) result.push(item);
    seen += 1;
    if (seen % size === 0 && seen < items.length) yield;
  }
  return result;
}
