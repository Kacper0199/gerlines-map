import { createRequire } from "node:module";
import { createApp } from "../../apps/api/src/app.ts";
import { readHost, readPort } from "../../apps/api/src/config.ts";
import { readTrustedProxies } from "../../apps/api/src/search/client-address.ts";
import { searchFromEnv } from "../../apps/api/src/search/config.ts";
import { statsFromEnv } from "../../apps/api/src/stats/config.ts";
import { statusFromEnv } from "../../apps/api/src/status/config.ts";
import { liveStoreFromEnv } from "../../apps/api/src/trains/valkey.ts";
import { decodeHead } from "../../packages/live-frame/src/index.ts";

const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { serve } = (await import(
  apiRequire.resolve("@hono/node-server")
)) as typeof import("@hono/node-server");

const liveOrigin = process.env.LOAD_LIVE_ORIGIN ?? "http://127.0.0.1:8814";
const headResponse = await fetch(`${liveOrigin}/live/v1/head`);
if (!headResponse.ok) throw new Error(`live head answered ${headResponse.status}`);
const head = decodeHead(new Uint8Array(await headResponse.arrayBuffer()));
const replayOffsetMs = Date.now() - head.timeBase * 1000;

const logger = { error: (line: string) => void process.stderr.write(`${line}\n`) };
const trains = liveStoreFromEnv(process.env, logger);
const app = createApp({
  trains,
  search: searchFromEnv(process.env, logger),
  stats: statsFromEnv(process.env, logger),
  status: statusFromEnv(process.env, logger, trains),
  trustedProxies: readTrustedProxies(process.env),
  now: () => Date.now() - replayOffsetMs,
  logger,
});

serve(
  { fetch: app.fetch, port: readPort(process.env), hostname: readHost(process.env) },
  (info) => {
    process.stdout.write(
      `load API on ${info.address} port ${info.port}, replay clock ${Math.round(replayOffsetMs / 1000)} s behind\n`,
    );
  },
);
