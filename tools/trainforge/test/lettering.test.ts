import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCatalog } from "../src/catalog.ts";
import { bodyLayout } from "../src/geometry/body.ts";
import { buildBody } from "../src/geometry/car-body.ts";
import {
  type FrontLettering,
  letterPlace,
  stripeOutside,
  wordQuads,
} from "../src/geometry/lettering.ts";
import { LODS } from "../src/geometry/lod.ts";
import { MeshBuilder } from "../src/geometry/mesh.ts";
import { emitPanes, type Facets, PANE_LIFT, SEAM_LIFT } from "../src/geometry/panes.ts";
import {
  ATLAS_COLUMNS,
  COMBINED_TAIL_U,
  neutralRow,
  SLOTS,
  type Slot,
  slotU,
} from "../src/palette.ts";
import { resolveCar } from "../src/spec.ts";

const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
const carOf = (modelId: string, carType: string) => {
  const model = catalog.vehicles.find((m) => m.model_id === modelId);
  const car = model?.car_types.find((c) => c.car_type === carType);
  if (!model || !car) throw new Error(`${modelId} ${carType} missing`);
  return resolveCar(model, car);
};
const pointsOf = (mesh: MeshBuilder, slot: Slot) => {
  const u = slotU(slot);
  const out: number[][] = [];
  for (let t = 0; t < mesh.positions.length / 9; t++) {
    if (Math.abs((mesh.uvs[t * 6] as number) - u) > 1e-9) continue;
    for (let v = 0; v < 3; v++) out.push(mesh.positions.slice(t * 9 + v * 3, t * 9 + v * 3 + 3));
  }
  return out;
};

const WORD: FrontLettering = {
  text: "ICE",
  from: 4,
  to: 5.5,
  bottom: 1.2,
  top: 1.8,
  italic: 0.2,
  stripeGap: [3.9, 5.6],
};

describe("lettering", () => {
  it("lays the letters out left to right, leaning forwards, and refuses letters it has no glyph for", () => {
    const upright = wordQuads("ICE", 0);
    const leaning = wordQuads("ICE", 0.2);
    expect(leaning.width).toBeCloseTo(upright.width + 0.2, 9);
    const xs = (q: (typeof upright.quads)[number]) => q.map((p) => p[0]);
    const first = upright.quads[0] as (typeof upright.quads)[number];
    const last = upright.quads[upright.quads.length - 1] as (typeof upright.quads)[number];
    expect(Math.max(...xs(first))).toBeLessThan(Math.min(...xs(last)));
    for (const q of leaning.quads)
      for (const [x, v] of q) {
        expect(x).toBeGreaterThanOrEqual(-1e-9);
        expect(x).toBeLessThanOrEqual(leaning.width + 1e-9);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    expect(() => wordQuads("ICX", 0)).toThrow(/no glyph/);
  });

  it("reads from outside on both sides: back from the tip on the left, towards it on the right", () => {
    const { width } = wordQuads(WORD.text, WORD.italic);
    const left = letterPlace(WORD, 1, width);
    const right = letterPlace(WORD, -1, width);
    expect(left([0, 0])).toEqual([WORD.from, WORD.bottom]);
    expect(right([0, 0])).toEqual([WORD.to, WORD.bottom]);
    expect(left([width, 1])[0]).toBeCloseTo(WORD.to, 9);
    expect(right([width, 1])[0]).toBeCloseTo(WORD.from, 9);
  });

  it("cuts a measured stripe at the gap and keeps both pieces with interpolated ends", () => {
    const curve = [
      [6, 1.6, 1.8],
      [3, 1.3, 1.5],
      [0, 0.8, 1.0],
    ] as const;
    const pieces = stripeOutside(curve, [4, 5]);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]?.[pieces[0].length - 1]?.[0]).toBe(4);
    expect(pieces[0]?.[pieces[0].length - 1]?.[1]).toBeCloseTo(1.4, 9);
    expect(pieces[1]?.[0]?.[0]).toBe(5);
    for (const piece of pieces) for (const p of piece) expect(p[0] <= 4 || p[0] >= 5).toBe(true);
  });

  it("draws the 407's ICE lettering on both sides of the nose and leaves its stripe out there", () => {
    const spec = carOf("db-407", "end");
    const lettering = spec.front?.lettering as FrontLettering;
    expect(lettering.text).toBe("ICE");
    const end = spec.length / 2 - (spec.front?.tipGap ?? 0);
    const body = buildBody(spec, LODS[0] as (typeof LODS)[number]);
    const onSide = (p: number[]) => Math.abs(p[1] as number) > 1.2 && (p[0] as number) < end - 3;
    const letters = pointsOf(body, "equipment").filter(onSide);
    expect(letters.some((p) => (p[1] as number) > 0)).toBe(true);
    expect(letters.some((p) => (p[1] as number) < 0)).toBe(true);
    for (const p of letters) {
      const setback = end - (p[0] as number);
      expect(setback).toBeGreaterThan(lettering.from - 0.01);
      expect(setback).toBeLessThan(lettering.to + 0.01);
      expect(p[2] as number).toBeGreaterThan(lettering.bottom - 0.01);
      expect(p[2] as number).toBeLessThan(lettering.top + 0.01);
    }
    const [g0, g1] = lettering.stripeGap as readonly [number, number];
    const inGap = pointsOf(body, "stripe")
      .filter(onSide)
      .filter((p) => end - (p[0] as number) > g0 + 0.01 && end - (p[0] as number) < g1 - 0.01);
    expect(inGap).toHaveLength(0);
    const coarse = buildBody(spec, LODS[1] as (typeof LODS)[number]);
    expect(pointsOf(coarse, "equipment").filter(onSide)).toHaveLength(0);
    expect(carOf("db-403", "end").front?.lettering).toBeUndefined();
  });
});

