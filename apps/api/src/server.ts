import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { checkProductionSettings, readHost, readPort } from "./config.ts";
import { photosFromEnv } from "./photos/config.ts";
import { predictionsFromEnv } from "./predictions/config.ts";
import { readRouterConfig } from "./router/config.ts";
import { createRouterClient } from "./router/motis.ts";
import { readTrustedProxies } from "./search/client-address.ts";
import { searchFromEnv } from "./search/config.ts";
import { statsFromEnv } from "./stats/config.ts";
import { statusFromEnv } from "./status/config.ts";
import { liveStoreFromEnv } from "./trains/valkey.ts";
import { identityFromEnv } from "./vehicle/config.ts";

const VERSION = "0.0.0";
checkProductionSettings(process.env);
const port = readPort(process.env);
const hostname = readHost(process.env);
const routerConfig = readRouterConfig(process.env, VERSION);
const logger = { error: (line: string) => void process.stderr.write(`${line}\n`) };
const trains = liveStoreFromEnv(process.env, logger);
const search = searchFromEnv(process.env, logger);
const identity = identityFromEnv(process.env, VERSION, logger);
const photos = photosFromEnv(process.env, logger);
void photos?.warm();
const stats = statsFromEnv(process.env, logger);
const predictions = predictionsFromEnv(process.env, () => {
  const index = search?.current();
  if (!index) return null;
  return (stopPlaceId) => {
    const eva = index.station(stopPlaceId)?.eva;
    return eva ? Number(eva) : null;
  };
});
const status = statusFromEnv(process.env, logger, trains);
const trustedProxies = readTrustedProxies(process.env);

const app = createApp({
  router: routerConfig && {
    client: createRouterClient(routerConfig),
    datasetTag: routerConfig.datasetTag,
  },
  trains,
  identity,
  photos,
  predictions,
  search,
  stats,
  status,
  trustedProxies,
  version: VERSION,
});

serve({ fetch: app.fetch, port, hostname }, (info) => {
  process.stdout.write(`GerLines API listening on ${info.address} port ${info.port}\n`);
  if (!routerConfig) {
    process.stdout.write("ROUTER_BASE_URL is not set: journeys answer 503 not_configured\n");
  }
  if (!search) {
    process.stdout.write("SEARCH_DATABASE_URL is not set: search answers 503 not_configured\n");
  }
  if (!stats) {
    process.stdout.write("STATS_DATABASE_URL is not set: statistics answer 503 not_configured\n");
  }
  if (!status) {
    process.stdout.write(
      "No STATUS_, STATS_ or SEARCH_DATABASE_URL: data status answers 503 not_configured\n",
    );
  }
  if (!photos) {
    process.stdout.write("PHOTO_DIR or VEHICLE_DATABASE_URL is not set: details keep photo null\n");
  }
  if (!predictions) {
    process.stdout.write("PREDICTION_TABLE is not set: details keep forecast null\n");
  }
  if (!trains) {
    process.stdout.write("VALKEY_URL is not set: train details answer 503 not_configured\n");
  }
});
