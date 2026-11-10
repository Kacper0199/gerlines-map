export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

/** JSON lines on stdout (stderr for warnings and errors); callers pass redacted URLs only. */
export function jsonLogger(now: () => number): Logger {
  return {
    log(level, message, fields = {}) {
      const line = `${JSON.stringify({ time: new Date(now()).toISOString(), level, msg: message, ...fields })}\n`;
      if (level === "warn" || level === "error") process.stderr.write(line);
      else process.stdout.write(line);
    },
  };
}

export const silentLogger: Logger = { log: () => undefined };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