describe("plain cab side", () => {
  it("keeps the ICE 2 driving trailer's cab side white between sill and window top, the band behind it", () => {
    const spec = carOf("db-402", "driving-trailer");
    const front = spec.front as NonNullable<typeof spec.front>;
    expect(front.plainCabSide).toBe(true);
    const passengerEnd = spec.length / 2 - (front.tipGap ?? 0.05) - front.cabLength;
    const onWall = (p: number[]) => Math.abs(Math.abs(p[1] as number) - spec.width / 2) < 0.06;
    for (const lod of LODS) {
      const band = pointsOf(buildBody(spec, lod), "window_band").filter(onWall);
      expect(band.some((p) => (p[0] as number) < passengerEnd - 0.5)).toBe(true);
      expect(band.filter((p) => (p[0] as number) > passengerEnd + 1e-6)).toHaveLength(0);
    }
    expect(carOf("db-402", "middle").front).toBeNull();
  });
});

describe("bogie skirt", () => {
  it("brings the ICE T end car's side down to the measured skirt over its bogies, clear of the wheels", () => {
    const spec = carOf("db-411", "end");
    expect(spec.bogieSkirt).toBe(1.0);
    const lod = LODS[0] as (typeof LODS)[number];
    const bogie = spec.bogies[0];
    const overBogie = (s: typeof spec) =>
      [...pointsOf(buildBody(s, lod), "lower_body"), ...pointsOf(buildBody(s, lod), "upper_body")]
        .filter((p) => Math.abs(Math.abs(p[1] as number) - s.width / 2) < 0.01)
        .filter((p) => Math.abs((p[0] as number) - bogie.x) < bogie.wheelbase / 2)
        .map((p) => p[2] as number);
    expect(Math.min(...overBogie(spec))).toBeCloseTo(1.0, 6);
    const { bogieSkirt: _, ...plain } = spec;
    expect(Math.min(...overBogie(plain))).toBeGreaterThan(1.1);
    const low = { ...spec, bogieSkirt: 0.5 };
    expect(Math.min(...overBogie(low))).toBeGreaterThan(spec.wheelDiameter);
  });
});

