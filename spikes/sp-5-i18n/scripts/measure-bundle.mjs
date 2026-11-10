import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { compile } from "@inlang/paraglide-js";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const i18n = resolve(here, "../../../packages/i18n");
const plugin = resolve(i18n, "node_modules/@inlang/plugin-message-format/dist/index.js");
const results = resolve(here, "../results/bundle-sizes.json");

const catalogs = Object.fromEntries(
  ["en", "de", "pl"].map((locale) => [
    locale,
    JSON.parse(readFileSync(resolve(i18n, `messages/${locale}.json`), "utf8")),
  ]),
);
catalogs.fr = catalogs.de;

const MESSAGE_PARAMS =
  "{ count: 1, minutes: 5, clock: '21:35', day: '23 October', track: '8', was: '7' }";
const ENTRY = `
import * as messages from "./paraglide/messages.js";
import { getLocale, locales, setLocale } from "./paraglide/runtime.js";
export const all = (locale) =>
  Object.entries(messages).map(([name, fn]) => (typeof fn === "function" ? fn(${MESSAGE_PARAMS}, { locale }) : name));
export { getLocale, locales, setLocale };
`;
const RUNTIME_ONLY_ENTRY = `
import { getLocale, locales, setLocale } from "./paraglide/runtime.js";
export { getLocale, locales, setLocale };
`;

const VARIANTS = [
  { name: "runtime only, 3 locales", locales: ["en", "de", "pl"], entry: RUNTIME_ONLY_ENTRY },
  { name: "1 locale (en)", locales: ["en"] },
  { name: "2 locales (en, de)", locales: ["en", "de"] },
  { name: "3 locales (en, de, pl)", locales: ["en", "de", "pl"] },
  { name: "4 locales (en, de, pl, fr as a copy of de)", locales: ["en", "de", "pl", "fr"] },
  {
    name: "3 locales, locale-modules output",
    locales: ["en", "de", "pl"],
    outputStructure: "locale-modules",
  },
];

function sizes(code) {
  const bytes = Buffer.from(code);
  return {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes).length,
  };
}

async function measure(variant) {
  const root = mkdtempSync(resolve(tmpdir(), "sp5-bundle-"));
  try {
    mkdirSync(resolve(root, "project.inlang"), { recursive: true });
    mkdirSync(resolve(root, "messages"), { recursive: true });
    writeFileSync(
      resolve(root, "project.inlang/settings.json"),
      JSON.stringify({
        baseLocale: "en",
        locales: variant.locales,
        modules: [plugin],
        "plugin.inlang.messageFormat": { pathPattern: "./messages/{locale}.json" },
      }),
    );
    for (const locale of variant.locales) {
      writeFileSync(resolve(root, `messages/${locale}.json`), JSON.stringify(catalogs[locale]));
    }
    await compile({
      project: resolve(root, "project.inlang"),
      outdir: resolve(root, "src/paraglide"),
      strategy: ["localStorage", "preferredLanguage", "baseLocale"],
      isServer: "false",
      outputStructure: variant.outputStructure ?? "message-modules",
      emitReadme: false,
      emitGitIgnore: false,
      emitPrettierIgnore: false,
    });
    writeFileSync(resolve(root, "src/entry.js"), variant.entry ?? ENTRY);
    const output = await build({
      root,
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: true,
        target: "es2024",
        lib: { entry: resolve(root, "src/entry.js"), formats: ["es"], fileName: "entry" },
      },
    });
    const chunks = (Array.isArray(output) ? output : [output]).flatMap((entry) => entry.output);
    const code = chunks.map((chunk) => ("code" in chunk ? chunk.code : "")).join("\n");
    return { name: variant.name, ...sizes(code) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rows = [];
for (const variant of VARIANTS) {
  rows.push(await measure(variant));
}
mkdirSync(dirname(results), { recursive: true });
writeFileSync(results, `${JSON.stringify(rows, null, 2)}\n`);
for (const row of rows) {
  process.stdout.write(
    `${row.name.padEnd(62)} raw ${String(row.raw).padStart(6)}  gzip ${String(row.gzip).padStart(5)}  brotli ${String(row.brotli).padStart(5)}\n`,
  );
}
