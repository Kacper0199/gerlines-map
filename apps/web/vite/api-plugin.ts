import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import {
  createApp,
  createRouterClient,
  photosFromEnv,
  readRouterConfig,
  searchFromEnv,
  statsFromEnv,
} from "@gerlines/api";
import { getRequestListener } from "@hono/node-server";
import type { Connect, Plugin } from "vite";
import { apiEnvironment, statsEnvironment } from "./api-env.ts";
import { handsOffDetail } from "./detail-proxy.ts";

const API_PREFIX = "/api/";

function findRepositoryRoot(start: string): string | undefined {
  let directory = start;
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  return directory;
}

function readRepositoryEnvironmentFile(): string | undefined {
  const root = findRepositoryRoot(process.cwd());
  const file = root ? join(root, ".env") : undefined;
  return file && existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

type Listener = (request: IncomingMessage, response: ServerResponse) => unknown;

export function apiMiddleware(
  listener: Listener,
  detailTarget: string | undefined,
): Connect.NextHandleFunction {
  return (request, response, next) => {
    if (request.url?.startsWith(API_PREFIX) && !handsOffDetail(request.url, detailTarget)) {
      void listener(request, response);
      return;
    }
    next();
  };
}

export function gerlinesApi(): Plugin {
  return {
    name: "gerlines-api",
    apply: "serve",
    configureServer(server) {
      const environment = apiEnvironment(readRepositoryEnvironmentFile(), process.env);
      const logger = { error: (line: string) => server.config.logger.error(line) };
      const version = process.env.npm_package_version ?? "0.0.0";
      const router = readRouterConfig(environment, version);
      const app = createApp({
        search: searchFromEnv(environment, logger),
        router: router && { client: createRouterClient(router), datasetTag: router.datasetTag },
        photos: photosFromEnv(environment, logger),
        stats: statsFromEnv(statsEnvironment(environment), logger),
        logger,
      });
      const listener = getRequestListener(app.fetch);
      server.middlewares.use(apiMiddleware(listener, process.env.DETAIL_PROXY_TARGET));
    },
  };
}
