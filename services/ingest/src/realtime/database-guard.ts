/** Databases realtime processing may write without being told twice: builder and test copies. */
const THROWAWAY_DATABASE = /^gerlines_(wp\d+[a-z0-9]*|rt[a-z0-9_]*|test[a-z0-9_]*)$/;

/**
 * The database name a connection string selects, read the way `pg-connection-string` 2.x reads it
 * (the URL path, percent escapes decoded with `decodeURI`), so `%67erlines` is `gerlines`.
 */
export function databaseNameOf(connectionString: string): string | null {
  let text = connectionString;
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(text)) {
    text = encodeURI(text).replace(/%25(\d\d)/g, "%$1");
  }
  let parsed: URL;
  try {
    parsed = new URL(text, "postgres://base");
  } catch {
    parsed = new URL(text.replace("@/", "@___DUMMY___/"), "postgres://base");
  }
  const path = parsed.pathname.slice(1);
  if (!path) return null;
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/**
 * Refuses a database realtime processing must not write: any name but a builder or test copy
 * (`gerlines_wp23`, `gerlines_rt`, `gerlines_test…`), unless `allowShared` says so on purpose.
 */
export function assertThrowawayDatabase(name: string | null, allowShared: boolean): void {
  if (name === null || name === "") {
    throw new Error(
      "DATABASE_URL names no database; name a throwaway database such as gerlines_rt",
    );
  }
  if (allowShared || THROWAWAY_DATABASE.test(name)) return;
  throw new Error(
    `database ${JSON.stringify(name)} is not a throwaway database (gerlines_wp<n>, gerlines_rt…, gerlines_test…); pass --allow-shared to process into it on purpose`,
  );
}
