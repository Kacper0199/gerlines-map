import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./helpers/bundle-map-view.ts", import.meta.url));

interface Script {
  readonly fileName: string;
  readonly code: string;
}

function scriptsOf(mode: "production" | "development"): Script[] {
  const text = execFileSync(process.execPath, [SCRIPT, mode], {
    env: { ...process.env, NODE_ENV: mode },
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  return JSON.parse(text) as Script[];
}

function bundleOf(mode: "production" | "development"): string {
  return scriptsOf(mode)
    .map((script) => script.code)
    .join("\n");
}

describe("the map view in a built bundle", () => {
  it("keeps window.gerlinesStore and window.gerlinesCheck out of a production build", () => {
    const production = bundleOf("production");
    expect(production).toContain("gerlinesMap");
    expect(production).not.toContain("gerlinesStore");
    expect(production).not.toContain("gerlinesCheck");
  }, 120_000);

  it("starts one worker, the live one, and no script holds another train source or development route", () => {
    const scripts = scriptsOf("production");
    const workers = scripts.flatMap((script) => script.code.match(/new Worker\b/g) ?? []);
    expect(workers).toHaveLength(1);
    expect(scripts.some((script) => /(^|\/)live\.worker-[\w-]+\.js$/.test(script.fileName))).toBe(
      true,
    );
    expect(
      scripts
        .filter((script) => /transitous|motion\.worker|\/api\/dev/i.test(script.code))
        .map((script) => script.fileName),
    ).toEqual([]);
  }, 120_000);

  it("has them in a development build, so the check above can fail", () => {
    const development = bundleOf("development");
    expect(development).toContain("gerlinesStore");
    expect(development).toContain("gerlinesCheck");
  }, 120_000);
});
