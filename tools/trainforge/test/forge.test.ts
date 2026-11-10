import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import fc from "fast-check";
import { load } from "js-yaml";
import { MeshoptDecoder } from "meshoptimizer";
import { beforeAll, describe, expect, it } from "vitest";
import { type BuildResult, buildAll } from "../src/build.ts";
import type { CarTypeInput, NoseShape, VehicleInput } from "../src/catalog.ts";
import { readCatalog } from "../src/catalog.ts";
import { buildBody, buildBogie } from "../src/geometry/car-body.ts";
import { LODS, type LodSettings } from "../src/geometry/lod.ts";
import { dbOperators, drawsDbLogo } from "../src/logo.ts";
import { ATLAS_COLUMNS, SLOTS } from "../src/palette.ts";
import { type BogieSpec, type CarSpec, resolveCar } from "../src/spec.ts";

const CATALOG = resolve(import.meta.dirname, "../../../catalog");
const catalog = readCatalog(CATALOG);
const first = catalog.vehicles[0] as VehicleInput;

let built: BuildResult;
beforeAll(async () => {
  built = await buildAll(catalog);
});

describe("the committed catalogue", () => {
  it("builds every model within the triangle budgets of every level of detail", () => {
    const over = built.models.flatMap((m) =>
      m.carTypes.flatMap((c) =>
        c.lods
          .filter((l) => l.carTriangles > l.budget)
          .map((l) => `${m.modelId}/${c.carType}/lod${l.level} ${l.carTriangles} > ${l.budget}`),
      ),
    );
    expect(over).toEqual([]);
    expect(built.models.length).toBe(catalog.vehicles.length);
  });

  it("names a bogie file for every pivot of every consist", () => {
    for (const model of built.models) {
      expect(model.consist.pivots).toHaveLength(model.consist.bogieOffsets.length);
      for (const pivot of model.consist.pivots) {
        const bogie = model.bogies[pivot.bogie];
        expect(bogie, `${model.modelId} ${pivot.bogie}`).toBeDefined();
        for (const lod of bogie?.lods ?? []) expect(built.files.has(lod.file)).toBe(true);
      }
    }
  });

  it("gives a series model the car count of its series row when the row fixes one", () => {
    const series = load(readFileSync(resolve(CATALOG, "vehicle-series.yaml"), "utf8")) as {
      series_id: string;
      cars_min?: number;
      cars_max?: number;
    }[];
    const fixed = new Map(
      series
        .filter((s) => s.cars_min !== undefined && s.cars_min === s.cars_max)
        .map((s) => [s.series_id, s.cars_min as number]),
    );
    const checked = catalog.vehicles.filter((m) => m.series_id && fixed.has(m.series_id));
    expect(checked.map((m) => m.model_id)).toContain("db-563");
    for (const model of checked)
      expect(model.formation.length, model.model_id).toBe(fixed.get(model.series_id as string));
  });

  it("refuses model ids the catalogue does not know", async () => {
    await expect(buildAll(catalog, ["no-such-model"])).rejects.toThrow(/unknown model ids/);
  });

  it("keeps a golden hash of every output file", () => {
    const hash = createHash("sha256");
    for (const path of [...built.files.keys()].sort()) {
      hash.update(path);
      hash.update(built.files.get(path) as Uint8Array);
    }
    expect(hash.digest("hex")).toMatchSnapshot();
  });

  it("writes the same bytes for the same input", async () => {
    const again = await buildAll(catalog, [first.model_id]);
    for (const [path, bytes] of again.files) {
      if (path === "palette.png") continue;
      expect(
        Buffer.compare(Buffer.from(bytes), Buffer.from(built.files.get(path) as Uint8Array)),
      ).toBe(0);
    }
  });

  it("matches each unit length to its cars and every bogie pivot to the consist", () => {
    for (const model of built.models) {
      const lengths = model.formation.map(
        (f) => model.carTypes.find((c) => c.carType === f.carType)?.lengthM ?? 0,
      );
      expect(model.consist.length).toBeCloseTo(
        lengths.reduce((a, b) => a + b, 0),
        3,
      );
      const cars = model.consist.cars;
      const shared = cars.filter((c, i) => cars[i + 1]?.front === c.rear).length;
      const jacobsJoints = model.formation.slice(0, -1).filter((f) => {
        const bogies = model.carTypes.find((c) => c.carType === f.carType)?.bogies ?? [];
        return bogies[f.reversed ? 0 : 1]?.kind === "jacobs";
      }).length;
      expect(shared).toBe(jacobsJoints);
      expect(model.consist.bogieOffsets.length).toBe(2 * model.formation.length - shared);
    }
  });
});

