import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { userAgent } from "@gerlines/schema";
import packageJson from "../package.json" with { type: "json" };
import { type DbCredentials, loadDbCredentials } from "./db-apis/client.ts";
import { type ClientCertificate, loadClientCertificate } from "./fetch/client-certificate.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export const APP_VERSION: string = packageJson.version;

/**
 * Access to the Mobilithek DELFI GTFS-RT subscription (K3). The password stays inside `openCertificate`, so
 * the config can be logged or serialised without it.
 */
export interface MobilithekConfig {
  readonly certificatePath: string | null;
  readonly subscriptionId: string | null;
  /** The first variable that is empty, or null when all three are set. */
  readonly missing: string | null;
  readonly openCertificate: () => ClientCertificate;
}

export interface RecorderConfig {
  readonly recordingsDir: string;
  readonly userAgent: string;
  readonly appVersion: string;
  readonly otdChApiKey: string | null;
  readonly sncbApiKey: string | null;
  readonly dbCredentials: DbCredentials | null;
  readonly dbApis: boolean;
  readonly mobilithek: MobilithekConfig;
  readonly diskFloorBytes: number;
  readonly maxInFlight: number;
  readonly onlySources: ReadonlySet<string> | null;
  readonly seedDir: string | null;
  readonly database: "on" | "off";
}

const GIB = 1024 ** 3;

function optional(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function required(env: Env, name: string): string {
  const value = optional(env, name);
  if (value === null) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function positiveNumber(env: Env, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function absoluteDir(env: Env, name: string): string | null {
  const value = optional(env, name);
  if (value !== null && !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function switchedOn(env: Env, name: string): boolean {
  const value = optional(env, name) ?? "0";
  if (value !== "0" && value !== "1") {
    throw new Error(`${name} must be 1 or 0`);
  }
  return value === "1";
}

/** A relative path is taken from the workspace root (the folder with `pnpm-workspace.yaml`), as in `.env`. */
export function workspacePath(path: string, from: string = process.cwd()): string {
  if (isAbsolute(path)) return path;
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, path);
    if (dirname(dir) === dir) return resolve(from, path);
  }
}

/** No Mobilithek access: the source is skipped. */
export const NO_MOBILITHEK: MobilithekConfig = {
  certificatePath: null,
  subscriptionId: null,
  missing: "MOBILITHEK_CERT_P12",
  openCertificate: () => {
    throw new Error("MOBILITHEK_CERT_P12 is empty");
  },
};

const MOBILITHEK_VARIABLES = [
  "MOBILITHEK_CERT_P12",
  "MOBILITHEK_CERT_PASSWORD",
  "MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID",
] as const;

function loadMobilithekConfig(env: Env): MobilithekConfig {
  const path = optional(env, "MOBILITHEK_CERT_P12");
  const certificatePath = path === null ? null : workspacePath(path);
  const missing = MOBILITHEK_VARIABLES.find((name) => optional(env, name) === null) ?? null;
  return {
    certificatePath,
    subscriptionId: optional(env, "MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID"),
    missing,
    openCertificate: () => {
      const password = env.MOBILITHEK_CERT_PASSWORD ?? "";
      if (certificatePath === null || password === "") {
        throw new Error("MOBILITHEK_CERT_P12 or MOBILITHEK_CERT_PASSWORD is empty");
      }
      return loadClientCertificate(certificatePath, password);
    },
  };
}

export function loadRecorderConfig(env: Env): RecorderConfig {
  const recordingsDir = absoluteDir(env, "RECORDINGS_DIR");
  if (recordingsDir === null) {
    throw new Error("RECORDINGS_DIR must be set");
  }
  const only = optional(env, "RECORDER_SOURCES");
  const database = optional(env, "RECORDER_DATABASE") ?? "on";
  const dbApis = switchedOn(env, "RECORDER_DB_APIS");
  if (database !== "on" && database !== "off") {
    throw new Error("RECORDER_DATABASE must be on or off");
  }
  return {
    recordingsDir,
    get userAgent() {
      return userAgent({
        appName: required(env, "APP_NAME"),
        version: APP_VERSION,
        contact: required(env, "APP_CONTACT"),
      });
    },
    appVersion: APP_VERSION,
    otdChApiKey: optional(env, "OTD_CH_API_KEY"),
    sncbApiKey: optional(env, "SNCB_API_KEY"),
    dbCredentials: dbApis ? loadDbCredentials(env) : null,
    dbApis,
    mobilithek: loadMobilithekConfig(env),
    diskFloorBytes: positiveNumber(env, "RECORDER_DISK_FLOOR_GIB", 20) * GIB,
    maxInFlight: Math.floor(positiveNumber(env, "RECORDER_MAX_IN_FLIGHT", 3)),
    onlySources: only ? new Set(only.split(",").map((id) => id.trim())) : null,
    seedDir: absoluteDir(env, "RECORDER_SEED_DIR"),
    database,
  };
}
