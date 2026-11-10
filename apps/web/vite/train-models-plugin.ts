import { createReadStream, existsSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Connect, Plugin } from "vite";

/** Where the page reads the forge's models (manifest, palette, GLBs). */
export const TRAIN_MODELS_BASE = "/trains/";

const FORGE_DIST = resolve(import.meta.dirname, "../../../tools/trainforge/dist");
const TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
};

/** The file a request names inside the forge output, or undefined when it leaves it. */
export function modelFile(root: string, url: string): string | undefined {
  const path = decodeURIComponent(url.split("?")[0] ?? "").slice(TRAIN_MODELS_BASE.length);
  const file = normalize(join(root, path));
  if (!file.startsWith(root + sep) || !TYPES[extname(file)]) return undefined;
  return file;
}

function serve(root: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!req.url?.startsWith(TRAIN_MODELS_BASE)) return next();
    const file = modelFile(root, req.url);
    if (!(file && existsSync(file) && statSync(file).isFile())) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", TYPES[extname(file)] as string);
    res.setHeader("Cache-Control", "no-cache");
    createReadStream(file).pipe(res);
  };
}

/**
 * Serves `tools/trainforge/dist` at /trains/ in the dev and preview servers and copies it into the
 * build output, so the repository holds no generated models (turbo builds the forge first).
 * `GERLINES_TRAIN_MODELS=off` leaves them out of the build, so the end-to-end suite draws the same cars
 * wherever it runs.
 */
export function trainModels(
  root = FORGE_DIST,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Plugin {
  let outDir = "";
  return {
    name: "gerlines-train-models",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(serve(root));
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve(root));
    },
    async closeBundle() {
      if (env.GERLINES_TRAIN_MODELS === "off") return;
      if (!existsSync(join(root, "manifest.json"))) {
        this.warn(`no forge build in ${root}: the page draws no 3D cars`);
        return;
      }
      await cp(root, join(outDir, TRAIN_MODELS_BASE), {
        recursive: true,
        filter: (source) => !source.endsWith("report.md"),
      });
    },
  };
}
