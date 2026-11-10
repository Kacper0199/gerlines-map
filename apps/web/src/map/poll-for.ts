export interface PollClock {
  readonly frame: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
  readonly now: () => number;
  readonly timeoutMs: number;
}

/** Looks for a value once a frame until it appears or the timeout passes; returns a stop. */
export function pollFor<T>(
  look: () => T | null,
  found: (value: T) => void,
  { frame, cancel, now, timeoutMs }: PollClock,
): () => void {
  const start = now();
  let handle = 0;
  const step = () => {
    const value = look();
    if (value !== null) found(value);
    else if (now() - start < timeoutMs) handle = frame(step);
  };
  step();
  return () => cancel(handle);
}
