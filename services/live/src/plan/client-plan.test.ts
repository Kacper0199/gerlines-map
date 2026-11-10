import { FRAME_CATEGORIES, type FrameCategory } from "@gerlines/geo/client-plan";
import { CATEGORIES, type Category } from "@gerlines/live-frame";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("the shared client contract", () => {
  it("knows the frame categories in the order of the frame codes", () => {
    expect([...FRAME_CATEGORIES]).toEqual([...CATEGORIES]);
    expectTypeOf<Category>().toEqualTypeOf<FrameCategory>();
  });
});
