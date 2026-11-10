import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDetail } from "../components/train/test-detail.ts";
import { fetchTrainDetail } from "./use-train-detail.ts";

const detail = testDetail();
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url !== `/api/v1/trains/${detail.tripInstanceId}`) {
      response.writeHead(404).end();
      return;
    }
    const etag = `"${detail.timetableVersion}.${detail.version}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag }).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json", "cache-control": "max-age=5", etag })
      .end(JSON.stringify(detail));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("fetchTrainDetail against a local server", () => {
  it("reads the detail, then a 304 with the etag, then a 404 for an unknown train", async () => {
    const first = await fetchTrainDetail(detail.tripInstanceId, { fetch, baseUrl });
    expect(first.kind).toBe("ok");
    const etag = first.kind === "ok" ? first.etag : null;
    expect(etag).toBe('"delfi-2026-10-26.3"');
    expect((await fetchTrainDetail(detail.tripInstanceId, { fetch, baseUrl, etag })).kind).toBe(
      "not-modified",
    );
    expect(
      (await fetchTrainDetail("6f1c2a7e-6c3b-5d55-9a43-2f6b8e0c1d12", { fetch, baseUrl })).kind,
    ).toBe("not-found");
  });
});
