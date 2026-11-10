import { describe, expect, it } from "vitest";
import {
  GENERIC_MODEL_OF,
  liveryRowOf,
  MAX_COUPLED_UNITS,
  modelForCategory,
  modelForTrain,
  parseCatalog,
} from "./catalog.ts";
import { IDENTICAL_BODY_TABLE } from "./identical-bodies.generated.ts";
import { bodyTable } from "./identical-body-rules.ts";
import { liveryManifest, seriesManifest, testManifest } from "./test-catalog.ts";

describe("parseCatalog", () => {
  it("reads consists, meshes and the palette layout of the forge's manifest", () => {
    const catalog = parseCatalog(testManifest());
    expect(catalog.palette).toMatchObject({
      columns: 32,
      rows: 2,
      modeColumn: 14,
      lightColumn: 12,
      tailColumn: 22,
      logoColumns: [],
      logoRows: [true, true],
    });
    const sbahn = catalog.models.get("generic-sbahn");
    expect(sbahn?.consist.carCount).toBe(2);
    expect([...(sbahn?.consist.bogieOffsets ?? [])]).toEqual([2, 15, 28]);
    expect(sbahn?.pivotMeshes).toEqual([
      "generic-sbahn/bogie-a",
      "generic-sbahn/bogie-j",
      "generic-sbahn/bogie-a",
    ]);
    expect(sbahn?.cars[1]).toEqual({ carType: "end", reversed: true });
    expect(catalog.meshes.get("generic-sbahn/end")?.files).toEqual([
      "models/generic-sbahn/end.lod0.glb",
      "models/generic-sbahn/end.lod1.glb",
      "models/generic-sbahn/end.lod2.glb",
    ]);
  });

  it("reads which palette rows show the DB logo, every row when the manifest does not list them", () => {
    const listed = { ...liveryManifest().palette, logoRows: [2, 4] };
    const catalog = parseCatalog({
      ...liveryManifest(),
      palette: { ...listed, slots: [...liveryManifest().palette.slots, "logo", "logo_ink"] },
    });
    expect(catalog.palette.logoRows).toEqual([false, false, true, false, true]);
    expect(catalog.palette.logoColumns).toEqual([23, 24]);
    expect(parseCatalog(liveryManifest()).palette.logoRows).toEqual([true, true, true, true, true]);
  });

  it("rejects another schema and a consist that does not match its formation", () => {
    expect(() => parseCatalog({ ...testManifest(), schema: 1 })).toThrow(/schema/);
    const broken = testManifest();
    broken.models[0]?.formation.pop();
    expect(() => parseCatalog(broken)).toThrow(/formation/);
  });

  it("draws every frame category with the generic model of its service", () => {
    const catalog = parseCatalog(testManifest());
    expect(modelForCategory(catalog, "urban")?.modelId).toBe("generic-sbahn");
    expect(modelForCategory(catalog, "hsr")?.modelId).toBe("generic-hsr");
    expect(modelForCategory(catalog, "ld")).toBeUndefined();
    expect(Object.keys(GENERIC_MODEL_OF)).toHaveLength(9);
  });
});

describe("modelForTrain", () => {
  const catalog = parseCatalog(seriesManifest());

  it("draws a train of a known series with the first model the forge lists for it", () => {
    expect(modelForTrain(catalog, { category: "hsr", series: "db-412" })?.modelId).toBe("db-412-7");
    expect(modelForTrain(catalog, { category: "sbahn", series: "db-423" })?.modelId).toBe("db-423");
  });

  it("falls back to the generic model of the category without a series or a forge model for it", () => {
    expect(modelForTrain(catalog, { category: "hsr" })?.modelId).toBe("generic-hsr");
    expect(modelForTrain(catalog, { category: "hsr", series: "db-401" })?.modelId).toBe(
      "generic-hsr",
    );
    expect(modelForTrain(catalog, { category: "reg", series: "db-1440" })?.modelId).toBe(
      "generic-reg-emu",
    );
    expect(modelForTrain(catalog, { category: "ld", series: "db-999" })).toBeUndefined();
  });

  it("couples units of a series front to back, cab to cab, up to the most units a rule allows", () => {
    const single = modelForTrain(catalog, { category: "sbahn", series: "db-423", units: 1 });
    const double = modelForTrain(catalog, { category: "sbahn", series: "db-423", units: 2 });
    expect(modelForTrain(catalog, { category: "sbahn", series: "db-423", units: null })).toBe(
      single,
    );
    expect(double).toBe(modelForTrain(catalog, { category: "sbahn", series: "db-423", units: 2 }));
    expect(double?.units).toBe(2);
    expect(double?.consist.length).toBe(60);
    expect([...(double?.consist.bogieOffsets ?? [])]).toEqual([2, 15, 28, 32, 45, 58]);
    expect([...(double?.consist.carFront ?? [])]).toEqual([0, 1, 3, 4]);
    expect(double?.carMeshes).toEqual(["db-423/end", "db-423/end", "db-423/end", "db-423/end"]);
    expect(double?.cars.map((car) => car.reversed)).toEqual([false, true, false, true]);
    expect(double?.pivotMeshes).toHaveLength(6);
    const most = modelForTrain(catalog, { category: "sbahn", series: "db-423", units: 9 });
    expect(most?.units).toBe(MAX_COUPLED_UNITS);
    expect(most?.consist.carCount).toBe(2 * MAX_COUPLED_UNITS);
  });
});

