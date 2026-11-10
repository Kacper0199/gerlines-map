import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockingFindings, severityOf } from "./check-pip-audit.mjs";

const advisories = {
  "GHSA-high-0001": { id: "GHSA-high-0001", database_specific: { severity: "HIGH" } },
  "GHSA-crit-0001": { id: "GHSA-crit-0001", database_specific: { severity: "CRITICAL" } },
  "GHSA-mod-00001": { id: "GHSA-mod-00001", database_specific: { severity: "MODERATE" } },
  "PYSEC-2026-1": { id: "PYSEC-2026-1", aliases: ["CVE-2026-1", "GHSA-high-0001"] },
  "PYSEC-2026-2": { id: "PYSEC-2026-2", aliases: ["CVE-2026-2"] },
};

const lookup = async (id) => advisories[id] ?? null;

function report(...vulns) {
  return {
    dependencies: [
      { name: "clean", version: "1.0", vulns: [] },
      { name: "pillow", version: "13.0.0", vulns },
    ],
  };
}

describe("severityOf", () => {
  it("reads the GitHub advisory severity", async () => {
    assert.equal(await severityOf({ id: "GHSA-crit-0001", aliases: [] }, lookup), "CRITICAL");
  });

  it("follows an alias to the GitHub advisory when the PyPI record has no severity", async () => {
    assert.equal(await severityOf({ id: "PYSEC-2026-1", aliases: ["CVE-2026-1"] }, lookup), "HIGH");
  });

  it("says UNKNOWN when no record names a severity", async () => {
    assert.equal(await severityOf({ id: "PYSEC-2026-2", aliases: [] }, lookup), "UNKNOWN");
    assert.equal(await severityOf({ id: "PYSEC-missing", aliases: [] }, lookup), "UNKNOWN");
  });
});

describe("blockingFindings", () => {
  it("passes a report without vulnerabilities", async () => {
    assert.deepEqual(await blockingFindings(report(), lookup), { blocking: [], other: [] });
  });

  it("blocks high and critical findings and lists moderate ones without blocking", async () => {
    const result = await blockingFindings(
      report(
        { id: "GHSA-mod-00001", aliases: [], fix_versions: ["13.0.1"] },
        { id: "PYSEC-2026-1", aliases: [], fix_versions: ["13.1.0"] },
        { id: "GHSA-crit-0001", aliases: [], fix_versions: [] },
      ),
      lookup,
    );
    assert.deepEqual(
      result.blocking.map((finding) => [finding.id, finding.severity]),
      [
        ["PYSEC-2026-1", "HIGH"],
        ["GHSA-crit-0001", "CRITICAL"],
      ],
    );
    assert.deepEqual(
      result.other.map((finding) => [finding.package, finding.id, finding.severity]),
      [["pillow 13.0.0", "GHSA-mod-00001", "MODERATE"]],
    );
  });

  it("blocks a finding whose severity is unknown, since it may be high", async () => {
    const result = await blockingFindings(
      report({ id: "PYSEC-2026-2", aliases: ["CVE-2026-2"], fix_versions: [] }),
      lookup,
    );
    assert.deepEqual(
      result.blocking.map((finding) => finding.severity),
      ["UNKNOWN"],
    );
  });
});
