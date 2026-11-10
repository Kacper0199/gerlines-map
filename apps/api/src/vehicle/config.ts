import { createDatabase } from "@gerlines/db";
import { buildUserAgent, ConfigurationError } from "../config.ts";
import { DatabaseIdentityStore } from "./repository.ts";
import { VehicleIdentityService } from "./service.ts";
import { VehicleSequenceClient } from "./vehicle-sequence.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The identity service from `VEHICLE_DATABASE_URL`, or undefined when it is unset (details then keep
 * `vehicle: null`). The coach sequence (layer L0) runs only with `VEHICLE_SEQUENCE_ENABLED=1`.
 */
export function identityFromEnv(
  env: Environment,
  version: string,
  logger: { error(line: string): void },
): VehicleIdentityService | undefined {
  const databaseUrl = env.VEHICLE_DATABASE_URL?.trim();
  if (!databaseUrl) return undefined;
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigurationError("VEHICLE_DATABASE_URL must be a postgres:// URL");
  }
  const db = createDatabase({
    databaseUrl,
    applicationName: "gerlines-api-vehicle",
    maxConnections: 4,
    statementTimeoutMs: 2_000,
    queryTimeoutMs: 3_000,
    connectionTimeoutMs: 1_000,
    onPoolError: (error) => logger.error(`vehicle database connection failed: ${error.message}`),
  });
  const sequence =
    env.VEHICLE_SEQUENCE_ENABLED?.trim() === "1"
      ? new VehicleSequenceClient({ userAgent: buildUserAgent(env, version) })
      : undefined;
  return new VehicleIdentityService({ store: new DatabaseIdentityStore(db), sequence, logger });
}
