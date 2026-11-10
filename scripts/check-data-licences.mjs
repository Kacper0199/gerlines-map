#!/usr/bin/env node
// Fails when a data file resolves only to the REUSE.toml catch-all (AGPL), so third-party data cannot slip in unlabelled.
// Input: the SPDX document of `reuse spdx`. Usage: node scripts/check-data-licences.mjs <reuse.spdx>
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIRECTORIES = ["fixtures", "test-vectors", "results", "data"];
export const DATA_EXTENSIONS = [".pb", ".gz", ".geojson", ".csv", ".xml"];
const COPYRIGHT_PREFIX = "SPDX-FileCopyrightText: ";

export function isDataPath(path) {
  const directories = path.split("/").slice(0, -1);
  return (
    directories.some((directory) => DATA_DIRECTORIES.includes(directory)) ||
    DATA_EXTENSIONS.some((extension) => path.endsWith(extension))
  );
}

export function parseCatchAll(reuseToml) {
  for (const block of reuseToml.split("[[annotations]]").slice(1)) {
    if (!/^path\s*=\s*"\*\*"\s*$/m.test(block)) continue;
    const copyright = /^SPDX-FileCopyrightText\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1];
    const licence = /^SPDX-License-Identifier\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1];
    if (copyright && licence) return { copyright, licence };
    throw new Error('the path = "**" annotation needs one plain copyright string and one licence');
  }
  throw new Error('REUSE.toml has no path = "**" catch-all annotation');
}

const stripCopyrightPrefix = (entry) =>
  entry.startsWith(COPYRIGHT_PREFIX) ? entry.slice(COPYRIGHT_PREFIX.length) : entry;

function parseSpdxFile(block) {
  const path = /^FileName: (.+)$/m.exec(block)?.[1];
  if (!path) return null;
  const copyrightText = /^FileCopyrightText: <text>([\s\S]*?)<\/text>/m.exec(block)?.[1] ?? "";
  return {
    path: path.trim().replace(/^\.\//, ""),
    licences: [...block.matchAll(/^LicenseInfoInFile: (.+)$/gm)].map((match) => match[1].trim()),
    copyright: copyrightText
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(stripCopyrightPrefix),
  };
}

export function parseSpdxFiles(spdxText) {
  return spdxText
    .split(/\n(?=FileName: )/)
    .map(parseSpdxFile)
    .filter(Boolean);
}

export function resolvesOnlyToCatchAll(file, catchAll) {
  return (
    file.licences.length === 1 &&
    file.licences[0] === catchAll.licence &&
    file.copyright.length === 1 &&
    file.copyright[0] === catchAll.copyright
  );
}

const matches = (exemption, path) =>
  exemption.path.endsWith("/") ? path.startsWith(exemption.path) : path === exemption.path;

function assertExemptionsComplete(exemptions) {
  for (const exemption of exemptions) {
    if (!exemption.path || !exemption.reason?.trim()) {
      throw new Error(`exemption ${JSON.stringify(exemption)} needs a path and a reason`);
    }
  }
}

function hasDataRows(text) {
  return text.split("\n").filter((line) => line.trim() !== "").length > 1;
}

function problemOf(file, exemption, readFile) {
  if (!exemption) return "data file resolves only to the catch-all";
  if (exemption.headerOnly && hasDataRows(readFile(file.path))) {
    return "exempt as header only, but it has data rows";
  }
  return null;
}

export function checkDataLicences({ spdxText, reuseToml, exemptions, readFile }) {
  assertExemptionsComplete(exemptions);
  const catchAll = parseCatchAll(reuseToml);
  const files = parseSpdxFiles(spdxText);
  if (files.length === 0) throw new Error("the SPDX document lists no files");
  const dataFiles = files.filter((file) => isDataPath(file.path));
  const unlabelled = dataFiles.filter((file) => resolvesOnlyToCatchAll(file, catchAll));
  const used = new Set();
  const violations = [];
  let exempt = 0;
  for (const file of unlabelled) {
    const exemption = exemptions.find((candidate) => matches(candidate, file.path));
    if (exemption) {
      used.add(exemption);
      exempt += 1;
    }
    const problem = problemOf(file, exemption, readFile);
    if (problem) violations.push({ path: file.path, problem });
  }
  for (const exemption of exemptions.filter((candidate) => !used.has(candidate))) {
    violations.push({ path: exemption.path, problem: "exemption matches no unlabelled data file" });
  }
  return { checked: dataFiles.length, exempt, violations };
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const spdxPath = process.argv[2];
  if (!spdxPath) {
    process.stderr.write("usage: node scripts/check-data-licences.mjs <output of reuse spdx>\n");
    process.exit(2);
  }
  const result = checkDataLicences({
    spdxText: readFileSync(resolve(spdxPath), "utf8"),
    reuseToml: readFileSync(join(repoRoot, "REUSE.toml"), "utf8"),
    exemptions: JSON.parse(
      readFileSync(join(repoRoot, "scripts/data-licence-exemptions.json"), "utf8"),
    ),
    readFile: (path) => readFileSync(join(repoRoot, path), "utf8"),
  });
  for (const violation of result.violations) {
    process.stdout.write(`FAIL ${violation.path}: ${violation.problem}\n`);
  }
  process.stdout.write(
    `${result.checked} data files checked, ${result.exempt} on the exempt list, ${result.violations.length} problems\n`,
  );
  if (result.violations.length > 0) {
    process.stdout.write(
      "Give each data file its source licence in REUSE.toml, or add it to scripts/data-licence-exemptions.json with a reason.\n",
    );
  }
  process.exitCode = result.violations.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
