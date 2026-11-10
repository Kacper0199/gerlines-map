import { describe, expect, it } from "vitest";
import { openApiPath, trainOpenApiPaths } from "./openapi.ts";
import { TRAIN_DETAIL_PATH } from "./routes.ts";

interface JsonSchema {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly anyOf?: readonly JsonSchema[];
}

function detailSchema(): JsonSchema {
  const path = trainOpenApiPaths()[openApiPath(TRAIN_DETAIL_PATH)];
  return path?.get.responses["200"].content["application/json"].schema as JsonSchema;
}

describe("train detail OpenAPI schema", () => {
  it("gives vehicle.sourceName as an optional string that may be null", () => {
    const vehicle = detailSchema().properties?.vehicle?.anyOf?.find(
      (option) => option.type === "object",
    );
    expect(vehicle?.required).toContain("source");
    expect(vehicle?.required).not.toContain("sourceName");
    expect(vehicle?.properties?.sourceName?.anyOf?.map((option) => option.type).sort()).toEqual([
      "null",
      "string",
    ]);
  });
});
