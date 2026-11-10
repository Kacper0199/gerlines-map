import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { PHOTO_FILE_NAME_PATTERN } from "../photos/openapi.ts";
import { OPENAPI_PATH, openApiDocument } from "./openapi.ts";

type Operation = {
  operationId: string;
  parameters?: { name: string; in: string; required: boolean }[];
  responses: Record<string, { content?: Record<string, unknown> }>;
};
type Document = { paths: Record<string, Record<string, Operation>> };

function registeredRoutes(): string[] {
  return createApp({ logger: { error: () => undefined } })
    .routes.filter((route) => route.method !== "ALL")
    .map((route) => `${route.method} ${route.path.replace(/:(\w+)/g, "{$1}")}`);
}

function describedRoutes(document: Document): string[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
  );
}

function operation(path: string): Operation {
  const item = (openApiDocument("0.0.0") as Document).paths[path]?.get;
  if (!item) throw new Error(`${path} is not described`);
  return item;
}

describe("the OpenAPI document and the app", () => {
  it("describes every route the app registers", () => {
    const described = new Set(describedRoutes(openApiDocument("0.0.0") as Document));
    const missing = registeredRoutes().filter((route) => !described.has(route));
    expect(missing).toEqual([]);
  });

  it("describes no route the app does not register", () => {
    const registered = new Set(registeredRoutes());
    const extra = describedRoutes(openApiDocument("0.0.0") as Document).filter(
      (route) => !registered.has(route),
    );
    expect(extra).toEqual([]);
  });

  it("gives every operation a unique id", () => {
    const ids = Object.values((openApiDocument("0.0.0") as Document).paths).flatMap((item) =>
      Object.values(item).map((entry) => entry.operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names every path parameter of each path", () => {
    for (const [path, item] of Object.entries((openApiDocument("0.0.0") as Document).paths)) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      for (const entry of Object.values(item)) {
        const declared = (entry.parameters ?? [])
          .filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name);
        expect({ path, declared }).toEqual({ path, declared: inPath });
      }
    }
  });

  it("is served at its path", async () => {
    const response = await createApp({ logger: { error: () => undefined } }).request(OPENAPI_PATH);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Document).paths[OPENAPI_PATH]).toBeDefined();
  });
});

describe("train, live key and photo operations", () => {
  it("describes the train detail with its answers", () => {
    const detail = operation("/api/v1/trains/{id}");
    expect(detail.operationId).toBe("trainDetail");
    expect(Object.keys(detail.responses).sort()).toEqual([
      "200",
      "304",
      "400",
      "404",
      "429",
      "500",
      "503",
    ]);
    expect(detail.responses["200"]?.content?.["application/json"]).toBeDefined();
  });

  it("describes the live key lookup with its answers", () => {
    const key = operation("/api/v1/live/keys/{key}");
    expect(key.operationId).toBe("liveKey");
    expect(Object.keys(key.responses).sort()).toEqual(["200", "400", "404", "429", "500", "503"]);
  });

  it("describes the photo credits without a rate limit answer", () => {
    const photos = operation("/api/v1/photos");
    expect(photos.operationId).toBe("photos");
    expect(Object.keys(photos.responses).sort()).toEqual(["200", "500", "503"]);
  });

  it("describes a photo file as an image", () => {
    const file = operation("/api/v1/photos/{file}");
    expect(file.operationId).toBe("photoFile");
    expect(Object.keys(file.responses["200"]?.content ?? {}).sort()).toEqual([
      "image/jpeg",
      "image/png",
    ]);
    expect(Object.keys(file.responses).sort()).toEqual(["200", "304", "404", "429", "500", "503"]);
  });

  it("gives the photo file name the pattern the service matches, without the path prefix", () => {
    const name = new RegExp(PHOTO_FILE_NAME_PATTERN);
    expect(PHOTO_FILE_NAME_PATTERN.startsWith("^(")).toBe(true);
    expect(name.test("br-411-front-330-0123456789ab.jpg")).toBe(true);
    expect(name.test("br-411-front-960-0123456789ab.png")).toBe(true);
    expect(name.test("br-411-front-500-0123456789ab.jpg")).toBe(false);
    expect(name.test("../br-411-front-330-0123456789ab.jpg")).toBe(false);
  });
});