describe("modelForTrain with the table of identical bodies", () => {
  const catalog = parseCatalog(seriesManifest());
  const series = [
    { series_id: "db-424", name: "DB Class 424" },
    { series_id: "db-423", name: "DB Class 423" },
    { series_id: "db-412", name: "ICE 4" },
    { series_id: "db-401", name: "ICE 1" },
  ];
  const bodies = bodyTable(
    [
      { series_id: "db-424", related_series_id: "db-423", verdict: "accepted" },
      { series_id: "db-401", related_series_id: "db-412", verdict: "accepted" },
    ],
    series,
  );
  const trip = (seriesId: string, units: number | null = null) => ({
    category: "sbahn" as const,
    series: seriesId,
    units,
  });

  it("draws a series without a model of its own with the model of its related series", () => {
    expect(modelForTrain(catalog, trip("db-424"), bodies)?.modelId).toBe("db-423");
  });

  it("couples the units of the train, not of the related series", () => {
    expect(modelForTrain(catalog, trip("db-424", 2), bodies)?.units).toBe(2);
    expect(modelForTrain(catalog, trip("db-424", 2), bodies)).toBe(
      modelForTrain(catalog, trip("db-423", 2), bodies),
    );
  });

  it("keeps the series' own model when the forge has one, whatever the table says", () => {
    const own = { "db-412": { relatedSeriesId: "db-423", relatedName: "DB Class 423" } };
    expect(modelForTrain(catalog, trip("db-412"), own)?.modelId).toBe("db-412-7");
  });

  it("draws a train of another category with the related model too", () => {
    expect(modelForTrain(catalog, { category: "hsr", series: "db-401" }, bodies)?.modelId).toBe(
      "db-412-7",
    );
  });

  it("falls back to the generic model of the category when the related model is not built", () => {
    const without = parseCatalog(testManifest());
    expect(modelForTrain(without, { category: "hsr", series: "db-401" }, bodies)?.modelId).toBe(
      "generic-hsr",
    );
  });

  it("does not read the inherited keys of the table as series", () => {
    for (const series of ["constructor", "toString", "__proto__"]) {
      expect(modelForTrain(catalog, trip(series), bodies)?.modelId, series).toBe("generic-sbahn");
    }
  });

  it("draws no related model for a series the table does not name", () => {
    expect(modelForTrain(catalog, trip("db-999"), bodies)?.modelId).toBe("generic-sbahn");
  });

  it("reads the committed table when none is given", () => {
    expect(modelForTrain(catalog, trip("db-424"))).toBe(
      modelForTrain(catalog, trip("db-424"), IDENTICAL_BODY_TABLE),
    );
  });
});

describe("liveryRowOf", () => {
  const catalog = parseCatalog(liveryManifest());
  const model = (series: string) =>
    modelForTrain(catalog, { category: "sbahn", series, units: 1 }) as NonNullable<
      ReturnType<typeof modelForTrain>
    >;
  const day = "2026-11-08";

  it("paints a series model in the livery of the train's operator", () => {
    const ice = model("db-412");
    expect(ice.liveryRow).toBe(0);
    expect(
      liveryRowOf(catalog, ice, { series: "db-412", operator: "db-fernverkehr-ag" }, day),
    ).toBe(2);
  });

  it("falls back to the neutral row, not the model's own, for an operator without a livery", () => {
    const sbahn = model("db-423");
    expect(sbahn.liveryRow).toBe(1);
    expect(
      liveryRowOf(catalog, sbahn, { series: "db-423", operator: "db-regio-ag-bayern" }, day),
    ).toBe(0);
    expect(liveryRowOf(catalog, sbahn, { series: "db-423", operator: null }, day)).toBe(0);
  });

  it("splits by line and keeps the model's row for a series no rule names", () => {
    const sbahn = model("db-423");
    const trip = { series: "db-423", operator: "db-regio-ag-nrw" };
    expect(liveryRowOf(catalog, sbahn, { ...trip, line: "S1" }, day)).toBe(4);
    expect(liveryRowOf(catalog, sbahn, { ...trip, line: "S6" }, day)).toBe(3);
    const plain = parseCatalog(seriesManifest());
    const own = modelForTrain(plain, { category: "sbahn", series: "db-423" });
    expect(own && liveryRowOf(plain, own, trip, day)).toBe(1);
  });

  it("keeps a generic model on its own row whatever the frame names", () => {
    const generic = modelForTrain(catalog, { category: "hsr", series: "db-401" }) as NonNullable<
      ReturnType<typeof modelForTrain>
    >;
    expect(generic.generic).toBe(true);
    const frame = { series: "db-401", operator: "db-fernverkehr-ag" };
    expect(liveryRowOf(catalog, generic, frame, day)).toBe(generic.liveryRow);
  });

  it("paints a train drawn with the model of a related series in the neutral row, not the related one", () => {
    const bodies = bodyTable(
      [{ series_id: "db-424", related_series_id: "db-423", verdict: "accepted" }],
      [
        { series_id: "db-424", name: "DB Class 424" },
        { series_id: "db-423", name: "DB Class 423" },
      ],
    );
    const trip = { series: "db-424", operator: "db-regio-ag-nrw" };
    const related = modelForTrain(catalog, { category: "sbahn", ...trip }, bodies);
    expect(related?.modelId).toBe("db-423");
    expect(related && liveryRowOf(catalog, related, trip, day)).toBe(0);
  });
});
