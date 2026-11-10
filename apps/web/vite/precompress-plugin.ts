import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  gunzipSync,
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import type { Plugin } from "vite";

const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".svg",
  ".json",
  ".geojson",
  ".wasm",
]);

export interface Variant {
  extension: ".br" | ".zst" | ".gz";
  bytes: Buffer;
}

/** Smallest-possible encodings of one file, in the order the edge prefers them; one that is not smaller is dropped. */
export function precompress(raw: Buffer): Variant[] {
  const variants: Variant[] = [
    {
      extension: ".br",
      bytes: brotliCompressSync(raw, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
      }),
    },
    {
      extension: ".zst",
      bytes: zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }),
    },
    { extension: ".gz", bytes: gzipSync(raw, { level: constants.Z_BEST_COMPRESSION }) },
  ];
  return variants.filter((variant) => variant.bytes.length < raw.length);
}

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
    ),
  );
  return nested.flat();
}

/** Writes `.br`, `.zst` and `.gz` beside each text file under `dist` and returns how many files it wrote. */
export async function precompressDist(dist: string): Promise<number> {
  const sources = (await files(dist)).filter((file) => COMPRESSIBLE.has(extname(file)));
  const counts = await Promise.all(
    sources.map(async (file) => {
      const variants = precompress(await readFile(file));
      await Promise.all(
        variants.map((variant) => writeFile(file + variant.extension, variant.bytes)),
      );
      return variants.length;
    }),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

const DECODERS: Readonly<Record<string, (bytes: Buffer) => Buffer>> = {
  ".br": brotliDecompressSync,
  ".zst": zstdDecompressSync,
  ".gz": gunzipSync,
};

/**
 * The copies under `dist` (relative paths) that the edge must not serve: one that does not decode to its file, or
 * whose file is gone, as an old copy left next to a new file after an in-place deploy.
 */
export async function staleSidecars(dist: string): Promise<string[]> {
  const found = await files(dist);
  const stale: string[] = [];
  for (const file of found) {
    const extension = extname(file);
    const decode = DECODERS[extension];
    if (!decode) continue;
    try {
      const original = await readFile(file.slice(0, -extension.length));
      if (!decode(await readFile(file)).equals(original)) stale.push(relative(dist, file));
    } catch {
      stale.push(relative(dist, file));
    }
  }
  return stale.sort();
}

/**
 * After the last plugin has written its files, stores brotli (quality 11), zstd (level 19) and gzip copies of every
 * text asset, so the edge serves them with `file_server { precompressed }` at the best ratio instead of compressing
 * at a low level per request. Source maps stay with the edge's on-the-fly `encode`: no page waits for them.
 */
export function precompressBuild(): Plugin {
  let outDir = "";
  return {
    name: "gerlines-precompress",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler(error?: Error) {
        if (error) return;
        await precompressDist(outDir);
      },
    },
  };
}
