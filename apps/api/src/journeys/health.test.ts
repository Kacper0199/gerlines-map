import { describe, expect, it } from "vitest";
import type { RouterHealth } from "../router/motis.ts";
import { cachedRouterHealth, ROUTER_HEALTH_TTL_MS } from "./health.ts";

function probe(answers: RouterHealth[]) {
  let calls = 0;
  const waiting: ((health: RouterHealth) => void)[] = [];
  return {
    get calls() {
      return calls;
    },
    answerAll() {
      for (const answer of waiting.splice(0)) {
        answer(answers.shift() ?? { ok: false, latencyMs: 0 });
      }
    },
    health: () => {
      calls += 1;
      return new Promise<RouterHealth>((resolve) => void waiting.push(resolve));
    },
  };
}

describe("cachedRouterHealth", () => {
  it("asks the router at most once per five seconds", async () => {
    let now = 0;
    const router = probe([
      { ok: true, latencyMs: 4 },
      { ok: false, latencyMs: 3_000 },
    ]);
    const read = cachedRouterHealth(router.health, () => now);
    const first = read();
    router.answerAll();
    expect(await first).toEqual({ ok: true, latencyMs: 4 });
    now = ROUTER_HEALTH_TTL_MS - 1;
    expect(await read()).toEqual({ ok: true, latencyMs: 4 });
    expect(router.calls).toBe(1);
    now = ROUTER_HEALTH_TTL_MS;
    const later = read();
    router.answerAll();
    expect(await later).toEqual({ ok: false, latencyMs: 3_000 });
    expect(router.calls).toBe(2);
    expect(ROUTER_HEALTH_TTL_MS).toBe(5_000);
  });

  it("lets requests that arrive while the router is asked share that one call", async () => {
    const router = probe([{ ok: true, latencyMs: 4 }]);
    const read = cachedRouterHealth(router.health, () => 0);
    const answers = Promise.all([read(), read(), read()]);
    router.answerAll();
    expect(await answers).toEqual([
      { ok: true, latencyMs: 4 },
      { ok: true, latencyMs: 4 },
      { ok: true, latencyMs: 4 },
    ]);
    expect(router.calls).toBe(1);
  });

  it("asks again after a call that threw", async () => {
    let calls = 0;
    const read = cachedRouterHealth(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("boom");
        }
        return { ok: true, latencyMs: 2 };
      },
      () => 0,
    );
    await expect(read()).rejects.toThrow("boom");
    expect(await read()).toEqual({ ok: true, latencyMs: 2 });
  });
});
