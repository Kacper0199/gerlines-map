import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceModules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const i18nSources = fileURLToPath(new URL("../i18n", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    fs: { allow: [packageRoot, workspaceModules, i18nSources] },
    ...(process.env.VITE_USE_POLLING === "1" ? { watch: { usePolling: true, interval: 300 } } : {}),
  },
  build: { target: "es2024" },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "sheet/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
