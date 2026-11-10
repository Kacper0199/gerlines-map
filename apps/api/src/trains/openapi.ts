import { LiveKeyLookup, TrainDetail } from "@gerlines/schema";
import { z } from "zod";
import { LIVE_KEY_RATE_LIMIT, TRAIN_DETAIL_RATE_LIMIT } from "../limits.ts";
import {
  IDENTITY_DEADLINE_MS,
  IDENTITY_READS_MAX,
  LIVE_KEY_PATH,
  LIVE_SILENCE_MS,
  PHOTO_DEADLINE_MS,
  TRAIN_DETAIL_PATH,
} from "./routes.ts";

const ErrorBody = z.object({ error: z.string(), message: z.string().optional() });

const DETAIL_DESCRIPTION = `The train detail the live engine keeps for a running or recent trip instance: category, product, line and number, operator, destination, every stop with scheduled and predicted times, delays and platforms, the delay with its provenance (source, attribution and licence), whether a matched shape is available, and progress along the stops. Missing values are null, never zero or an empty string. vehicle is the identified series (the request waits at most ${IDENTITY_DEADLINE_MS} ms for it, and at most ${IDENTITY_READS_MAX} identity reads run at once; past either, vehicle is null); vehicle.source is the catalogue source id and vehicle.sourceName its catalogue display name, null when the catalogue has none. photo is the approved Wikimedia Commons photo of that series with its credit (waited for at most ${PHOTO_DEADLINE_MS} ms, else null). forecast is the delay forecast of the stops ahead (each stop says whether it starts from the feed's own prediction or from history alone), or null; it is never a measured value. The answer carries a strong ETag over the body and is cached for 5 s; If-None-Match with that ETag answers 304. While the live engine has not confirmed for ${LIVE_SILENCE_MS / 1000} s the route answers 503 live_unavailable. Each client may ask ${TRAIN_DETAIL_RATE_LIMIT} details a minute.`;

const KEY_DESCRIPTION = `The trip instance a frame key of the live frames stands for. Cached for an hour; a frame key can name another trip instance after the live store is reset. Each client may ask ${LIVE_KEY_RATE_LIMIT} keys a minute.`;

const RATE_LIMITED = "rate_limited, with Retry-After";
const UNAVAILABLE = "not_configured, or live_unavailable with Retry-After 5";

function json(schema: z.ZodType, description: string) {
  return {
    description,
    content: { "application/json": { schema: z.toJSONSchema(schema, { io: "output" }) } },
  };
}

export function openApiPath(routePath: string): string {
  return routePath.replace(/:(\w+)/g, "{$1}");
}

/** OpenAPI path items of the train detail and live key routes (WP-3.4, WP-6.2, WP-6.3, WP-7.5). */
export function trainOpenApiPaths() {
  return {
    [openApiPath(TRAIN_DETAIL_PATH)]: {
      get: {
        operationId: "trainDetail",
        summary: "Everything the train card shows for one trip instance",
        description: DETAIL_DESCRIPTION,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Trip instance id, upper or lower case",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "If-None-Match",
            in: "header",
            required: false,
            description: "The ETag of an earlier answer",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": json(TrainDetail, "The train detail, cached for 5 s, with an ETag"),
          "304": { description: "Not modified: the If-None-Match ETag is current" },
          "400": json(ErrorBody, "invalid_request: the id is not a UUID"),
          "404": json(ErrorBody, "not_found: no running or recent trip instance with this id"),
          "429": json(ErrorBody, RATE_LIMITED),
          "500": json(ErrorBody, "internal_error"),
          "503": json(ErrorBody, UNAVAILABLE),
        },
      },
    },
    [openApiPath(LIVE_KEY_PATH)]: {
      get: {
        operationId: "liveKey",
        summary: "The trip instance a live frame key stands for",
        description: KEY_DESCRIPTION,
        parameters: [
          {
            name: "key",
            in: "path",
            required: true,
            description: "Frame key, a whole number from 0 to 4294967295 without leading zeros",
            schema: { type: "string", pattern: "^(0|[1-9]\\d{0,9})$" },
          },
        ],
        responses: {
          "200": json(LiveKeyLookup, "The trip instance id, cached for an hour"),
          "400": json(ErrorBody, "invalid_request: the key is not a whole number in range"),
          "404": json(ErrorBody, "not_found: the live store holds no trip instance for this key"),
          "429": json(ErrorBody, RATE_LIMITED),
          "500": json(ErrorBody, "internal_error"),
          "503": json(ErrorBody, UNAVAILABLE),
        },
      },
    },
  };
}
