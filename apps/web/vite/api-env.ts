import { parseEnv } from "node:util";

const FORWARDED_NAME =
  /^(APP_NAME|APP_CONTACT|SEARCH_[A-Z_]+|ROUTER_[A-Z_]+|STATS_[A-Z_]+|PHOTO_DIR|VEHICLE_DATABASE_URL)$/;

type Environment = Readonly<Record<string, string | undefined>>;

function forwarded(source: Environment): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && FORWARDED_NAME.test(name)) {
      picked[name] = value;
    }
  }
  return picked;
}

export function apiEnvironment(
  fileText: string | undefined,
  processEnvironment: Environment,
): Record<string, string> {
  const fromFile = fileText === undefined ? {} : forwarded(parseEnv(fileText));
  return { ...fromFile, ...forwarded(processEnvironment) };
}

/** The dev server reads statistics only from `STATS_DATABASE_URL`: the API's fallback to the search database would open a second pool, maybe as the owner. */
export function statsEnvironment(environment: Environment): Record<string, string> {
  const url = environment.STATS_DATABASE_URL;
  return url === undefined ? {} : { STATS_DATABASE_URL: url };
}