describe("ICE 2 tail lens", () => {
  it("gives both ICE 2 cab ends a red tail lens at the outer end of each lamp unit, on a dark field", () => {
    const lod = LODS[0] as (typeof LODS)[number];
    for (const carType of ["power-car", "driving-trailer"]) {
      const mesh = buildBody(carOf("db-402", carType), lod);
      const atLamp = (slot: Slot) =>
        pointsOf(mesh, slot).filter((p) => (p[2] as number) > 1.3 && (p[2] as number) < 1.55);
      const red = atLamp("tail");
      const white = atLamp("light");
      for (const sign of [1, -1]) {
        const side = (ps: number[][]) => ps.filter((p) => sign * (p[1] as number) > 0.2);
        const reach = (ps: number[][]) =>
          Math.max(...side(ps).map((p) => Math.abs(p[1] as number)));
        expect(side(red).length).toBeGreaterThan(0);
        expect(side(white).length).toBeGreaterThan(0);
        expect(reach(red)).toBeGreaterThan(reach(white));
        expect(reach(atLamp("housing"))).toBeGreaterThan(reach(red) + 0.025);
      }
    }
  });
});

describe("combined tail lamp", () => {
  const lod = LODS[0] as (typeof LODS)[number];
  const combinedPoints = (mesh: MeshBuilder) => {
    const out: number[][] = [];
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      if (mesh.uvs[t * 6] !== COMBINED_TAIL_U) continue;
      for (let v = 0; v < 3; v++) out.push(mesh.positions.slice(t * 9 + v * 3, t * 9 + v * 3 + 3));
    }
    return out;
  };
  it("puts the white lenses of a combined lamp inside the light cell off its centre, on both sides", () => {
    expect(Math.floor(COMBINED_TAIL_U * ATLAS_COLUMNS)).toBe(SLOTS.indexOf("light"));
    for (const id of ["db-403", "db-408", "db-411"]) {
      const mesh = buildBody(carOf(id, "end"), lod);
      const combined = combinedPoints(mesh);
      for (const sign of [1, -1])
        expect(combined.some((p) => sign * (p[1] as number) > 0.2)).toBe(true);
      expect(pointsOf(mesh, "tail")).toHaveLength(0);
    }
  });
  it("lights the whole round 481 lens red at the trailing end, about 0.18 m across as on the Hermsdorf photo", () => {
    const mesh = buildBody(carOf("db-481", "car-a"), lod);
    expect(pointsOf(mesh, "tail")).toHaveLength(0);
    const combined = combinedPoints(mesh).filter((p) => (p[1] as number) > 0.2);
    const across = (axis: number) =>
      Math.max(...combined.map((p) => p[axis] as number)) -
      Math.min(...combined.map((p) => p[axis] as number));
    expect(across(2)).toBeGreaterThan(0.16);
    expect(across(2)).toBeLessThan(0.22);
  });
  it("leaves lamps without it, and coarser levels, on the cell centre", () => {
    expect(combinedPoints(buildBody(carOf("db-402", "power-car"), lod))).toHaveLength(0);
    const coarse = LODS[1] as (typeof LODS)[number];
    expect(combinedPoints(buildBody(carOf("db-403", "end"), coarse))).toHaveLength(0);
  });
});

describe("DB logo plate", () => {
  const lod = LODS[0] as (typeof LODS)[number];
  const plated = catalog.vehicles.flatMap((model) =>
    model.car_types
      .map((car) => ({ id: `${model.model_id}/${car.car_type}`, spec: resolveCar(model, car) }))
      .filter(({ spec }) => spec.front?.decals?.some((d) => d.logo)),
  );
  it("paints the plate's red field in its own column, Verkehrsrot like the tail lens, never in the tail column", () => {
    expect(SLOTS.indexOf("logo")).toBeGreaterThan(SLOTS.indexOf("tail"));
    expect(SLOTS.indexOf("logo")).toBeLessThan(ATLAS_COLUMNS);
    const neutral = neutralRow().colours;
    expect(neutral.logo).toBe(neutral.tail);
    expect(plated.length).toBeGreaterThanOrEqual(16);
    for (const { id, spec } of plated) {
      const mesh = buildBody(spec, lod);
      const plate = spec.front?.decals?.find((d) => d.logo) as NonNullable<
        NonNullable<typeof spec.front>["decals"]
      >[number];
      const field = pointsOf(mesh, "logo");
      expect(field.length, id).toBeGreaterThan(0);
      const reach = Math.max(...field.map((p) => Math.abs(p[1] as number)));
      for (const p of field) {
        expect(p[2] as number, id).toBeGreaterThan(plate.bottom - 0.03);
        expect(p[2] as number, id).toBeLessThan(plate.top + 0.03);
      }
      const onPlate = pointsOf(mesh, "tail").filter(
        (p) =>
          (p[2] as number) > plate.bottom - 0.03 &&
          (p[2] as number) < plate.top + 0.03 &&
          Math.abs(p[1] as number) < reach + 0.01,
      );
      expect(onPlate, id).toHaveLength(0);
    }
  });
});

