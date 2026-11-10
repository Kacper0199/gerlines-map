import { describe, expect, it } from "vitest";
import { loadPlanFixture } from "./fixtures.ts";
import {
  createRouterClient,
  type PlanRequest,
  RouterRejectedError,
  RouterUnavailableError,
} from "./motis.ts";

const REQUEST: PlanRequest = {
  fromPlace: "de-DELFI_de:11000:900003201",
  toPlace: "de-DELFI_de:09162:100",
  time: "2026-10-27T06:00:00.000Z",
  arriveBy: false,
  transitModes: ["HIGHSPEED_RAIL", "LONG_DISTANCE"],
  numItineraries: 5,
};

function client(answer: (url: URL, init?: RequestInit) => Promise<Response>) {
  const calls: { url: URL; init?: RequestInit | undefined }[] = [];
  const fetchStub = (async (input: URL | Request | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  return {
    calls,
    router: createRouterClient({
      baseUrl: "http://127.0.0.1:8092",
      userAgent: "gerlines/0.0.0",
      fetch: fetchStub,
    }),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createRouterClient plan", () => {
  it("sends the MOTIS v6 plan query and parses the answer", async () => {
    const plan = loadPlanFixture("motis-plan-berlin-muenchen.json");
    const { calls, router } = client(async () => json(plan));

    const result = await router.plan({ ...REQUEST, pageCursor: "LATER|1" });

    expect(result.itineraries).toHaveLength(5);
    const url = calls[0]?.url;
    expect(url?.origin).toBe("http://127.0.0.1:8092");
    expect(url?.pathname).toBe("/api/v6/plan");
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      fromPlace: REQUEST.fromPlace,
      toPlace: REQUEST.toPlace,
      time: REQUEST.time,
      arriveBy: "false",
      transitModes: "HIGHSPEED_RAIL,LONG_DISTANCE",
      directModes: "",
      numItineraries: "5",
      detailedLegs: "false",
      joinInterlinedLegs: "false",
      pageCursor: "LATER|1",
    });
    expect(new Headers(calls[0]?.init?.headers).get("user-agent")).toBe("gerlines/0.0.0");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves transitModes out when no modes are given, so MOTIS uses all of them", async () => {
    const plan = loadPlanFixture("motis-plan-berlin-muenchen.json");
    const { calls, router } = client(async () => json(plan));

    await router.plan({ ...REQUEST, transitModes: undefined });

    expect(calls[0]?.url.searchParams.has("transitModes")).toBe(false);
    expect(calls[0]?.url.searchParams.get("joinInterlinedLegs")).toBe("false");
    expect(calls[0]?.url.searchParams.has("maxTransfers")).toBe(false);
  });

  it.each([0, 3])("sends maxTransfers %i when changes are limited", async (maxTransfers) => {
    const plan = loadPlanFixture("motis-plan-berlin-muenchen.json");
    const { calls, router } = client(async () => json(plan));

    await router.plan({ ...REQUEST, maxTransfers });

    expect(calls[0]?.url.searchParams.get("maxTransfers")).toBe(String(maxTransfers));
  });

  it("asks for leg lines without transfer lines when the request wants detailed legs", async () => {
    const { calls, router } = client(async () =>
      json({ itineraries: [], previousPageCursor: undefined }),
    );
    await router.plan({ ...REQUEST, detailedLegs: true });
    expect(calls[0]?.url.searchParams.get("detailedLegs")).toBe("true");
    expect(calls[0]?.url.searchParams.get("detailedTransfers")).toBe("false");
  });

  it("keeps the leg line MOTIS sends", async () => {
    const plan = loadPlanFixture("motis-plan-berlin-muenchen.json");
    const first = plan.itineraries[0];
    const leg = first?.legs[0];
    if (!(first && leg)) throw new Error("fixture has no leg");
    const legGeometry = { points: "_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision: 6, length: 3 };
    const { router } = client(async () =>
      json({ ...plan, itineraries: [{ ...first, legs: [{ ...leg, legGeometry }] }] }),
    );
    const answer = await router.plan(REQUEST);
    expect(answer.itineraries[0]?.legs[0]?.legGeometry).toEqual(legGeometry);
  });

  it("turns a MOTIS 4xx into a rejection with its message", async () => {
    const { router } = client(async () =>
      json({ error: 'Could not find timetable location "de-DELFI_x"' }, 404),
    );
    const error = await router.plan(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RouterRejectedError);
    expect(error).toMatchObject({
      status: 404,
      message: expect.stringContaining("timetable location"),
    });
  });

  it("names the cause of a network failure for the server log", async () => {
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const { router } = client(async () => Promise.reject(new TypeError("fetch failed", { cause })));
    const error = await router.plan(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RouterUnavailableError);
    expect((error as Error).message).toContain("fetch failed");
    expect((error as Error).message).toContain("UND_ERR_SOCKET");
    expect((error as Error).message).toContain("other side closed");
  });

  it.each([
    ["a network failure", async () => Promise.reject(new TypeError("fetch failed"))],
    ["a 500", async () => json({ error: "boom" }, 500)],
    ["an unexpected body", async () => json({ itineraries: [{ legs: "no" }] })],
    ["a body that is not JSON", async () => new Response("<html>", { status: 200 })],
  ])("reports %s as unavailable", async (_label, answer) => {
    const { router } = client(answer);
    await expect(router.plan(REQUEST)).rejects.toBeInstanceOf(RouterUnavailableError);
  });
});

describe("createRouterClient plan timeout", () => {
  const hanging = (_url: URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  it("gives up after the request's own timeout, shorter than the plan timeout", async () => {
    const { router } = client(hanging);
    const started = performance.now();
    await expect(router.plan({ ...REQUEST, timeoutMs: 30 })).rejects.toBeInstanceOf(
      RouterUnavailableError,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps the plan timeout when the request asks for longer", async () => {
    const router = createRouterClient({
      baseUrl: "http://127.0.0.1:8092",
      userAgent: "gerlines/0.0.0",
      fetch: hanging as typeof fetch,
      planTimeoutMs: 30,
    });
    await expect(router.plan({ ...REQUEST, timeoutMs: 60_000 })).rejects.toBeInstanceOf(
      RouterUnavailableError,
    );
  });

  it("gives up when the caller's signal aborts, as when the client goes away", async () => {
    const { router } = client(hanging);
    const caller = new AbortController();
    const pending = router.plan({ ...REQUEST, signal: caller.signal });
    caller.abort(new Error("client gone"));
    await expect(pending).rejects.toBeInstanceOf(RouterUnavailableError);
  });

  it("does not send the timeout to MOTIS", async () => {
    const { calls, router } = client(async () =>
      json(loadPlanFixture("motis-plan-berlin-muenchen.json")),
    );
    await router.plan({ ...REQUEST, timeoutMs: 2_000 });
    expect(calls[0]?.url.searchParams.has("timeoutMs")).toBe(false);
  });
});

describe("createRouterClient health", () => {
  it("is ok when MOTIS answers its health endpoint", async () => {
    const { calls, router } = client(async () => json({ rt: false, gbfs: false }));
    await expect(router.health()).resolves.toMatchObject({ ok: true });
    expect(calls[0]?.url.pathname).toBe("/api/v1/health");
  });

  it("is not ok when MOTIS fails or is unreachable", async () => {
    await expect(client(async () => json({}, 400)).router.health()).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      client(async () => Promise.reject(new Error("refused"))).router.health(),
    ).resolves.toMatchObject({ ok: false });
  });
});
