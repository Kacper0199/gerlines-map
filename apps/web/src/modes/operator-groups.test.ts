import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  groupKeyOf,
  groupTable,
  type OperatorRow,
  operatorGroupOfRow,
} from "./operator-group-rules.ts";
import { OPERATOR_GROUP_TABLE } from "./operator-groups.generated.ts";
import {
  COLOURED_GROUPS,
  isColouredGroup,
  isOperatorGroup,
  OPERATOR_DRAW_ORDER,
  OPERATOR_GROUPS,
  operatorGroupOf,
} from "./operator-groups.ts";

const catalogue = load(
  readFileSync(resolve(import.meta.dirname, "../../../../catalog/operators.yaml"), "utf8"),
) as (OperatorRow & { brand_name?: string })[];

const rowOf = (id: string) => catalogue.find((row) => row.operator_id === id) as OperatorRow;

describe("operator groups from the catalogue", () => {
  it("has a generated table that matches catalog/operators.yaml", () => {
    expect(OPERATOR_GROUP_TABLE).toEqual(groupTable(catalogue));
  });

  it("gives every catalogue operator a group of its own table", () => {
    for (const row of catalogue) {
      expect(OPERATOR_GROUP_TABLE[row.operator_id], row.operator_id).toBeDefined();
    }
    expect(Object.keys(OPERATOR_GROUP_TABLE)).toHaveLength(catalogue.length);
  });

  it.each([
    ["db-regio-ag-nrw", "db"],
    ["db-regio-ag-s-bahn-muenchen", "db"],
    ["s-bahn-berlin-gmbh", "db"],
    ["db-fernverkehr-ag", "db"],
    ["db-regionetz-verkehrs-gmbh-kurhessenbahn", "db"],
    ["db-zug-nicht-vvs", "db"],
    ["nordwestbahn", "transdev"],
    ["bayerische-regiobahn", "transdev"],
    ["rhenus-veniro", "transdev"],
    ["ostdeutsche-eisenbahn-gmbh", "netinera"],
    ["agilis", "netinera"],
    ["albtal-verkehrs-gesellschaft", "kvvh"],
    ["hessische-landesbahn-gmbh", "hlb"],
    ["suedwestdeutsche-verkehrs-ag", "sweg"],
    ["vias-rail-gmbh", "other"],
    ["daenische-staatsbahnen", "other"],
    ["national-express", "other"],
    ["mitteldeutsche-regiobahn", "transdev"],
    ["vogtlandbahn-die-laenderbahn-gmbh-dlb", "netinera"],
    ["waldbahn-die-laenderbahn-gmbh-dlb", "netinera"],
    ["oberpfalzbahn-die-laenderbahn-gmbh-dlb", "netinera"],
    ["alex-die-laenderbahn-gmbh-dlb", "netinera"],
    ["trilex", "netinera"],
    ["die-laenderbahn-gmbh", "netinera"],
    ["oesterreichische-bundesbahnen", "other"],
    ["sbb", "other"],
    ["vlexx", "other"],
    ["eurobahn", "other"],
  ])("puts %s into %s", (id, group) => {
    expect(OPERATOR_GROUP_TABLE[id]).toBe(group);
  });

  it("puts every operator whose id starts with db into Deutsche Bahn", () => {
    for (const row of catalogue.filter((entry) => entry.operator_id.startsWith("db-"))) {
      expect(operatorGroupOfRow(row), row.operator_id).toBe("db");
    }
  });

  it("takes the first listed parent when there are several and merges the aliases", () => {
    expect(groupKeyOf(rowOf("vias-gmbh"))).toBe("Q83824");
    expect(groupKeyOf(rowOf("waldbahn-die-laenderbahn-gmbh-dlb"))).toBe("Q558401");
    expect(groupKeyOf(rowOf("mitteldeutsche-regiobahn"))).toBe("Q104185516");
    expect(groupKeyOf(rowOf("nordwestbahn"))).toBe("Q104185516");
    expect(groupKeyOf(rowOf("odeg-ostdeutsche-eisenbahn-gmbh"))).toBe("Q558401");
  });

  it("makes an operator without a parent its own group", () => {
    expect(groupKeyOf(rowOf("sbb"))).toBe("Q83835");
    expect(groupKeyOf(rowOf("chemnitzer-modell"))).toBe("operator:chemnitzer-modell");
  });

  it("names only groups the catalogue itself names", () => {
    const names = catalogue.flatMap((row) => [
      row.feed_name,
      row.brand_name ?? "",
      ...(row.parents ?? []).map((parent) => parent.name),
    ]);
    const qids = catalogue.flatMap((row) => [
      row.wikidata_qid,
      ...(row.parents ?? []).map((parent) => parent.wikidata_qid),
    ]);
    for (const group of COLOURED_GROUPS) {
      expect(
        names.some((name) => name.includes(group.name)),
        group.name,
      ).toBe(true);
      expect(qids, group.name).toContain(group.qid);
    }
  });

  it("covers every coloured group with at least one operator", () => {
    const used = new Set(Object.values(OPERATOR_GROUP_TABLE));
    for (const group of COLOURED_GROUPS) expect(used.has(group.id), group.id).toBe(true);
  });
});

describe("operator group of a train", () => {
  it("reads the group from the catalogue operator id of the frame", () => {
    expect(operatorGroupOf("db-regio-ag-nrw")).toBe("db");
    expect(operatorGroupOf("vlexx")).toBe("other");
  });

  it("shows a missing operator, or one the catalogue does not list, as unknown and never as other", () => {
    expect(operatorGroupOf(null)).toBe("unknown");
    expect(operatorGroupOf(undefined)).toBe("unknown");
    expect(operatorGroupOf("a-new-railway")).toBe("unknown");
    expect(operatorGroupOf("constructor")).toBe("unknown");
    expect(operatorGroupOf("__proto__")).toBe("unknown");
  });

  it("lists the coloured groups, then Other and Unknown", () => {
    expect(OPERATOR_GROUPS).toEqual([
      "db",
      "transdev",
      "netinera",
      "kvvh",
      "hlb",
      "sweg",
      "other",
      "unknown",
    ]);
    expect(OPERATOR_GROUPS.every(isOperatorGroup)).toBe(true);
    expect(isOperatorGroup("rainbow")).toBe(false);
    expect(OPERATOR_GROUPS.filter(isColouredGroup)).toHaveLength(COLOURED_GROUPS.length);
  });

  it("draws Deutsche Bahn under the smaller groups and the unclassified trains under everything", () => {
    expect(OPERATOR_DRAW_ORDER.unknown).toBeLessThan(OPERATOR_DRAW_ORDER.other);
    expect(OPERATOR_DRAW_ORDER.other).toBeLessThan(OPERATOR_DRAW_ORDER.db);
    for (const group of COLOURED_GROUPS.slice(1)) {
      expect(OPERATOR_DRAW_ORDER[group.id]).toBeGreaterThan(OPERATOR_DRAW_ORDER.db);
    }
  });
});
