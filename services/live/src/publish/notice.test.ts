import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Head } from "@gerlines/live-frame";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackgroundNotifier,
  CentrifugoNotifier,
  ChangedHeadNotifier,
  FRAMES_CHANNEL,
  type Notifier,
} from "./notice.ts";

const head = (sequence: number): Head => ({
  kind: "head",
  sequence,
  timetableVersion: 1,
  timeBase: 1_792_922_400 + sequence,
  keyframeSequence: 1,
  oldestSequence: 1,
});

describe("BackgroundNotifier", () => {
  it("returns at once while a request hangs and sends only the newest waiting head", async () => {
    const sent: number[] = [];
    let release: () => void = () => {};
    const inner: Notifier = {
      notify: (h) => {
        sent.push(h.sequence);
        return sent.length === 1
          ? new Promise<void>((resolve) => (release = resolve))
          : Promise.resolve();
      },
    };
    const notifier = new BackgroundNotifier(inner);
    const started = performance.now();
    for (let sequence = 1; sequence <= 5; sequence++) {
      await notifier.notify(head(sequence));
      await Promise.resolve();
    }
    expect(performance.now() - started).toBeLessThan(50);
    release();
    await notifier.idle();
    expect(sent).toEqual([1, 5]);
    expect(notifier.skipped).toBe(3);
  });
});

let server: Server | null = null;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
  server = null;
});

async function listen(
  handle: (request: IncomingMessage, body: string, response: ServerResponse) => void,
): Promise<string> {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => handle(request, body, response));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("CentrifugoNotifier", () => {
  it("publishes the notice to the frames channel with the API key", async () => {
    const requests: { path?: string; key?: string; body: unknown }[] = [];
    const url = await listen((request, body, response) => {
      requests.push({
        ...(request.url ? { path: request.url } : {}),
        ...(typeof request.headers["x-api-key"] === "string"
          ? { key: request.headers["x-api-key"] }
          : {}),
        body: JSON.parse(body),
      });
      response.end("{}");
    });
    const notifier = new CentrifugoNotifier(url, "local-key");
    await notifier.notify(head(9));
    expect(notifier.sent).toBe(1);
    expect(requests).toEqual([
      {
        path: "/api/publish",
        key: "local-key",
        body: { channel: FRAMES_CHANNEL, data: { seq: 9, keyframe: 1, oldest: 1, tv: 1 } },
      },
    ]);
  });

  it("counts a refused key, an error body and a hanging server as failures", async () => {
    let mode = "401";
    const url = await listen((_request, _body, response) => {
      if (mode === "401") {
        response.statusCode = 401;
        response.end();
      } else if (mode === "error") {
        response.end(JSON.stringify({ error: { message: "unknown channel" } }));
      }
    });
    const notifier = new CentrifugoNotifier(url, "wrong", 150);
    await notifier.notify(head(1));
    mode = "error";
    await notifier.notify(head(2));
    expect(notifier.lastError).toBe("unknown channel");
    mode = "hang";
    const started = performance.now();
    await notifier.notify(head(3));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(notifier.failed).toBe(3);
    expect(notifier.sent).toBe(0);
  });
});

describe("ChangedHeadNotifier", () => {
  it("passes a head on only when its sequence, keyframe or version changed", async () => {
    const sent: number[] = [];
    const notifier = new ChangedHeadNotifier({ notify: async (h) => void sent.push(h.sequence) });
    await notifier.notify(head(1));
    await notifier.notify(head(1));
    await notifier.notify({ ...head(1), timeBase: head(1).timeBase + 1 });
    await notifier.notify(head(2));
    expect(sent).toEqual([1, 2]);
  });
});
