// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedTripOfKey, clearTripCache } from "../hooks/use-frame-trip.ts";
import { browserTrainOfKey } from "./store-target.ts";

const OLD = "6f1c2a7e-6c3b-5d55-9a43-2f6b8e0c1d11";
const NEW = "0a1b2c3d-1111-5222-8333-444455556666";

function answer(id: string): Response {
  return new Response(JSON.stringify({ tripInstanceId: id }), { status: 200 });
}

beforeEach(() => clearTripCache());
afterEach(() => vi.unstubAllGlobals());

describe("browserTrainOfKey", () => {
  it("seeds the frame key cache with the answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(OLD)),
    );
    expect(await browserTrainOfKey(7)).toBe(OLD);
    expect(cachedTripOfKey(7)).toBe(OLD);
  });

  it("does not seed an answer from before an epoch change and asks again", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementationOnce(async () => answer(NEW));
    vi.stubGlobal("fetch", fetch);
    const pending = browserTrainOfKey(7);
    await Promise.resolve();
    clearTripCache();
    release(answer(OLD));
    expect(await pending).toBe(NEW);
    expect(cachedTripOfKey(7)).toBe(NEW);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives no train and seeds nothing when the epoch changes on every try", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        clearTripCache();
        return answer(OLD);
      }),
    );
    expect(await browserTrainOfKey(7)).toBeNull();
    expect(cachedTripOfKey(7)).toBeNull();
  });
});
