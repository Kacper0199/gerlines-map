import { SEARCH_PATH, SearchResponse, SearchStation } from "@gerlines/schema/search";
import type { Hono } from "hono";
import { z } from "zod";
import { journeyOpenApiPaths } from "../journeys/openapi.ts";
import { photoOpenApiPaths } from "../photos/openapi.ts";
import { statsOpenApiPaths } from "../stats/openapi.ts";
import { statusOpenApiPaths } from "../status/openapi.ts";
import { trainOpenApiPaths } from "../trains/openapi.ts";
import { searchQuerySchema } from "./routes.ts";

export const OPENAPI_PATH = "/api/v1/openapi.json";
export const HEALTH_PATH = "/api/health";

const ErrorBody = z.object({
  error: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

function parameters() {
  const query = z.toJSONSchema(searchQuerySchema, { io: "input" }) as {
    properties: Record<string, { description?: string }>;
    required?: string[];
  };
  return Object.entries(query.properties).map(([name, schema]) => ({
    name,
    in: "query",
    required: query.required?.includes(name) ?? false,
    description: schema.description,
    schema: { ...schema, description: undefined },
  }));
}

function json(schema: z.ZodType, description: string) {
  return {
    description,
    content: { "application/json": { schema: z.toJSONSchema(schema, { io: "output" }) } },
  };
}

const HealthBody = z.object({ status: z.literal("ok") });

/** OpenAPI 3.1 of every route the app registers, described from their zod schemas. */
export function openApiDocument(version: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "GerLines API",
      version,
      license: { name: "AGPL-3.0-or-later", identifier: "AGPL-3.0-or-later" },
    },
    servers: [{ url: "/", description: "The origin that serves the web client" }],
    security: [],
    paths: {
      [HEALTH_PATH]: {
        get: {
          operationId: "health",
          summary: "Whether the API process answers",
          description:
            "Answers ok while the process runs; it checks no dependency. The router, the data sources and the live engine have their own health and status routes.",
          responses: { "200": json(HealthBody, "ok") },
        },
      },
      [OPENAPI_PATH]: {
        get: {
          operationId: "openApi",
          summary: "This OpenAPI 3.1 document",
          responses: {
            "200": {
              description: "The document, cached for 5 minutes",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      ...journeyOpenApiPaths(),
      ...trainOpenApiPaths(),
      ...photoOpenApiPaths(),
      [SEARCH_PATH]: {
        get: {
          operationId: "search",
          summary: "Stations, trains, lines and places for a typed text",
          description:
            "Stations, trains and lines of today's Berlin service day from the DELFI timetable (CC BY 4.0), places from BKG VG250 (DL-DE-BY-2.0) with Natural Earth names. German umlauts match their two-letter spellings (ü and ue).",
          parameters: parameters(),
          responses: {
            "200": json(SearchResponse, "Results ranked best first"),
            "400": json(ErrorBody, "invalid_request"),
            "429": json(ErrorBody, "rate_limited, with Retry-After"),
            "503": json(ErrorBody, "not_configured or search_unavailable, with Retry-After"),
          },
        },
      },
      "/api/v1/stations/{id}": {
        get: {
          operationId: "station",
          summary: "One station of today's index by its stop place id",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": json(SearchStation, "The station"),
            "400": json(ErrorBody, "invalid_request"),
            "404": json(ErrorBody, "not_found"),
            "429": json(ErrorBody, "rate_limited, with Retry-After"),
            "503": json(ErrorBody, "not_configured or search_unavailable, with Retry-After"),
          },
        },
      },
      ...statsOpenApiPaths(),
      ...statusOpenApiPaths(),
    },
  };
}

export function registerOpenApiRoute(app: Hono, version: string): void {
  const document = openApiDocument(version);
  app.get(OPENAPI_PATH, (context) => {
    context.header("Cache-Control", "public, max-age=300");
    return context.json(document);
  });
}
