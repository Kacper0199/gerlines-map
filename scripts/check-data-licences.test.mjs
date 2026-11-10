import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkDataLicences,
  isDataPath,
  parseCatchAll,
  parseSpdxFiles,
} from "./check-data-licences.mjs";

const REUSE_TOML = `version = 1

[[annotations]]
path = "**"
SPDX-FileCopyrightText = "2026 GerLines contributors"
SPDX-License-Identifier = "AGPL-3.0-or-later"

[[annotations]]
path = "a/fixtures/feed.json"
precedence = "override"
SPDX-FileCopyrightText = ["2026 DELFI e.V.", "2026 GerLines contributors"]
SPDX-License-Identifier = "CC-BY-4.0"
`;

function spdxFile(path, licences, copyright) {
  return [
    `FileName: ./${path}`,
    "SPDXID: SPDXRef-x",
    "LicenseConcluded: NOASSERTION",
    ...licences.map((licence) => `LicenseInfoInFile: ${licence}`),
    `FileCopyrightText: <text>${copyright.map((line) => `SPDX-FileCopyrightText: ${line}`).join("\n")}</text>`,
    "",
  ].join("\n");
}

const CATCH_ALL = ["AGPL-3.0-or-later"];
const OURS = ["2026 GerLines contributors"];

function check(files, exemptions = [], contents = {}) {
  return checkDataLicences({
    spdxText: `SPDXVersion: SPDX-2.1\n\n${files.join("\n")}`,
    reuseToml: REUSE_TOML,
    exemptions,
    readFile: (path) => contents[path] ?? "",
  });
}

describe("isDataPath", () => {
  it("treats files under fixtures, test-vectors, results and data as data", () => {
    assert.equal(isDataPath("apps/web/test/fixtures/sample.json"), true);
    assert.equal(isDataPath("design/variants/data/trains.json"), true);
    assert.equal(isDataPath("packages/live-frame/test-vectors/a.bin"), true);
    assert.equal(isDataPath("spikes/sp-2/results/total.txt"), true);
  });

  it("treats the data extensions as data anywhere", () => {
    for (const path of ["x.pb", "a/b.json.gz", "geo/de.geojson", "c.csv", "d/e.xml"]) {
      assert.equal(isDataPath(path), true, path);
    }
  });

  it("leaves code and documents alone, also when the file name says fixtures", () => {
    assert.equal(isDataPath("src/fixtures.ts"), false);
    assert.equal(isDataPath("docs/results.md"), false);
    assert.equal(isDataPath("README.md"), false);
  });
});

describe("parseCatchAll", () => {
  it("reads the copyright and licence of the ** annotation", () => {
    assert.deepEqual(parseCatchAll(REUSE_TOML), {
      copyright: "2026 GerLines contributors",
      licence: "AGPL-3.0-or-later",
    });
  });

  it("throws when there is no catch-all", () => {
    assert.throws(() => parseCatchAll('[[annotations]]\npath = "a/**"\n'), /no path = "\*\*"/);
  });
});

describe("parseSpdxFiles", () => {
  it("reads several licences and multi-line copyright texts", () => {
    const [file] = parseSpdxFiles(
      spdxFile(
        "a/b.csv",
        ["CC-BY-4.0", "ODbL-1.0"],
        ["2026 DELFI e.V.", "OpenStreetMap contributors"],
      ),
    );
    assert.deepEqual(file, {
      path: "a/b.csv",
      licences: ["CC-BY-4.0", "ODbL-1.0"],
      copyright: ["2026 DELFI e.V.", "OpenStreetMap contributors"],
    });
  });
});

describe("checkDataLicences", () => {
  it("passes annotated data and code under the catch-all", () => {
    const result = check([
      spdxFile(
        "a/fixtures/feed.json",
        ["CC-BY-4.0"],
        ["2026 DELFI e.V.", "2026 GerLines contributors"],
      ),
      spdxFile("src/main.ts", CATCH_ALL, OURS),
    ]);
    assert.deepEqual(result.violations, []);
    assert.equal(result.checked, 1);
  });

  it("fails a data file that only the catch-all labels", () => {
    const result = check([spdxFile("services/x/test/fixtures/feed.pb", CATCH_ALL, OURS)]);
    assert.deepEqual(result.violations, [
      {
        path: "services/x/test/fixtures/feed.pb",
        problem: "data file resolves only to the catch-all",
      },
    ]);
  });

  it("fails a data file labelled AGPL with a third-party copyright too", () => {
    const result = check([
      spdxFile("data/stations.csv", CATCH_ALL, ["2026 GerLines contributors"]),
      spdxFile("data/other.csv", CATCH_ALL, ["2026 Someone Else"]),
    ]);
    assert.deepEqual(
      result.violations.map((violation) => violation.path),
      ["data/stations.csv"],
    );
  });

  it("accepts exempt files and directories", () => {
    const result = check(
      [
        spdxFile("packages/v/test-vectors/a.bin", CATCH_ALL, OURS),
        spdxFile("packages/v/test-vectors/b.json", CATCH_ALL, OURS),
        spdxFile("tools/one.xml", CATCH_ALL, OURS),
      ],
      [
        { path: "packages/v/test-vectors/", reason: "synthetic" },
        { path: "tools/one.xml", reason: "our own config" },
      ],
    );
    assert.deepEqual(result.violations, []);
    assert.equal(result.exempt, 3);
  });

  it("fails an exemption that no longer matches an unlabelled data file", () => {
    const result = check(
      [spdxFile("a/fixtures/feed.json", ["CC-BY-4.0"], ["2026 DELFI e.V."])],
      [{ path: "a/fixtures/feed.json", reason: "was unlabelled once" }],
    );
    assert.deepEqual(result.violations, [
      { path: "a/fixtures/feed.json", problem: "exemption matches no unlabelled data file" },
    ]);
  });

  it("fails a header-only exemption once the file has rows", () => {
    const exemptions = [{ path: "p/stations.csv", reason: "header only", headerOnly: true }];
    const files = [spdxFile("p/stations.csv", CATCH_ALL, OURS)];
    assert.deepEqual(
      check(files, exemptions, { "p/stations.csv": "name,lon,lat\n" }).violations,
      [],
    );
    assert.deepEqual(
      check(files, exemptions, { "p/stations.csv": "name,lon,lat\nBerlin Hbf,13.37,52.52\n" })
        .violations,
      [{ path: "p/stations.csv", problem: "exempt as header only, but it has data rows" }],
    );
  });

  it("rejects an exemption without a reason", () => {
    assert.throws(() => check([], [{ path: "a/", reason: " " }]), /needs a path and a reason/);
  });

  it("rejects an empty SPDX document", () => {
    assert.throws(() => check([]), /lists no files/);
  });
});

describe("command line", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-data-licences.mjs");

  it("exits 1 and names the file when a data file is unlabelled", () => {
    const workDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gerlines-data-licences-"));
    try {
      const spdxPath = join(workDir, "reuse.spdx");
      writeFileSync(spdxPath, spdxFile("x/fixtures/mislabelled.json", CATCH_ALL, OURS));
      const result = spawnSync(process.execPath, [script, spdxPath], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /FAIL x\/fixtures\/mislabelled\.json/);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
