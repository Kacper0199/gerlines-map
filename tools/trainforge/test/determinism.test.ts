import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detExp, detLog, detPow } from "../src/geometry/det-math.ts";

const SRC = resolve(import.meta.dirname, "../src");
const PLATFORM_DEPENDENT =
  /\*\*|Math\.(pow|log|log2|log10|log1p|expm1|tan|tanh|atan|atan2|sinh|cosh)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

function grid(): number[][] {
  let s = 5101;
  const r = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 2 ** 32;
  };
  return Array.from({ length: 20000 }, () => [r() * 3, 0.1 + r() * 12]);
}

describe("platform-independent arithmetic", () => {
  it("uses no Math function that V8 builds differently per platform", () => {
    const hits = sources(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({
          line: line.replace(/\/\*.*?\*\/|\/\*.*$|^\s*\*.*$|\/\/.*$/g, ""),
          at: `${relative(SRC, file)}:${i + 1}`,
        }))
        .filter(({ line }) => PLATFORM_DEPENDENT.test(line))
        .map(({ at }) => at),
    );
    expect(hits).toEqual([]);
  });

  it("stays within two ulps of the platform functions", () => {
    for (const [x, y] of grid() as [number, number][]) {
      expect(Math.abs(detLog(x) - Math.log(x))).toBeLessThanOrEqual(
        4.5e-16 * Math.max(1, Math.abs(Math.log(x))),
      );
      expect(Math.abs(detExp(y - 6) - Math.exp(y - 6))).toBeLessThanOrEqual(
        4.5e-16 * Math.exp(y - 6),
      );
      const p = x ** y;
      expect(Math.abs(detPow(x, y) - p)).toBeLessThanOrEqual(1e-14 * Math.max(p, Number.MIN_VALUE));
    }
    expect([detPow(0, 2.5), detPow(1, 7.3), detPow(2, 0), detPow(0.5, 3), detPow(2, -2)]).toEqual([
      0, 1, 1, 0.125, 0.25,
    ]);
    expect(() => detPow(-1, 0.5)).toThrow(RangeError);
  });

  it("gives the same bits as on the machine that pinned them", () => {
    const hash = createHash("sha256");
    const bits = new Float64Array(3);
    for (const [x, y] of grid() as [number, number][]) {
      bits[0] = detLog(x);
      bits[1] = detExp(y - 6);
      bits[2] = detPow(x, y);
      hash.update(new Uint8Array(bits.buffer));
    }
    expect(hash.digest("hex")).toMatchSnapshot();
  });
});
