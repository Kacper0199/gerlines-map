/**
 * Writes the first line, then at most one line per `intervalMs`; a written line says how many it
 * held back since the last one, so a failing dependency cannot flood the log.
 */
export function throttledLog(
  write: (line: string) => void,
  now: () => number,
  intervalMs = 60_000,
): (line: string) => void {
  let last = Number.NEGATIVE_INFINITY;
  let held = 0;
  return (line) => {
    const at = now();
    if (at - last < intervalMs) {
      held += 1;
      return;
    }
    write(held > 0 ? `${line} (${held} more since the last line)` : line);
    last = at;
    held = 0;
  };
}
