import {
  JOURNEY_RELIABILITY_PATH,
  JOURNEY_RELIABILITY_TRAINS_MAX,
  JOURNEY_RESULTS_DEFAULT,
  JOURNEYS_PATH,
  JourneyReliabilityResponse,
  JourneysResponse,
  ROUTER_HEALTH_PATH,
} from "@gerlines/schema/journeys";
import { z } from "zod";
import { journeyQuerySchema } from "./query.ts";

const ErrorBody = z.object({
  error: z.string(),
  message: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

const HealthBody = z.object({
  status: z.enum(["ok", "unavailable", "not_configured"]),
  latencyMs: z.int().nonnegative().optional(),
});

const PARAMETER_DEFAULTS: Readonly<Record<string, string>> = {
  arriveBy: "false",
  exclude: "",
  operators: "",
  avoidOperators: "",
  results: String(JOURNEY_RESULTS_DEFAULT),
  geometry: "false",
};

function parameters() {
  const query = z.toJSONSchema(journeyQuerySchema, { io: "input" }) as {
    properties: Record<string, { description?: string }>;
    required?: string[];
  };
  return Object.entries(query.properties).map(([name, schema]) => ({
    name,
    in: "query",
    required: query.required?.includes(name) ?? false,
    description: schema.description,
    schema: {
      ...schema,
      description: undefined,
      ...(name in PARAMETER_DEFAULTS ? { default: PARAMETER_DEFAULTS[name] } : {}),
    },
  }));
}

function json(schema: z.ZodType, description: string) {
  return {
    description,
    content: { "application/json": { schema: z.toJSONSchema(schema, { io: "output" }) } },
  };
}

/** OpenAPI 3.1 path items of the journeys routes (WP-8.1). */
export function journeyOpenApiPaths() {
  return {
    [JOURNEYS_PATH]: {
      get: {
        operationId: "journeys",
        summary: "Journeys from one stop to another with category, product and operator filters",
        description:
          "Journeys over the DELFI timetable (CC BY 4.0, DELFI e.V.), routed by MOTIS. Every leg must belong to the chosen categories and pass the product and operator filters; journeys with a leg outside them are left out and counted in removedBy. When fewer than results journeys remain (results is a minimum, not a cap), further pages in the search direction are searched, at most three router calls. Cursors page earlier and later with the same query.",
        parameters: parameters(),
        responses: {
          "200": json(
            JourneysResponse,
            "Journeys in the chosen order, each tagged where it is best",
          ),
          "400": json(ErrorBody, "invalid_request with every issue"),
          "404": json(ErrorBody, "stop_not_found"),
          "422": json(ErrorBody, "router_rejected, for example a time outside the timetable"),
          "429": json(ErrorBody, "rate_limited, with Retry-After"),
          "500": json(ErrorBody, "internal_error"),
          "503": json(
            ErrorBody,
            "not_configured, router_unavailable, or router_busy with Retry-After when six router calls are in flight",
          ),
        },
      },
    },
    [JOURNEY_RELIABILITY_PATH]: {
      get: {
        operationId: "journeyReliability",
        summary: "Punctuality of the trains of a journey over the last 30 days",
        description:
          "For each train, the share of observed arrivals less than 6 minutes late over the last 30 Berlin service days, from the statistics rollups (up to about 40 minutes behind). Only the groups of the train's category count; when several operators run the number, the one the operator name starts like is used, else the answer is missing with reason ambiguous. Missing data stays missing with its reason.",
        parameters: [
          {
            name: "train",
            in: "query",
            required: true,
            description: `category~number with an optional ~operator name (the leg's agency name), repeated, at most ${JOURNEY_RELIABILITY_TRAINS_MAX}; for example hsr~597~DB Fernverkehr AG`,
            schema: {
              type: "array",
              items: { type: "string" },
              maxItems: JOURNEY_RELIABILITY_TRAINS_MAX,
            },
            style: "form",
            explode: true,
          },
        ],
        responses: {
          "200": json(JourneyReliabilityResponse, "One entry per asked train, in the asked order"),
          "400": json(ErrorBody, "invalid_request"),
          "429": json(ErrorBody, "rate_limited, with Retry-After"),
          "503": json(ErrorBody, "not_configured, or stats_unavailable with Retry-After"),
        },
      },
    },
    [ROUTER_HEALTH_PATH]: {
      get: {
        operationId: "routerHealth",
        summary: "Whether the journey router answers",
        responses: {
          "200": json(HealthBody, "ok with the router's answer time"),
          "503": json(HealthBody, "unavailable or not_configured"),
        },
      },
    },
  };
}
