import { describe, expect, it } from "vitest";
import { ChannelPool } from "./pool.ts";

describe("ChannelPool", () => {
  it("issues a typed view of the requested length and reports it", () => {
    const pool = new ChannelPool();
    pool.begin("dots");
    const positions = pool.f64("position", 30);
    expect(positions).toBeInstanceOf(Float64Array);
    expect(positions.length).toBe(30);
    const issued = pool.take();
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ key: "dots:position", kind: "f64", length: 30 });
    expect(pool.take()).toHaveLength(0);
  });

  it("reuses a recycled buffer that is large enough", () => {
    const pool = new ChannelPool();
    pool.begin("dots");
    pool.f32("angle", 100);
    const [first] = pool.take();
    pool.recycle([{ key: "dots:angle", buffer: first?.buffer as ArrayBuffer }]);
    const again = pool.f32("angle", 80);
    expect(again.buffer).toBe(first?.buffer);
  });

  it("allocates a larger buffer when the recycled one is too small", () => {
    const pool = new ChannelPool();
    pool.begin("cars");
    pool.u8("color", 10);
    const [small] = pool.take();
    pool.recycle([{ key: "cars:color", buffer: small?.buffer as ArrayBuffer }]);
    const bigger = pool.u8("color", 1000);
    expect(bigger.buffer).not.toBe(small?.buffer);
    expect(bigger.length).toBe(1000);
  });

  it("keeps channels of different tiers apart", () => {
    const pool = new ChannelPool();
    pool.begin("dots");
    pool.f64("position", 10);
    const [dots] = pool.take();
    pool.recycle([{ key: "dots:position", buffer: dots?.buffer as ArrayBuffer }]);
    pool.begin("icons");
    const icons = pool.f64("position", 10);
    expect(icons.buffer).not.toBe(dots?.buffer);
  });
});
