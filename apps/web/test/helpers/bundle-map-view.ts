import { fileURLToPath } from "node:url";
import { build } from "vite";

const mode = process.argv[2] === "development" ? "development" : "production";
const entry = fileURLToPath(new URL("../../src/components/MapView.tsx", import.meta.url));

const result = await build({
  configFile: false,
  mode,
  logLevel: "silent",
  build: {
    write: false,
    minify: mode === "production",
    sourcemap: false,
    lib: { entry, formats: ["es"], fileName: "map-view" },
    rolldownOptions: {
      external: (id: string) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
    },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) =>
  "output" in entry ? entry.output : [],
);
const scripts = outputs.flatMap((output) => {
  if ("code" in output) return [{ fileName: output.fileName, code: output.code }];
  const text =
    typeof output.source === "string" ? output.source : new TextDecoder().decode(output.source);
  return output.fileName.endsWith(".js") ? [{ fileName: output.fileName, code: text }] : [];
});
process.stdout.write(JSON.stringify(scripts));