describe("painted class lamps", () => {
  const lod = LODS[0] as (typeof LODS)[number];
  const GENERIC = [
    "generic-ld",
    "generic-dd-coach",
    "generic-reg-emu",
    "generic-reg-dd",
    "generic-dmu",
    "generic-sbahn",
  ];
  it("give the six generic fronts a red tail lens at the outer end of each lamp, on both sides (Zg 2)", () => {
    for (const modelId of GENERIC) {
      const model = catalog.vehicles.find((m) => m.model_id === modelId);
      const fronts = (model?.car_types ?? [])
        .map((car) => ({ id: `${modelId}/${car.car_type}`, spec: resolveCar(model as never, car) }))
        .filter(({ spec }) => spec.front?.lamps);
      expect(fronts.length, modelId).toBeGreaterThan(0);
      for (const { id, spec } of fronts) {
        const lamps = spec.front?.lamps as NonNullable<NonNullable<typeof spec.front>["lamps"]>;
        const mesh = buildBody(spec, lod);
        const atLamp = (slot: Slot) =>
          pointsOf(mesh, slot).filter(
            (p) => (p[2] as number) > lamps.bottom - 0.01 && (p[2] as number) < lamps.top + 0.01,
          );
        const red = atLamp("tail");
        const white = atLamp("light");
        for (const sign of [1, -1]) {
          const side = (ps: number[][]) => ps.filter((p) => sign * (p[1] as number) > 0.2);
          const reach = (ps: number[][]) =>
            Math.max(...side(ps).map((p) => Math.abs(p[1] as number)));
          expect(side(red).length, id).toBeGreaterThan(0);
          expect(side(white).length, id).toBeGreaterThan(0);
          expect(reach(red), id).toBeGreaterThan(reach(white) - 1e-6);
          expect(Math.min(...side(red).map((p) => Math.abs(p[1] as number))), id).toBeGreaterThan(
            Math.min(...side(white).map((p) => Math.abs(p[1] as number))),
          );
        }
      }
    }
  });
  it("keeps coarser levels without lamps", () => {
    const model = catalog.vehicles.find((m) => m.model_id === "generic-reg-emu");
    const car = model?.car_types.find((c) => resolveCar(model as never, c).front?.lamps);
    const spec = resolveCar(model as never, car as never);
    for (const level of [1, 2]) {
      const mesh = buildBody(spec, LODS[level] as (typeof LODS)[number]);
      expect(pointsOf(mesh, "tail"), `lod ${level}`).toHaveLength(0);
    }
  });
});

