#!/usr/bin/env node
// Fails on a high or critical (or unrated) advisory in a pip-audit JSON report; pip-audit itself has no severity filter.
// Severities come from the OSV records (GitHub advisories). Usage: node scripts/check-pip-audit.mjs <pip-audit.json>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKING = new Set(["HIGH", "CRITICAL", "UNKNOWN"]);
const OSV_VULNS = "https://api.osv.dev/v1/vulns/";

function ratingOf(record) {
  const severity = record?.database_specific?.severity;
  return typeof severity === "string" && severity !== "" ? severity.toUpperCase() : null;
}

export async function severityOf(vuln, lookup) {
  const record = await lookup(vuln.id);
  const own = ratingOf(record);
  if (own) return own;
  const aliases = [...new Set([...(vuln.aliases ?? []), ...(record?.aliases ?? [])])].sort(
    (left, right) => Number(right.startsWith("GHSA-")) - Number(left.startsWith("GHSA-")),
  );
  for (const alias of aliases) {
    const rating = ratingOf(await lookup(alias));
    if (rating) return rating;
  }
  return "UNKNOWN";
}

export async function blockingFindings(report, lookup) {
  const blocking = [];
  const other = [];
  for (const dependency of report.dependencies ?? []) {
    for (const vuln of dependency.vulns ?? []) {
      const finding = {
        package: `${dependency.name} ${dependency.version}`,
        id: vuln.id,
        severity: await severityOf(vuln, lookup),
        fixVersions: vuln.fix_versions ?? [],
      };
      (BLOCKING.has(finding.severity) ? blocking : other).push(finding);
    }
  }
  return { blocking, other };
}

function osvLookup() {
  const userAgent = `${process.env.APP_NAME || "GerLines"}-ci/1 (+${process.env.APP_CONTACT || "https://github.com/Kacper0199/gerlines-map"})`;
  const records = new Map();
  return (id) => {
    if (!records.has(id)) {
      records.set(
        id,
        fetch(`${OSV_VULNS}${encodeURIComponent(id)}`, {
          headers: { "User-Agent": userAgent, Accept: "application/json" },
        }).then(async (response) => {
          if (response.status === 404) return null;
          if (!response.ok) throw new Error(`OSV answered ${response.status} for ${id}`);
          return response.json();
        }),
      );
    }
    return records.get(id);
  };
}

function line(finding) {
  const fix = finding.fixVersions.length > 0 ? finding.fixVersions.join(", ") : "none";
  return `${finding.severity.padEnd(8)} ${finding.package} ${finding.id} (fixed in ${fix})`;
}

async function main(path) {
  if (!path) {
    process.stderr.write("usage: node scripts/check-pip-audit.mjs <pip-audit.json>\n");
    return 2;
  }
  const report = JSON.parse(readFileSync(path, "utf8"));
  const { blocking, other } = await blockingFindings(report, osvLookup());
  for (const finding of other) process.stdout.write(`allowed  ${line(finding)}\n`);
  for (const finding of blocking) process.stdout.write(`blocking ${line(finding)}\n`);
  const audited = (report.dependencies ?? []).length;
  process.stdout.write(
    `${audited} Python packages audited, ${blocking.length} high, critical or unrated, ${other.length} lower\n`,
  );
  return blocking.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv[2]);
}
