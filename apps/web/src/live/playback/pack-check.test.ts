import { describe, expect, it } from "vitest";
import { PackChecker } from "./pack-check.ts";

interface Call {
  readonly url: string;
  readonly method: string | undefined;
}

function checker(answer: (call: Call) => number) {
  const calls: Call[] = [];
  let wall = 0;
  const instance = new PackChecker(
    async (url, init) => {
      const call = { url, method: init?.method };
      calls.push(call);
      return new Response(null, { status: answer(call) });
    },
    () => "/live/v1",
    () => wall,
  );
  return {
    instance,
    calls,
    advance: (ms: number) => {
      wall += ms;
    },
  };
}

describe("PackChecker", () => {
  it("asks with HEAD, so no pack is downloaded", async () => {
    const t = checker(() => 200);
    expect(await t.instance.exists(3, "17")).toBe(true);
    expect(t.calls).toEqual([{ url: "/live/v1/s/3/17.bin", method: "HEAD" }]);
  });

  it("remembers a pack that exists for good", async () => {
    const t = checker(() => 200);
    await t.instance.exists(3, "17");
    await t.instance.exists(3, "17");
    t.advance(3_600_000);
    await t.instance.exists(3, "17");
    expect(t.calls).toHaveLength(1);
  });

  it("asks again for a missing pack after a while, since packs are published later", async () => {
    let status = 404;
    const t = checker(() => status);
    expect(await t.instance.exists(3, "17")).toBe(false);
    expect(await t.instance.exists(3, "17")).toBe(false);
    expect(t.calls).toHaveLength(1);
    status = 200;
    t.advance(31_000);
    expect(await t.instance.exists(3, "17")).toBe(true);
    expect(t.calls).toHaveLength(2);
  });

  it("falls back to a GET where the server does not know HEAD", async () => {
    const t = checker((call) => (call.method === "HEAD" ? 405 : 200));
    expect(await t.instance.exists(3, "17")).toBe(true);
    expect(t.calls.map((call) => call.method)).toEqual(["HEAD", undefined]);
  });

  it("rejects on a server error so the playback can retry", async () => {
    const t = checker(() => 503);
    await expect(t.instance.exists(3, "17")).rejects.toThrow();
  });
});
