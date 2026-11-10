import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createDatabase } from "@gerlines/db";
import { ConfigurationError } from "../config.ts";
import { readPlaces } from "./places.ts";
import { SearchService } from "./service.ts";
import { DatabaseSearchSource } from "./timetable-source.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export const SEARCH_STATEMENT_TIMEOUT_MS = 30_000;
export const SEARCH_CONNECTION_TIMEOUT_MS = 10_000;
export const DEFAULT_PLACES_FILE = join("data", "search", "places-de.tsv");

function repositoryRoot(start: string): string | undefined {
  let directory = resolve(start);
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return directory;
}

/** `SEARCH_PLACES_FILE`, else `data/search/places-de.tsv` of the repository. */
export function placesFileOf(env: Environment, cwd: string): string | undefined {
  const given = env.SEARCH_PLACES_FILE?.trim();
  if (given) return resolve(cwd, given);
  const root = repositoryRoot(cwd);
  return root ? join(root, DEFAULT_PLACES_FILE) : undefined;
}

/**
 * The search service from `SEARCH_DATABASE_URL` (a read-only role is enough), or undefined when it
 * is unset: the search route then answers 503 not_configured. Without the places file search still
 * answers stations, trains and lines, and the reason is logged once.
 */
export function searchFromEnv(
  env: Environment,
  logger: { error(line: string): void },
  cwd = process.cwd(),
): SearchService | undefined {
  const databaseUrl = env.SEARCH_DATABASE_URL?.trim();
  if (!databaseUrl) return undefined;
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigurationError("SEARCH_DATABASE_URL must be a postgres:// URL");
  }
  const db = createDatabase({
    databaseUrl,
    applicationName: "gerlines-api-search",
    maxConnections: 4,
    statementTimeoutMs: SEARCH_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: SEARCH_STATEMENT_TIMEOUT_MS + 5_000,
    connectionTimeoutMs: SEARCH_CONNECTION_TIMEOUT_MS,
    onPoolError: (error) => logger.error(`search database connection failed: ${error.message}`),
  });
  const placesFile = placesFileOf(env, cwd);
  const service = new SearchService({
    timetable: new DatabaseSearchSource(db),
    places: async () => {
      if (placesFile === undefined || !existsSync(placesFile)) {
        logger.error(
          `search places file ${placesFile ?? DEFAULT_PLACES_FILE} is missing: no places`,
        );
        return [];
      }
      return readPlaces(placesFile);
    },
    logger,
  });
  void service.ready();
  return service;
}
