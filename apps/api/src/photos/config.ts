import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createDatabase } from "@gerlines/db";
import { ConfigurationError } from "../config.ts";
import { DatabasePhotoStore } from "./repository.ts";
import { PhotoService } from "./service.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The photo service from `PHOTO_DIR` (the folder of the local copies, an absolute path) and the
 * catalogue database `VEHICLE_DATABASE_URL`; undefined when either is unset, and details keep
 * `photo: null` while the photo routes answer 503 not_configured.
 */
export function photosFromEnv(
  env: Environment,
  logger: { error(line: string): void },
): PhotoService | undefined {
  const root = env.PHOTO_DIR?.trim();
  const databaseUrl = env.VEHICLE_DATABASE_URL?.trim();
  if (!root || !databaseUrl) return undefined;
  if (!isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) {
    throw new ConfigurationError("PHOTO_DIR must be an absolute path to a folder");
  }
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigurationError("VEHICLE_DATABASE_URL must be a postgres:// URL");
  }
  const db = createDatabase({
    databaseUrl,
    applicationName: "gerlines-api-photos",
    maxConnections: 2,
    statementTimeoutMs: 2_000,
    queryTimeoutMs: 3_000,
    connectionTimeoutMs: 1_000,
    onPoolError: (error) => logger.error(`photo database connection failed: ${error.message}`),
  });
  return new PhotoService({ store: new DatabasePhotoStore(db), root, logger });
}
