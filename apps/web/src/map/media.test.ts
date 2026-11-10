import { describe, expect, it, vi } from "vitest";
import { onMediaChange, pickingRadius } from "./media.ts";

class FakeQuery extends EventTarget {
  matches = false;

  change(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

describe("pickingRadius", () => {
  it("is wider for a finger than for a mouse", () => {
    expect(pickingRadius(true)).toBeGreaterThan(pickingRadius(false));
  });
});

describe("onMediaChange", () => {
  it("reports each change of the query with its new value", () => {
    const query = new FakeQuery();
    const callback = vi.fn();
    onMediaChange(query as unknown as MediaQueryList, callback);

    query.change(true);
    query.change(false);

    expect(callback.mock.calls).toEqual([[true], [false]]);
  });

  it("stops reporting after the returned function is called", () => {
    const query = new FakeQuery();
    const callback = vi.fn();
    const stop = onMediaChange(query as unknown as MediaQueryList, callback);

    stop();
    query.change(true);

    expect(callback).not.toHaveBeenCalled();
  });
});
