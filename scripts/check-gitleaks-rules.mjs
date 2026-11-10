#!/usr/bin/env node
// Runs gitleaks with .gitleaks.toml on every secret fixture: mustFail cases must be reported, mustPass cases must not.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const gitleaks = process.argv[2] ?? "gitleaks";
const config = process.argv[3] ?? join(repoRoot, ".gitleaks.toml");
const fixtures = JSON.parse(
  readFileSync(join(repoRoot, "packages/config/secret-fixtures.json"), "utf8"),
);

function fill(template) {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_placeholder, name) => {
    const token = fixtures.tokens[name];
    if (!token) {
      throw new Error(`Unknown fixture token ${name}`);
    }
    return token.parts.join(token.join).repeat(token.repeat);
  });
}

function scan(directory) {
  const result = spawnSync(
    gitleaks,
    ["dir", "--config", config, "--no-banner", "--redact", "--exit-code", "1", directory],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw result.error;
  }
  return result.status;
}

const workDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gerlines-gitleaks-"));
const cases = [
  ...fixtures.mustFail.map((fixture) => ({ ...fixture, expected: 1 })),
  ...fixtures.mustPass.map((fixture) => ({ ...fixture, expected: 0 })),
  ...[".env.example", "docs/KEYS.md", "docs/development.md", "scripts/check-keys.sh"].map(
    (path) => ({
      name: `committed ${path}`,
      file: path,
      content: readFileSync(join(repoRoot, path), "utf8"),
      expected: 0,
      raw: true,
    }),
  ),
];

let failures = 0;
try {
  cases.forEach((testCase, index) => {
    const caseDir = join(workDir, String(index));
    const filePath = join(caseDir, testCase.file);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, testCase.raw ? testCase.content : fill(testCase.content));
    const status = scan(caseDir);
    const passed = status === testCase.expected;
    if (!passed) {
      failures += 1;
    }
    const verdict = testCase.expected === 1 ? "reported" : "clean";
    process.stdout.write(
      `${passed ? "ok  " : "FAIL"} expected ${verdict}: ${testCase.name} (exit ${status})\n`,
    );
  });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.stdout.write(
  `${cases.length - failures} of ${cases.length} gitleaks fixture cases passed\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
