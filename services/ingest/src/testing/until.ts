/** Polls `condition` until it holds; throws naming `what` after `timeoutMs`. */
export async function until(
  condition: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