describe("trailing end", () => {
  const lod = LODS[0] as (typeof LODS)[number];
  const tailU = slotU("tail");
  const redSides = (mesh: MeshBuilder) => {
    const sides = new Set<number>();
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      const u = mesh.uvs[t * 6];
      const y = mesh.positions[t * 9 + 1] as number;
      if ((u === tailU || u === COMBINED_TAIL_U) && Math.abs(y) > 0.2) sides.add(Math.sign(y));
    }
    return sides.size;
  };
  it("shows red at every cab front, on both sides: a tail lens or a combined lamp (Zg 2)", () => {
    const missing = catalog.vehicles.flatMap((model) =>
      model.car_types
        .map((car) => ({ id: `${model.model_id}/${car.car_type}`, spec: resolveCar(model, car) }))
        .filter(({ spec }) => spec.front && redSides(buildBody(spec, lod)) < 2)
        .map(({ id }) => id),
    );
    expect(missing).toEqual([]);
  });
  const trailingRedSides = (mesh: MeshBuilder, trailing: number, end: number) => {
    const sides = new Set<number>();
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      const u = mesh.uvs[t * 6];
      const [x, y, z] = mesh.positions.slice(t * 9, t * 9 + 3) as [number, number, number];
      const red = u === tailU || u === COMBINED_TAIL_U;
      if (red && trailing * x > end - 4 && Math.abs(y) > 0.2 && z < 2.6) sides.add(Math.sign(y));
    }
    return sides.size;
  };
  it("shows red low on both sides of the trailing end of every formation, a cab front or a coach end (Zg 2)", () => {
    const bare = catalog.vehicles.flatMap((model) => {
      const last = model.formation[model.formation.length - 1] as (typeof model.formation)[number];
      const spec = resolveCar(
        model,
        model.car_types.find((c) => c.car_type === last.car_type) as never,
      );
      const sides = trailingRedSides(buildBody(spec, lod), last.reversed ? 1 : -1, spec.length / 2);
      return sides < 2 ? [`${model.model_id}/${last.car_type}`] : [];
    });
    expect(bare).toEqual([]);
  });
  it("gives a coach that ends its formation two red lenses on its plain trailing end, outboard and low, at full detail only", () => {
    const spec = carOf("generic-ld", "coach");
    const end = bodyLayout(spec, lod).rearEnd;
    const lenses = pointsOf(buildBody(spec, lod), "tail");
    expect(lenses.length).toBeGreaterThan(0);
    for (const p of lenses) {
      expect(p[0] as number).toBeLessThan(end);
      expect(p[0] as number).toBeGreaterThan(end - 0.05);
      expect(Math.abs(p[1] as number)).toBeGreaterThan(0.8);
      expect(Math.abs(p[1] as number)).toBeLessThan(spec.width / 2);
      expect(p[2] as number).toBeLessThan(1.5);
    }
    for (const sign of [1, -1]) expect(lenses.some((p) => sign * (p[1] as number) > 0)).toBe(true);
    for (const level of [1, 2])
      expect(pointsOf(buildBody(spec, LODS[level] as (typeof LODS)[number]), "tail")).toHaveLength(
        0,
      );
    expect(pointsOf(buildBody(carOf("generic-dd-coach", "middle"), lod), "tail")).toHaveLength(0);
  });
});

describe("clear lens", () => {
  it("lights only the inner lens of each 440 lamp, the outer one a clear unlit lens in the housing", () => {
    const spec = carOf("coradia-continental-440-4", "end");
    const lamps = spec.front?.lamps as NonNullable<NonNullable<typeof spec.front>["lamps"]>;
    const mesh = buildBody(spec, LODS[0] as (typeof LODS)[number]);
    const atLamp = (ps: number[][]) =>
      ps.filter(
        (p) => (p[2] as number) > lamps.bottom - 0.01 && (p[2] as number) < lamps.top + 0.01,
      );
    const lit: number[][] = [];
    for (let t = 0; t < mesh.positions.length / 9; t++)
      if (mesh.uvs[t * 6] === COMBINED_TAIL_U)
        for (let v = 0; v < 3; v++)
          lit.push(mesh.positions.slice(t * 9 + v * 3, t * 9 + v * 3 + 3));
    const clear = atLamp(pointsOf(mesh, "glass"));
    expect(atLamp(pointsOf(mesh, "light"))).toHaveLength(0);
    for (const sign of [1, -1]) {
      const side = (ps: number[][]) => ps.filter((p) => sign * (p[1] as number) > 0.2);
      const reach = (ps: number[][]) => side(ps).map((p) => Math.abs(p[1] as number));
      expect(side(atLamp(lit)).length).toBeGreaterThan(0);
      expect(side(clear).length).toBeGreaterThan(0);
      expect(Math.max(...reach(atLamp(lit)))).toBeLessThan(Math.min(...reach(clear)));
    }
  });
});

describe("ICE 2 windscreen", () => {
  it("is one pane without a centre post on both cab ends (Hannover and Koeln Bonn Airport photos)", () => {
    for (const carType of ["power-car", "driving-trailer"]) {
      const front = carOf("db-402", carType).front;
      const posts = (front?.decals ?? []).filter(
        (d) =>
          d.inner === 0 &&
          d.outer < 0.05 &&
          d.bottom < (front?.screenTop ?? 0) &&
          d.top > (front?.screenBottom ?? 0),
      );
      expect(posts, carType).toEqual([]);
    }
  });
});