describe("glTF extras", () => {
  it("carry the length, bogie positions, Jacobs flag, series and level of detail", async () => {
    await MeshoptDecoder.ready;
    const io = new NodeIO()
      .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
      .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
    const model = built.models[0];
    const car = model?.carTypes[0];
    const lod = car?.lods[0];
    const doc = await io.readBinary(built.files.get(lod?.file ?? "") as Uint8Array);
    const node = doc.getRoot().listNodes()[0];
    const extras = node?.getExtras() as { gerlines: Record<string, unknown> };
    expect(extras.gerlines).toMatchObject({
      kind: "car",
      modelId: model?.modelId,
      seriesId: model?.seriesId,
      carType: car?.carType,
      lod: 0,
      lengthM: car?.lengthM,
      bogies: car?.bogies,
      jacobs: car?.jacobs,
    });
    const position = node?.getMesh()?.listPrimitives()[0]?.getAttribute("POSITION");
    expect(position?.getComponentType()).toBe(5126);
    expect(node?.getTranslation()).toEqual([0, 0, 0]);
    expect(node?.getScale()).toEqual([1, 1, 1]);
  });
});

describe("DB logo", () => {
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const logoColumn = SLOTS.indexOf("logo");
  const drawsLogo = async (file: string) => {
    const doc = await io.readBinary(built.files.get(file) as Uint8Array);
    const uv = doc.getRoot().listMeshes()[0]?.listPrimitives()[0]?.getAttribute("TEXCOORD_0");
    const element: number[] = [];
    for (let i = 0; i < (uv?.getCount() ?? 0); i++)
      if (Math.floor((uv?.getElement(i, element)[0] ?? 0) * ATLAS_COLUMNS) === logoColumn)
        return true;
    return false;
  };

  it("belongs to the operators under Deutsche Bahn in operators.yaml", () => {
    const group = dbOperators(catalog.operators ?? []);
    for (const id of [
      "db-fernverkehr-ag",
      "db-regio-ag",
      "db-regio-ag-nrw",
      "s-bahn-hamburg",
      "s-bahn-berlin-gmbh",
      "db-regio-ag-s-bahn-muenchen",
      "db-regio-ag-s-bahn-stuttgart",
      "db-regio-ag-s-bahn-rhein-main",
      "db-regionetz-verkehrs-gmbh-erzgebirgsbahn",
    ])
      expect(group.has(id), id).toBe(true);
    for (const id of ["s-bahn-hannover", "sncf"]) expect(group.has(id), id).toBe(false);
  });

  it("is kept on a model whose own livery is neutral or another operator's when a DB row names its series", () => {
    const model = (id: string) => catalog.vehicles.find((v) => v.model_id === id) as VehicleInput;
    for (const id of ["db-1648", "db-643", "db-620", "db-445", "db-446", "db-1428", "flirt-3-xl"])
      expect(drawsDbLogo(model(id), catalog), id).toBe(true);
    for (const id of ["coradia-lint-41", "db-3429", "mireo-3", "talent-3", "sncf-tgv-duplex"])
      expect(drawsDbLogo(model(id), catalog), id).toBe(false);
  });

  it("is drawn only on models of a DB livery or of a series with a DB row, never elsewhere", async () => {
    await MeshoptDecoder.ready;
    const plated = new Set(
      catalog.vehicles
        .filter((m) => m.car_types.some((c) => c.front?.decals?.some((d) => d.logo)))
        .map((m) => m.model_id),
    );
    const drawn: string[] = [];
    for (const model of built.models) {
      const input = catalog.vehicles.find((v) => v.model_id === model.modelId) as VehicleInput;
      const files = model.carTypes.flatMap((c) => c.lods.map((l) => l.file));
      let logo = false;
      for (const file of files) logo ||= await drawsLogo(file);
      expect(logo, model.modelId).toBe(drawsDbLogo(input, catalog) && plated.has(model.modelId));
      if (logo) drawn.push(model.modelId);
    }
    for (const id of ["coradia-lint-41", "db-3429", "mireo-3", "talent-3"])
      expect(drawn, id).not.toContain(id);
    for (const id of ["db-422", "db-474", "db-481", "db-484", "db-612", "db-428-flirt3", "db-1648"])
      expect(drawn, id).toContain(id);
    for (const id of ["flirt-3-xl", "db-643", "db-620", "db-445"]) expect(drawn, id).toContain(id);
  });
});

