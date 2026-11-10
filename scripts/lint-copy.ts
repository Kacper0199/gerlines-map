import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Finding,
  lintCopy,
  type MessageCatalog,
  parseAllow,
} from "../packages/i18n/src/copy-lint.ts";

const SOURCE_ROOTS = ["packages/i18n/src", "apps/web/src", "packages/ui/src"];
const BRIDGE_FILES = [
  "copy.ts",
  "copy-stats.ts",
  "copy-legal.ts",
  "copy-journeys.ts",
  "copy-predict.ts",
  "copy-playback.ts",
  "copy-profile.ts",
  "copy-status.ts",
  "copy-a11y.ts",
  "copy-inview.ts",
  "copy-signature.ts",
];
const SKIPPED = /(?:\.test\.tsx?|\.d\.ts)$|(?:^|\/)(?:paraglide|node_modules|dist)(?:\/|$)/;

function rootFromArguments(args: readonly string[]): string {
  const index = args.indexOf("--root");
  const given = index >= 0 ? args[index + 1] : undefined;
  return resolve(given ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sourceFiles(root: string, directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(directory, name);
    if (SKIPPED.test(relative(root, path))) {
      return [];
    }
    if (statSync(path).isDirectory()) {
      return sourceFiles(root, path);
    }
    return /\.(?:tsx?|jsx?)$/.test(name) ? [path] : [];
  });
}

function readBridge(paths: readonly string[]): string | undefined {
  const texts: string[] = [];
  for (const path of paths) {
    try {
      texts.push(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function readAllow(path: string, locales: readonly string[]) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { allow: [], findings: [] as Finding[] };
    }
    throw error;
  }
  try {
    return parseAllow(JSON.parse(text), locales);
  } catch (error) {
    const finding: Finding = {
      locale: "*",
      key: "allow",
      rule: "invalid-allow",
      message: `allow list: ${path} is not valid JSON (${(error as Error).message})`,
    };
    return { allow: [], findings: [finding] };
  }
}

function report(stream: NodeJS.WriteStream, line: string): void {
  stream.write(`${line}\n`);
}

const root = rootFromArguments(process.argv.slice(2));
const i18n = join(root, "packages", "i18n");
const settings = readJson(join(i18n, "project.inlang", "settings.json")) as {
  baseLocale: string;
  locales: string[];
};
const catalogs: Record<string, MessageCatalog> = {};
for (const locale of settings.locales) {
  catalogs[locale] = readJson(join(i18n, "messages", `${locale}.json`)) as MessageCatalog;
}
const bridgePaths = BRIDGE_FILES.map((name) => join(i18n, "src", name));
const sourcePaths = SOURCE_ROOTS.flatMap((directory) => sourceFiles(root, join(root, directory)));
const sources = sourcePaths
  .filter((path) => !bridgePaths.includes(path))
  .map((path) => readFileSync(path, "utf8"));
const bridge = readBridge(bridgePaths);
const allowList = readAllow(join(i18n, "copy-lint.allow.json"), settings.locales);
const findings = [
  ...allowList.findings,
  ...lintCopy({
    baseLocale: settings.baseLocale,
    catalogs,
    sources,
    bridge,
    allow: allowList.allow,
  }),
];

if (findings.length > 0) {
  for (const finding of findings) {
    report(process.stderr, `${finding.message} (${finding.rule})`);
  }
  report(
    process.stderr,
    `copy lint: ${findings.length} finding${findings.length === 1 ? "" : "s"} in ${relative(process.cwd(), i18n) || "."}`,
  );
  process.exit(1);
}
const count = Object.keys(catalogs[settings.baseLocale] ?? {}).filter(
  (key) => !key.startsWith("$"),
).length;
report(
  process.stdout,
  `copy lint: ${count} message${count === 1 ? "" : "s"} in ${settings.locales.join(", ")}, ${sources.length} source files, no findings`,
);
