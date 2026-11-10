import {
  STATS_PATHS,
  STATS_SEGMENT_NOTE,
  StatsLand,
  StatsLandCode,
  StatsLine,
  StatsLineName,
  StatsNetwork,
  StatsStation,
  StatsTrain,
  StatsTrainNumber,
  StatsTrainSegments,
} from "@gerlines/schema/stats";
import { z } from "zod";
import { statsPeriodQuerySchema, statsRunQuerySchema, statsTodayQuerySchema } from "./routes.ts";

const ErrorBody = z.object({
  error: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

const SOURCE_NOTE =
  "Read from the WP-2.7 rollups only (stop events of DELFI, gtfs.de, DB IRIS and the neighbours' feeds, each with its licence in docs/data-sources.md). Days before the live recording come from Deutsche Bahn train data, collected and processed by piebro (https://github.com/piebro/deutsche-bahn-data), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), data from Deutsche Bahn; they hold DB stations only, in whole minutes, without operators or lines. Shares are null when nothing was observed. punctual6 is DB's operational punctuality: arrivals less than 6 minutes late at intermediate and final stops, cancellations left out. Stops in Germany only for network figures. Up to about 40 minutes behind the live map.";

const SEGMENT_NOTE = `Read from the leg rollups stat_segment (this number) and segment_day (every train, all categories). The route is the number's most frequent stop sequence in the period, in stop order (onRoute), followed by its other legs by runs, at most 100. category and operator choose the runs of the number only, and of the category and operator groups left (groups, most runs first) only the first is profiled. A station under two stop place ids in the period (days loaded before stop places kept one identity across feed versions, or places it keeps apart) splits its segments and the route in two. Median and p80 come from the gain bins in whole minutes, a gain of exactly 0 counted as 0; a segment with fewer than 5 runs is missing with a reason, and speed is missing where no leg has a distance (the backfilled days have none). ${STATS_SEGMENT_NOTE}`;

function queryParameters(schema: z.ZodType) {
  const query = z.toJSONSchema(schema, { io: "input" }) as {
    properties: Record<string, { description?: string }>;
    required?: string[];
  };
  return Object.entries(query.properties).map(([name, property]) => ({
    name,
    in: "query",
    required: query.required?.includes(name) ?? false,
    description: property.description,
    schema: { ...property, description: undefined },
  }));
}

function pathSchema(schema: z.ZodType): object {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

function pathParameter(name: string, schema: object, description: string) {
  return { name, in: "path", required: true, description, schema };
}

function json(schema: z.ZodType, description: string) {
  return {
    description,
    content: { "application/json": { schema: z.toJSONSchema(schema, { io: "output" }) } },
  };
}

function responses(schema: z.ZodType, notFound = false) {
  return {
    "200": json(schema, "Statistics, cached 60 s for recent days and an hour for settled ones"),
    "400": json(ErrorBody, "invalid_request"),
    ...(notFound ? { "404": json(ErrorBody, "not_found") } : {}),
    "429": json(ErrorBody, "rate_limited, with Retry-After"),
    "503": json(ErrorBody, "not_configured, or stats_unavailable with Retry-After"),
  };
}

function operation(
  operationId: string,
  summary: string,
  schema: z.ZodType,
  query: z.ZodType,
  path: object[] = [],
  notFound = false,
  description = SOURCE_NOTE,
) {
  return {
    get: {
      operationId,
      summary,
      description,
      parameters: [...path, ...queryParameters(query)],
      responses: responses(schema, notFound),
    },
  };
}

/** OpenAPI path items of the statistics routes (WP-7.2). */
export function statsOpenApiPaths() {
  return {
    [STATS_PATHS.today]: operation(
      "statsToday",
      "Network statistics of today's Berlin service day",
      StatsNetwork,
      statsTodayQuerySchema,
    ),
    [STATS_PATHS.period]: operation(
      "statsPeriod",
      "Network statistics of a period of service days",
      StatsNetwork,
      statsPeriodQuerySchema,
    ),
    [STATS_PATHS.train]: operation(
      "statsTrain",
      "Statistics of one train number, per operator, category and line",
      StatsTrain,
      statsRunQuerySchema,
      [pathParameter("number", pathSchema(StatsTrainNumber), "Train number")],
    ),
    [STATS_PATHS.trainSegments]: operation(
      "statsTrainSegments",
      "Delay gain per segment of one train number against every train on the segment",
      StatsTrainSegments,
      statsRunQuerySchema,
      [pathParameter("number", pathSchema(StatsTrainNumber), "Train number")],
      false,
      `${SEGMENT_NOTE} ${SOURCE_NOTE}`,
    ),
    [STATS_PATHS.line]: operation(
      "statsLine",
      "Statistics of one line, per operator and category",
      StatsLine,
      statsRunQuerySchema,
      [pathParameter("line", pathSchema(StatsLineName), "Line name such as RE5 or S1")],
    ),
    [STATS_PATHS.station]: operation(
      "statsStation",
      "Statistics of one station by its stop place id",
      StatsStation,
      statsPeriodQuerySchema,
      [pathParameter("id", { type: "string", format: "uuid" }, "Stop place id")],
      true,
    ),
    [STATS_PATHS.land]: operation(
      "statsLand",
      "Statistics of one Land, from the stops inside it",
      StatsLand,
      statsPeriodQuerySchema,
      [
        pathParameter(
          "code",
          pathSchema(StatsLandCode),
          "Land code such as DE-BY, upper or lower case",
        ),
      ],
    ),
  };
}