describe("coupler cover seams", () => {
  const plane: Facets = (u, z) => ({ point: [0, u, z], normal: [1, 0, 0] });
  const seam = {
    slot: "equipment" as const,
    bottom: 0.4,
    top: 1.3,
    inner: 0,
    outer: 0.005,
    round: 20,
    slant: 0,
    seam: true,
  };
  it("draws a seam just off the skin, under every other pane, and lifts nothing above it", () => {
    expect(SEAM_LIFT).toBeLessThan(PANE_LIFT / 2);
    const mesh = new MeshBuilder();
    const housing = { ...seam, slot: "housing" as const, bottom: 0.8, top: 1.0, seam: false };
    const front = { decals: [seam, housing] };
    emitPanes(mesh, front as never, plane);
    const xs = (slot: Slot) => pointsOf(mesh, slot).map((p) => p[0] as number);
    expect(new Set(xs("equipment"))).toEqual(new Set([SEAM_LIFT]));
    expect(new Set(xs("housing"))).toEqual(new Set([PANE_LIFT]));
  });
  const COVERS = [
    ["db-402", "power-car"],
    ["db-402", "driving-trailer"],
    ["db-408", "end"],
  ] as const;
  it("draws the 402, 808 and 408 cover outlines as mid grey seams at most 1.5 cm wide", () => {
    for (const [modelId, carType] of COVERS) {
      const spec = carOf(modelId, carType);
      const seams = (spec.front?.decals ?? []).filter((d) => d.seam);
      expect(seams.length, modelId).toBeGreaterThanOrEqual(2);
      expect(
        spec.front?.decals?.filter((d) => d.slot === "mask" && d.top - d.bottom > 0.5),
      ).toEqual([]);
      for (const d of seams) {
        expect(d.slot).toBe("equipment");
        const across = (d.inner > 0 ? d.outer - d.inner : 2 * d.outer) * (spec.width / 2);
        expect(Math.min(across, d.top - d.bottom), `${modelId} ${d.bottom}`).toBeLessThanOrEqual(
          0.0151,
        );
        expect(d.bottom).toBeGreaterThan(0.4);
      }
      if (modelId === "db-402") expect(seams.every((d) => d.outer < 0.75)).toBe(true);
    }
  });
});

describe("facade stripe gap", () => {
  it("leaves the ICE T side stripe out behind its lettering at full detail, behind the nose", () => {
    const spec = carOf("db-411", "end");
    const lettering = spec.front?.lettering as FrontLettering;
    const [g0, g1] = lettering.stripeGap as readonly [number, number];
    const end = bodyLayout(spec, LODS[0] as (typeof LODS)[number]).frontEnd;
    expect(g0).toBeGreaterThan(spec.front?.length ?? 0);
    const onWall = (p: number[]) => Math.abs(Math.abs(p[1] as number) - spec.width / 2) < 0.06;
    const setback = (p: number[]) => end - (p[0] as number);
    const stripe = (level: number) =>
      pointsOf(buildBody(spec, LODS[level] as (typeof LODS)[number]), "stripe").filter(onWall);
    const inGap = (p: number[]) => setback(p) > g0 + 0.01 && setback(p) < g1 - 0.01;
    expect(stripe(0).filter(inGap)).toHaveLength(0);
    expect(stripe(0).some((p) => setback(p) > g1 + 0.5)).toBe(true);
    expect(stripe(1).some(inGap)).toBe(true);
    const letters = pointsOf(buildBody(spec, LODS[0] as (typeof LODS)[number]), "equipment")
      .filter(onWall)
      .filter((p) => setback(p) > lettering.from - 0.01 && setback(p) < lettering.to + 0.01);
    for (const sign of [1, -1]) expect(letters.some((p) => sign * (p[1] as number) > 0)).toBe(true);
    for (const p of letters)
      expect(Math.abs(p[1] as number)).toBeGreaterThan(spec.width / 2 + 0.01);
  });
});
