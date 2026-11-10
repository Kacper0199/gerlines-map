import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, searchFromEnv } from "@gerlines/api";

const USAGE = `Usage: node e2e/fixture/build-search.ts <out dir> <lang:query> [<lang:query> ...]

Asks our API's search route, run in process over SEARCH_DATABASE_URL (a read-only database) and the places file, for
each query and writes the answer to <out dir>/<lang>-<query lowercased>.json. Example: en:Bayern
`;

const [out, ...queries] = process.argv.slice(2);
if (!out || queries.length === 0) {
  process.stdout.write(USAGE);
  process.exit(2);
}

const logger = { error: (line: string) => process.stderr.write(`${line}\n`) };
const search = searchFromEnv(process.env, logger);
if (!search) throw new Error("SEARCH_DATABASE_URL must be set");
await search.ready();
const app = createApp({ search, logger });
mkdirSync(out, { recursive: true });
for (const entry of queries) {
  const [lang, query] = entry.split(":") as [string, string];
  const response = await app.request(`/api/v1/search?${new URLSearchParams({ q: query, lang })}`);
  if (!response.ok) throw new Error(`${entry}: ${response.status}`);
  writeFileSync(
    join(out, `${lang}-${query.toLowerCase()}.json`),
    `${JSON.stringify(await response.json())}\n`,
  );
  process.stdout.write(`${entry} ok\n`);
}
process.exit(0);
