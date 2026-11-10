import { PHOTO_FILE } from "@gerlines/schema";
import { PHOTOS_PATH, PhotoCredits } from "@gerlines/schema/photos";
import { z } from "zod";
import { PHOTO_FILE_RATE_LIMIT } from "../limits.ts";
import { openApiPath } from "../trains/openapi.ts";
import { PHOTO_FILE_PATH } from "./routes.ts";
import { COLD_RETRY_MS } from "./service.ts";

const ErrorBody = z.object({ error: z.string() });

const PREFIX = `^${PHOTOS_PATH.replaceAll("/", "\\/")}\\/`;

/** The file name part of a photo copy's URL, from the pattern the service matches names with. */
export const PHOTO_FILE_NAME_PATTERN = PHOTO_FILE.source.replace(PREFIX, "^");

const UNAVAILABLE = `not_configured, or photos_unavailable with Retry-After ${COLD_RETRY_MS / 1000} while the photo catalogue has not loaded`;

function json(schema: z.ZodType, description: string) {
  return {
    description,
    content: { "application/json": { schema: z.toJSONSchema(schema, { io: "output" }) } },
  };
}

/** OpenAPI path items of the photo credits and photo file routes (WP-6.3). */
export function photoOpenApiPaths() {
  return {
    [PHOTOS_PATH]: {
      get: {
        operationId: "photos",
        summary: "Every approved vehicle photo with its credit",
        description:
          "Approved vehicle photos from Wikimedia Commons for the credits page: the series name, the local copies at 330 and 960 px, the crop focus, the title, the author with an optional link, the licence as shown with its link, and the Commons file page. Cached for an hour.",
        responses: {
          "200": json(PhotoCredits, "Every approved photo, cached for an hour"),
          "500": json(ErrorBody, "internal_error"),
          "503": json(ErrorBody, UNAVAILABLE),
        },
      },
    },
    [openApiPath(PHOTO_FILE_PATH)]: {
      get: {
        operationId: "photoFile",
        summary: "One stored copy of an approved photo",
        description: `One local copy of an approved photo. The name carries the photo id, the width class and the first 12 hex digits of the copy's SHA-256, so a copy never changes under its URL: it is cached for a year as immutable, with the full SHA-256 as its ETag, and served with a sandboxing Content-Security-Policy. A copy whose bytes differ from the recorded SHA-256 is never served. A name that matches no approved copy answers 404. Each client may fetch ${PHOTO_FILE_RATE_LIMIT} files a minute.`,
        parameters: [
          {
            name: "file",
            in: "path",
            required: true,
            description:
              "<photo id>-<330 or 960>-<12 hex digits>.<jpg or png>, as the url of a photo's small or large copy names it",
            schema: { type: "string", maxLength: 100, pattern: PHOTO_FILE_NAME_PATTERN },
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
          "200": {
            description: "The image, cached for a year",
            content: { "image/jpeg": {}, "image/png": {} },
          },
          "304": { description: "Not modified: the If-None-Match ETag is current" },
          "404": json(ErrorBody, "not_found"),
          "429": json(ErrorBody, "rate_limited, with Retry-After"),
          "500": json(ErrorBody, "internal_error"),
          "503": json(ErrorBody, UNAVAILABLE),
        },
      },
    },
  };
}
