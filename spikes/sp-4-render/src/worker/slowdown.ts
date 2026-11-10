export function slowdownWaitMs(firstPassMs: number, slowdown: number): number {
  if (!(firstPassMs > 0) || !(slowdown > 1)) return 0;
  return (slowdown - 1) * firstPassMs;
}

export function busyWait(durationMs: number, now: () => number = () => performance.now()): void {
  const deadline = now() + durationMs;
  let current = now();
  while (current < deadline) current = now();
}
