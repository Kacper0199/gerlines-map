import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { resultsSink } from "./tools/results-sink.ts";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [resultsSink(process.env, resolve(here, "results"))],
  worker: { format: "es" },
  build: { target: "es2024", sourcemap: false, chunkSizeWarningLimit: 2500 },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
