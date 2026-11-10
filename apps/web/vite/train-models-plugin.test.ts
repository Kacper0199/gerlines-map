import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelFile, trainModels } from "./train-models-plugin.ts";

async function bundled(env: Record<string, string>): Promise<boolean> {
  const forge = mkdtempSync(join(tmpdir(), "forge-"));
  const out = mkdtempSync(join(tmpdir(), "out-"));
  writeFileSync(join(forge, "manifest.json"), "{}");
  const plugin = trainModels(forge, env) as unknown as {
    configResolved(config: unknown): void;
    closeBundle(this: { warn(): void }): Promise<void>;
  };
  plugin.configResolved({ root: out, build: { outDir: "dist" } });
  await plugin.closeBundle.call({ warn: () => undefined });
  return existsSync(join(out, "dist", "trains", "manifest.json"));
}

describe("the models switch", () => {
  it("copies the forge output into the build unless GERLINES_TRAIN_MODELS is off", async () => {
    expect(await bundled({})).toBe(true);
    expect(await bundled({ GERLINES_TRAIN_MODELS: "off" })).toBe(false);
  });
});

describe("modelFile", () => {
  it("maps /trains/ requests into the forge output and refuses anything outside it", () => {
    expect(modelFile("/f/dist", "/trains/models/a/end.lod0.glb?v=1")).toBe(
      "/f/dist/models/a/end.lod0.glb",
    );
    expect(modelFile("/f/dist", "/trains/manifest.json")).toBe("/f/dist/manifest.json");
    expect(modelFile("/f/dist", "/trains/../secret.json")).toBeUndefined();
    expect(modelFile("/f/dist", "/trains/%2e%2e/x.png")).toBeUndefined();
    expect(modelFile("/f/dist", "/trains/report.md")).toBeUndefined();
  });
});
