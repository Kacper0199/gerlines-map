import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { gerlinesApi } from "./vite/api-plugin.ts";
import { detailProxy } from "./vite/detail-proxy.ts";
import { precompressBuild } from "./vite/precompress-plugin.ts";
import { trainModels } from "./vite/train-models-plugin.ts";

const liveProxy = {
  ...(process.env.LIVE_PROXY_TARGET
    ? {
        "/live": { target: process.env.LIVE_PROXY_TARGET, changeOrigin: true },
        "/replay": { target: process.env.LIVE_PROXY_TARGET, changeOrigin: true },
        "/playback": { target: process.env.LIVE_PROXY_TARGET, changeOrigin: true },
      }
    : {}),
  ...detailProxy(process.env.DETAIL_PROXY_TARGET),
};

export default defineConfig({
  plugins: [
    tailwindcss(),
    react({ compiler: true }),
    gerlinesApi(),
    trainModels(),
    precompressBuild(),
  ],
  worker: { format: "es" },
  preview: { host: "127.0.0.1", proxy: liveProxy },
  server: {
    host: "127.0.0.1",
    proxy: liveProxy,
    ...(process.env.VITE_USE_POLLING === "1" ? { watch: { usePolling: true, interval: 300 } } : {}),
  },
  build: {
    target: "es2024",
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /preload-helper|rolldown-runtime|node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 10,
            },
            {
              name: "base-ui",
              test: /node_modules[\\/]@base-ui/,
              tags: ["$initial"],
            },
            { name: "maplibre", test: /node_modules[\\/]maplibre-gl/ },
            {
              name: "deckgl",
              test: /node_modules[\\/](@deck\.gl|@luma\.gl|@loaders\.gl|@math\.gl|@probe\.gl)/,
            },
          ],
        },
      },
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts", "vite/**/*.test.ts"],
  },
});
