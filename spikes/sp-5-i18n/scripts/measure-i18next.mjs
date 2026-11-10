import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const i18n = resolve(here, "../../../packages/i18n");
const installed = process.env.I18NEXT_DIR;
if (!installed) {
  throw new Error("Set I18NEXT_DIR to a directory with i18next and react-i18next installed");
}

function toI18next(catalog) {
  const flat = {};
  for (const [key, entry] of Object.entries(catalog)) {
    if (key.startsWith("$")) {
      continue;
    }
    if (typeof entry === "string") {
      flat[key] = entry.replace(/\{(\w+)\}/g, "{{$1}}");
      continue;
    }
    for (const variant of entry) {
      for (const [selector, text] of Object.entries(variant.match)) {
        flat[`${key}_${selector.split("=")[1]}`] = text.replace(/\{(\w+)\}/g, "{{$1}}");
      }
    }
  }
  return flat;
}

const ENTRY = `
import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import en from "./en.json";
import de from "./de.json";
import pl from "./pl.json";

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, de: { translation: de }, pl: { translation: pl } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export { i18n, useTranslation };
`;

const root = mkdtempSync(resolve(installed, ".sp5-"));
try {
  mkdirSync(resolve(root, "src"), { recursive: true });
  for (const locale of ["en", "de", "pl"]) {
    const catalog = JSON.parse(readFileSync(resolve(i18n, `messages/${locale}.json`), "utf8"));
    writeFileSync(resolve(root, `src/${locale}.json`), JSON.stringify(toI18next(catalog)));
  }
  writeFileSync(resolve(root, "src/entry.js"), ENTRY);
  const output = await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: true,
      target: "es2024",
      lib: { entry: resolve(root, "src/entry.js"), formats: ["es"], fileName: "entry" },
      rolldownOptions: { external: ["react", "react/jsx-runtime"] },
    },
  });
  const chunks = (Array.isArray(output) ? output : [output]).flatMap((entry) => entry.output);
  const code = Buffer.from(chunks.map((chunk) => ("code" in chunk ? chunk.code : "")).join("\n"));
  const row = {
    name: "i18next 26 plus react-i18next 17, 3 locales, same strings",
    raw: code.length,
    gzip: gzipSync(code, { level: 9 }).length,
    brotli: brotliCompressSync(code).length,
  };
  process.stdout.write(`${row.name}  raw ${row.raw}  gzip ${row.gzip}  brotli ${row.brotli}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
