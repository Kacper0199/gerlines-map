import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildAll, manifestJson, reportMarkdown } from "./build.ts";
import { readCatalog } from "./catalog.ts";
import { validateGlb, validatorVersion } from "./validate.ts";

const DEFAULT_CATALOG = resolve(import.meta.dirname, "../../../catalog");
const REPOSITORY = resolve(import.meta.dirname, "../../..");
const OWN_OUTPUTS = ["models", "palette.png", "manifest.json", "report.md"];

function validateCatalog(): boolean {
  const run = spawnSync("uv", ["run", "gerlines-catalog", "validate"], {
    cwd: REPOSITORY,
    stdio: "inherit",
  });
  return run.status === 0;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", default: "dist" },
      catalog: { type: "string", default: DEFAULT_CATALOG },
      only: { type: "string" },
      "validate-catalog": { type: "boolean", default: false },
    },
  });
  if (positionals[0] !== "build") {
    process.stderr.write(
      "usage: node src/cli.ts build [--out dir] [--catalog dir] [--only id,id] [--validate-catalog]\n",
    );
    return 2;
  }
  if (values["validate-catalog"] && !validateCatalog()) {
    process.stderr.write("catalogue invalid, nothing built\n");
    return 1;
  }
  const started = performance.now();
  const result = await buildAll(readCatalog(values.catalog), values.only?.split(",")).catch(
    (error: Error) => error,
  );
  if (result instanceof Error) {
    process.stderr.write(`${result.message}\n`);
    return 2;
  }
  for (const name of OWN_OUTPUTS) rmSync(join(values.out, name), { recursive: true, force: true });
  let invalid = 0;
  for (const [path, bytes] of result.files) {
    const target = join(values.out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    if (!path.endsWith(".glb")) continue;
    const report = await validateGlb(bytes, path);
    if (report.errors > 0) {
      invalid++;
      process.stderr.write(`invalid glTF ${path}: ${report.codes.join(", ")}\n`);
    }
  }
  writeFileSync(join(values.out, "manifest.json"), manifestJson(result));
  writeFileSync(join(values.out, "report.md"), reportMarkdown(result));
  const over = result.models.flatMap((m) =>
    m.carTypes.flatMap((c) =>
      c.lods
        .filter((l) => l.carTriangles > l.budget)
        .map((l) => `${m.modelId}/${c.carType}/lod${l.level}`),
    ),
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    `${result.models.length} models, ${result.files.size} files in ${values.out} (${seconds} s), Khronos validator ${validatorVersion()}: ${invalid} invalid\n`,
  );
  if (over.length) process.stderr.write(`over budget: ${over.join(", ")}\n`);
  return over.length || invalid ? 1 : 0;
}

process.exitCode = await main();
