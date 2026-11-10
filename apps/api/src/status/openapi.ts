import { DataStatus, STATUS_PATH } from "@gerlines/schema/status";
import { z } from "zod";

const ErrorBody = z.object({ error: z.string() });

const DESCRIPTION =
  "Per source of the live map: recordedAt, the newest payload the recorder stored (an unchanged answer stores none), dataTime, the newest payload of it the live engine folded, the recorder's staleness threshold and a state. ok within the threshold; stale past it, or when the map's payload is older than the threshold; down after an hour without new data (or three thresholds) or while the recorder does not fetch it; not_recorded with no stored payload. Timetables have no threshold. live is the age of the live engine's last confirmed tick: stale after 30 s, down after 15 min or without one, not_recorded when the live store gives no reading. One answer per 30 s for all clients.";

function json(schema: z.ZodType, description: string) {
  return {
    description,
    content: { "application/json": { schema: z.toJSONSchema(schema, { io: "output" }) } },
  };
}

/** OpenAPI path item of the data status route (WP-9.7a). */
export function statusOpenApiPaths() {
  return {
    [STATUS_PATH]: {
      get: {
        operationId: "dataStatus",
        summary: "How fresh each data source of the map is",
        description: DESCRIPTION,
        responses: {
          "200": json(DataStatus, "The status, cached until 30 s after it was read"),
          "429": json(ErrorBody, "rate_limited, with Retry-After"),
          "503": json(ErrorBody, "not_configured, or status_unavailable with Retry-After"),
        },
      },
    },
  };
}
