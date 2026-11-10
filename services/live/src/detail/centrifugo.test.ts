import { describe, expect, it } from "vitest";
import { CentrifugoClient, CentrifugoError, plainHttpAllowed } from "./centrifugo.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(answer: unknown, status = 200) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("CentrifugoClient", () => {
  it("publishes in one batch and counts refused publications", async () => {
    const { calls, fetch } = fakeFetch({ replies: [{ publish: {} }, { error: { code: 102 } }] });
    const client = new CentrifugoClient({ baseUrl: "http://127.0.0.1:8000", apiKey: "k", fetch });
    const refused = await client.publish([
      { channel: "train:a", data: { v: 1 } },
      { channel: "train:b", data: { v: 2 } },
    ]);
    expect(refused).toBe(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8000/api/batch");
    expect(calls[0]?.body).toEqual({
      commands: [
        { publish: { channel: "train:a", data: { v: 1 } } },
        { publish: { channel: "train:b", data: { v: 2 } } },
      ],
    });
  });

  it("sends nothing for an empty batch", async () => {
    const { calls, fetch } = fakeFetch({});
    const client = new CentrifugoClient({ baseUrl: "http://127.0.0.1:8000", apiKey: "k", fetch });
    expect(await client.publish([])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("turns HTTP and API errors into one error type without the key", async () => {
    for (const [answer, status] of [
      [{}, 401],
      [{ error: { code: 103, message: "permission denied" } }, 200],
    ] as const) {
      const { fetch } = fakeFetch(answer, status);
      const client = new CentrifugoClient({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "secret-key",
        fetch,
      });
      const failure = await client
        .publish([{ channel: "train:a", data: {} }])
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CentrifugoError);
      expect(String((failure as Error).message)).not.toContain("secret-key");
    }
  });

  it("refuses a base URL that is not an origin", () => {
    expect(() => new CentrifugoClient({ baseUrl: "http://u:p@host:8000", apiKey: "k" })).toThrow(
      CentrifugoError,
    );
    expect(() => new CentrifugoClient({ baseUrl: "http://host:8000/api", apiKey: "k" })).toThrow(
      CentrifugoError,
    );
    expect(() => new CentrifugoClient({ baseUrl: "ftp://127.0.0.1", apiKey: "k" })).toThrow(
      CentrifugoError,
    );
  });

  it("sends the API key in clear text only to loopback or a compose service name", () => {
    for (const host of [
      "127.0.0.1",
      "127.8.9.1",
      "localhost",
      "[::1]",
      "centrifugo",
      "live-push",
    ]) {
      expect(plainHttpAllowed(new URL(`http://${host}:8000`).hostname)).toBe(true);
    }
    for (const host of ["push.gerlines.example", "10.0.0.5", "centrifugo.internal"]) {
      expect(plainHttpAllowed(host)).toBe(false);
      expect(() => new CentrifugoClient({ baseUrl: `http://${host}:8000`, apiKey: "k" })).toThrow(
        "https",
      );
    }
    expect(
      () => new CentrifugoClient({ baseUrl: "https://push.gerlines.example", apiKey: "k" }),
    ).not.toThrow();
  });
});
