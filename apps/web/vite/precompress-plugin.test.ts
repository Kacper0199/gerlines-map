import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  zstdDecompressSync,
} from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  precompress,
  precompressBuild,
  precompressDist,
  staleSidecars,
} from "./precompress-plugin.ts";

function distWith(files: Record<string, string | Buffer>): string {
  const dist = mkdtempSync(join(tmpdir(), "precompress-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dist, name, ".."), { recursive: true });
    writeFileSync(join(dist, name), body);
  }
  return dist;
}

const BODY = "export const station = 'Frankfurt (Main) Hbf';\n".repeat(200);

describe("precompress", () => {
  it("writes .br, .zst and .gz next to every text asset and each decodes to the original", async () => {
    const dist = distWith({
      "index.html": "<!doctype html>".repeat(100),
      "assets/index-abc.js": BODY,
      "assets/app-abc.css": "a{color:red}".repeat(200),
      "geo/national.geojson": '{"type":"FeatureCollection"}'.repeat(100),
    });
    const written = await precompressDist(dist);
    expect(written).toBe(12);
    const js = readFileSync(join(dist, "assets/index-abc.js"));
    expect(brotliDecompressSync(readFileSync(join(dist, "assets/index-abc.js.br")))).toEqual(js);
    expect(zstdDecompressSync(readFileSync(join(dist, "assets/index-abc.js.zst")))).toEqual(js);
    expect(gunzipSync(readFileSync(join(dist, "assets/index-abc.js.gz")))).toEqual(js);
  });

  it("leaves source maps, fonts, images and models alone", async () => {
    const dist = distWith({
      "assets/index.js.map": BODY,
      "assets/font.woff2": BODY,
      "assets/photo.png": BODY,
      "trains/car.glb": BODY,
    });
    expect(await precompressDist(dist)).toBe(0);
    expect(readdirSync(join(dist, "assets")).sort()).toEqual([
      "font.woff2",
      "index.js.map",
      "photo.png",
    ]);
  });

  it("skips a file when a variant would not be smaller", () => {
    const random = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 13) % 251));
    expect(precompress(random).map((variant) => variant.extension)).toEqual([]);
    expect(precompress(Buffer.from(BODY)).map((variant) => variant.extension)).toEqual([
      ".br",
      ".zst",
      ".gz",
    ]);
  });

  it("is idempotent: a second run does not compress the compressed files", async () => {
    const dist = distWith({ "assets/a.js": BODY });
    await precompressDist(dist);
    expect(await precompressDist(dist)).toBe(3);
    expect(readdirSync(join(dist, "assets")).sort()).toEqual([
      "a.js",
      "a.js.br",
      "a.js.gz",
      "a.js.zst",
    ]);
  });
});

describe("precompressBuild", () => {
  type Hook = {
    order: string;
    sequential: boolean;
    handler(this: unknown, error?: Error): Promise<void>;
  };
  function hookOf(root: string): Hook {
    const plugin = precompressBuild() as unknown as {
      configResolved(config: unknown): void;
      closeBundle: Hook;
    };
    plugin.configResolved({ root, build: { outDir: "dist" } });
    return plugin.closeBundle;
  }

  it("runs after the other plugins, one after another, and compresses the copied models' manifest too", async () => {
    const root = mkdtempSync(join(tmpdir(), "precompress-root-"));
    mkdirSync(join(root, "dist", "trains"), { recursive: true });
    writeFileSync(join(root, "dist", "trains", "manifest.json"), JSON.stringify({ cars: BODY }));
    const hook = hookOf(root);
    expect([hook.order, hook.sequential]).toEqual(["post", true]);
    await hook.handler.call({});
    expect(readdirSync(join(root, "dist", "trains")).sort()).toEqual([
      "manifest.json",
      "manifest.json.br",
      "manifest.json.gz",
      "manifest.json.zst",
    ]);
  });

  it("does nothing after a failed build, so the build's own error is the one reported", async () => {
    const hook = hookOf(join(tmpdir(), "precompress-missing-root"));
    await expect(hook.handler.call({}, new Error("build failed"))).resolves.toBeUndefined();
  });
});

describe("staleSidecars", () => {
  it("finds none in a fresh build", async () => {
    const dist = distWith({ "index.html": "<!doctype html>".repeat(100), "assets/a.js": BODY });
    await precompressDist(dist);
    expect(await staleSidecars(dist)).toEqual([]);
  });

  it("names a copy that no longer matches its file, one whose file is gone and one that is not an encoding of anything", async () => {
    const dist = distWith({ "index.html": "<!doctype html>".repeat(100), "assets/a.js": BODY });
    await precompressDist(dist);
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>new</title>".repeat(100));
    writeFileSync(join(dist, "assets/old.js.br"), brotliCompressSync(Buffer.from("old")));
    writeFileSync(join(dist, "assets/a.js.zst"), "not zstd");
    expect(await staleSidecars(dist)).toEqual([
      "assets/a.js.zst",
      "assets/old.js.br",
      "index.html.br",
      "index.html.gz",
      "index.html.zst",
    ]);
  });
});
