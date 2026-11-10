import pg from "pg";
import { redactDatabaseUrl } from "./config.ts";

const unreachableCodes = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"]);
const pgConnectTimeoutMessage = "timeout expired";

export function isUnreachableError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(isUnreachableError);
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    return unreachableCodes.has(code);
  }
  return error.message === pgConnectTimeoutMessage;
}

export async function probeDatabase(databaseUrl: string, timeoutMs = 3000): Promise<boolean> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: timeoutMs,
  });
  try {
    await client.connect();
    return true;
  } catch (error) {
    if (isUnreachableError(error)) {
      return false;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `database ${redactDatabaseUrl(databaseUrl)} refused the connection: ${reason}`,
      {
        cause: error,
      },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
