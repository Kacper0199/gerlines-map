import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const i18n = resolve(here, "../../packages/i18n");

export default defineConfig({
  plugins: [
    react({ compiler: true }),
    ...(process.env.VITEST
      ? []
      : [
          paraglideVitePlugin({
            project: resolve(i18n, "project.inlang"),
            outdir: resolve(i18n, "src/paraglide"),
          }),
        ]),
  ],
  build: { target: "es2024", sourcemap: false },
  server: {
    host: "127.0.0.1",
    ...(process.env.VITE_USE_POLLING === "1" ? { watch: { usePolling: true, interval: 300 } } : {}),
  },
  preview: { host: "127.0.0.1" },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
