import { describe, expect, it } from "vitest";
import {
  type SequenceClientOptions,
  type SequenceQuery,
  VehicleSequenceClient,
} from "./vehicle-sequence.ts";

const QUERY: SequenceQuery = {
  category: "ICE",
  trainNumber: "586",
  serviceDate: "2026-11-07",
  eva: 8000284,
  departure: "2026-11-07T15:32:00.000Z",
};

function failingBody(): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new DOMException("The operation timed out.", "TimeoutError"));
    },
  });
  return new Response(body, { status: 200 });
}

const ANSWER = { sequenceStatus: "MATCHES_SCHEDULE", groups: [] };

function client(
  fetcher: typeof fetch,
  clock = { t: Date.parse("2026-11-07T12:00:00Z") },
  options: Partial<SequenceClientOptions> = {},
) {
  return new VehicleSequenceClient({
    userAgent: "gerlines-test/0.0.0 (+https://example.org)",
    fetch: fetcher,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    minIntervalMs: 3_000,
    ...options,
  });
}

function scripted(statuses: number[]) {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    const status = statuses.shift() ?? 200;
    return new Response(status === 200 ? JSON.stringify(ANSWER) : "", { status });
  }) as unknown as typeof fetch;
  return { fetcher, urls };
}

const train = (trainNumber: string, serviceDate = QUERY.serviceDate) => ({
  ...QUERY,
  trainNumber,
  serviceDate,
});

describe("VehicleSequenceClient failure paths", () => {
  it("answers failed when the body cannot be read", async () => {
    const sequence = client((async () => failingBody()) as unknown as typeof fetch);
    expect(await sequence.get(QUERY)).toEqual({ status: "failed", reason: "TimeoutError" });
  });

  it("answers failed for a body above the size limit without reading all of it", async () => {
    const maxBodyBytes = 4_096;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1_024));
        if (pulls * 1_024 >= maxBodyBytes * 4) controller.close();
      },
    });
    const sequence = client(
      (async () => new Response(body)) as unknown as typeof fetch,
      undefined,
      { maxBodyBytes },
    );
    expect(await sequence.get(QUERY)).toEqual({ status: "failed", reason: "too large" });
    expect(pulls).toBeLessThan(10);
  });

  it("retries a failed train only after a backoff that doubles", async () => {
    const clock = { t: Date.parse("2026-11-07T12:00:00Z") };
    const { fetcher, urls } = scripted([500, 500, 200]);
    const sequence = client(fetcher, clock, { retryAfterMs: 60_000 });
    expect((await sequence.get(QUERY)).status).toBe("failed");
    expect(sequence.knows(QUERY.serviceDate, QUERY.trainNumber)).toBe(true);
    clock.t += 59_000;
    expect((await sequence.get(QUERY)).status).toBe("failed");
    expect(urls).toHaveLength(1);
    clock.t += 2_000;
    expect((await sequence.get(QUERY)).status).toBe("failed");
    expect(urls).toHaveLength(2);
    clock.t += 100_000;
    expect((await sequence.get(QUERY)).status).toBe("failed");
    expect(urls).toHaveLength(2);
    clock.t += 30_000;
    expect((await sequence.get(QUERY)).status).toBe("ok");
    expect(urls).toHaveLength(3);
  });

  it("calls again once a block has expired, and not before", async () => {
    const clock = { t: Date.parse("2026-11-07T12:00:00Z") };
    const { fetcher, urls } = scripted([429, 200]);
    const sequence = client(fetcher, clock, { blockedForMs: 3_600_000 });
    expect((await sequence.get(QUERY)).status).toBe("blocked");
    clock.t += 3_599_000;
    expect((await sequence.get(train("587"))).status).toBe("blocked");
    expect(urls).toHaveLength(1);
    clock.t += 2_000;
    expect(sequence.blocked).toBe(false);
    expect((await sequence.get(QUERY)).status).toBe("ok");
    expect(urls).toHaveLength(2);
  });

  it("answers busy beyond the queue cap and the hourly budget", async () => {
    const clock = { t: Date.parse("2026-11-07T12:00:00Z") };
    const queued = client(scripted([]).fetcher, clock, { maxQueued: 2 });
    const results = await Promise.all(["1", "2", "3", "4"].map((n) => queued.get(train(n))));
    expect(results.map((result) => result.status)).toEqual(["ok", "ok", "busy", "busy"]);
    expect(queued.knows(QUERY.serviceDate, "3")).toBe(false);

    const { fetcher, urls } = scripted([]);
    const budget = client(fetcher, clock, { maxCallsPerHour: 2 });
    for (const n of ["1", "2", "3"]) await budget.get(train(n));
    expect(urls).toHaveLength(2);
    expect((await budget.get(train("3"))).status).toBe("busy");
    clock.t += 3_600_000;
    expect((await budget.get(train("3"))).status).toBe("ok");
    expect(urls).toHaveLength(3);
  });

  it("forgets trains of service days two days old", async () => {
    const clock = { t: Date.parse("2026-11-07T12:00:00Z") };
    const sequence = client(scripted([]).fetcher, clock);
    await sequence.get(train("1", "2026-11-06"));
    await sequence.get(train("2", "2026-11-07"));
    expect(sequence.size).toBe(2);
    clock.t = Date.parse("2026-11-09T00:30:00Z");
    await sequence.get(train("3", "2026-11-09"));
    expect(sequence.knows("2026-11-06", "1")).toBe(false);
    expect(sequence.knows("2026-11-07", "2")).toBe(true);
    expect(sequence.size).toBe(2);
  });
});
