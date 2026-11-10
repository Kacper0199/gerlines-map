export type Env = Readonly<Record<string, string | undefined>>;

export const localDefaults = {
  host: "127.0.0.1",
  port: "5433",
  user: "gerlines",
  password: "change-me-locally",
  database: "gerlines",
} as const;

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const addressParameters = new Set(["host", "hostaddr", "port"]);
const secretParameters = new Set(["password", "sslpassword", "sslkey", "sslcert"]);

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function resolveDatabaseUrl(env: Env): string {
  const explicit = nonEmpty(env.DATABASE_URL);
  if (explicit) {
    return parseDatabaseUrl(explicit).toString();
  }
  const url = new URL("postgres://placeholder");
  url.hostname = nonEmpty(env.POSTGRES_HOST) ?? localDefaults.host;
  url.port = nonEmpty(env.POSTGRES_PORT) ?? localDefaults.port;
  url.username = encodeURIComponent(nonEmpty(env.POSTGRES_USER) ?? localDefaults.user);
  url.password = encodeURIComponent(nonEmpty(env.POSTGRES_PASSWORD) ?? localDefaults.password);
  url.pathname = `/${encodeURIComponent(nonEmpty(env.POSTGRES_DB) ?? localDefaults.database)}`;
  return url.toString();
}

export function parseDatabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("database URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`database URL must use postgres:// or postgresql://, got ${url.protocol}//`);
  }
  if (url.pathname.length <= 1) {
    throw new Error("database URL must name a database");
  }
  if ([...url.searchParams.keys()].some((key) => addressParameters.has(key.toLowerCase()))) {
    throw new Error("database URL must not set host, hostaddr or port as a query parameter");
  }
  return url;
}

export function withDatabase(databaseUrl: string, database: string): string {
  const url = parseDatabaseUrl(databaseUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

export function isLoopbackDatabaseUrl(databaseUrl: string): boolean {
  return loopbackHosts.has(parseDatabaseUrl(databaseUrl).hostname);
}

export function redactDatabaseUrl(databaseUrl: string): string {
  const url = parseDatabaseUrl(databaseUrl);
  if (url.password !== "") {
    url.password = "redacted";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (secretParameters.has(key.toLowerCase())) {
      url.searchParams.set(key, "redacted");
    }
  }
  return url.toString();
}