const NOSES: NoseShape[] = ["streamlined", "wedge", "rounded", "blunt", "cab_car", "locomotive"];

const carArbitrary = fc
  .record({
    length: fc.double({ min: 12, max: 30, noNaN: true }),
    width: fc.double({ min: 2.7, max: 3.15, noNaN: true }),
    height: fc.double({ min: 3.6, max: 4.7, noNaN: true }),
    floor: fc.double({ min: 0.55, max: 1.3, noNaN: true }),
    role: fc.constantFrom("cab", "middle", "locomotive", "driving_trailer", "power_head" as const),
    nose: fc.constantFrom(...NOSES),
    bogies: fc.constantFrom(
      ["own", "own"],
      ["own", "jacobs"],
      ["jacobs", "jacobs"],
      ["jacobs", "own"],
    ),
    doubleDeck: fc.boolean(),
    pantographs: fc.integer({ min: 0, max: 2 }),
    category: fc.constantFrom("hsr", "ld", "reg", "sbahn", "rfast"),
  })
  .map(
    ({ length, width, height, floor, role, nose, bogies, doubleDeck, pantographs, category }) => {
      const deck = doubleDeck && height > 4.4;
      const car: CarTypeInput = {
        car_type: "car",
        name: "Car",
        role,
        length_m: length,
        width_m: width,
        height_m: height,
        floor_height_m: deck ? 0.6 : floor,
        double_deck: deck,
        lower_deck_floor_m: deck ? 0.45 : null,
        bogies: (role === "locomotive" ? ["own", "own"] : bogies) as CarTypeInput["bogies"],
        bogie_pitch_m: length * 0.65,
        wheel_diameter_m: 0.85,
        nose_shape: role === "middle" ? null : nose,
        pantograph_count: pantographs,
        source: "s",
      };
      const model: VehicleInput = {
        model_id: "m",
        name: "M",
        generic: true,
        category,
        formation: [{ car_type: "car" }],
        car_types: [car],
        source: "s",
      };
      return resolveCar(model, car);
    },
  );

function outside(
  p: readonly number[],
  box: { x: number; y: number; zMin: number; zMax: number },
): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < p.length; i += 3) {
    const [x, y, z] = [p[i] as number, p[i + 1] as number, p[i + 2] as number];
    if (Math.abs(x) <= box.x && Math.abs(y) <= box.y && z >= box.zMin && z <= box.zMax) continue;
    out.push([x, y, z]);
    if (out.length === 5) break;
  }
  return out;
}

function expectBodyInBox(spec: CarSpec, p: readonly number[]) {
  const box = {
    x: spec.length / 2 + 1e-6,
    y: spec.width / 2 + 1e-6,
    zMin: 0,
    zMax: spec.height + 0.35,
  };
  expect(outside(p, box)).toEqual([]);
}

function expectBogieInBox(pivot: BogieSpec, lod: LodSettings) {
  const box = { x: pivot.wheelbase / 2 + 0.5, y: 1.05, zMin: 0, zMax: Number.POSITIVE_INFINITY };
  expect(outside(buildBogie(pivot, lod).positions, box)).toEqual([]);
}

describe("every vertex lies inside the car's box", () => {
  it("holds for bodies and bogies of random cars at every level of detail", () => {
    fc.assert(
      fc.property(carArbitrary, (spec) => {
        for (const lod of LODS) {
          const body = buildBody(spec, lod);
          expect(body.triangleCount).toBeGreaterThan(0);
          expectBodyInBox(spec, body.positions);
          for (const pivot of spec.bogies) expectBogieInBox(pivot, lod);
        }
      }),
      { numRuns: 60, seed: 5101 },
    );
  });
});
