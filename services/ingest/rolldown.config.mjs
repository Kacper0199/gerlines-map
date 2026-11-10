import { defineConfig } from "rolldown";

const bundle = (input, file) => ({
  input,
  platform: "node",
  external: ["pg-native", "pg-cloudflare", "cloudflare:sockets"],
  output: {
    file,
    format: "esm",
    codeSplitting: false,
    banner:
      'import { createRequire as __gerlinesCreateRequire } from "node:module"; const require = __gerlinesCreateRequire(import.meta.url);',
  },
});

export default defineConfig([
  bundle("src/cli.ts", "dist/recorder.mjs"),
  bundle("src/realtime/cli.ts", "dist/realtime.mjs"),
]);
