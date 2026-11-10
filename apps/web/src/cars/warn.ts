export function warnCars(message: string, error: unknown): void {
  // biome-ignore lint/suspicious/noConsole: the only console sink of the web app, for non-fatal car layer failures that are retried
  console.warn(`[cars] ${message}`, error);
}
