import { describe, expect, it } from "vitest";
import { routeProduct } from "./product.ts";

describe("routeProduct", () => {
  it.each([
    ["ICE", "ICE"],
    ["IC17", "IC"],
    ["EC", "EC"],
    ["RE10a", "RE"],
    ["RB46", "RB"],
    ["S1", "S"],
    ["FLX20", "FLX"],
    ["NJ", "NJ"],
    ["Os", "Os"],
    ["OS 5", "Os"],
    ["Re 1", "RE"],
    ["ice", "ICE"],
    ["sp 1234", "Sp"],
  ])("reads the product of %j", (line, product) => {
    expect(routeProduct(line)).toBe(product);
  });

  it.each(["42", "43N", "Chiemseebahn", "A1", "Linie A", "", null])(
    "finds no product in %j",
    (line) => {
      expect(routeProduct(line)).toBeNull();
    },
  );
});
