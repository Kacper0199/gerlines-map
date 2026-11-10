import { describe, expect, it } from "vitest";
import type { CarTypeInput, VehicleInput } from "../src/catalog.ts";
import { consistLayout } from "../src/consist.ts";
import { CATEGORY_COLOURS, liveryRow, modelRow, neutralRow } from "../src/palette.ts";
import { type BogieSpec, resolveCar } from "../src/spec.ts";

const CAR: CarTypeInput = {
  car_type: "end",
  name: "End car",
  role: "cab",
  length_m: 25,
  width_m: 2.9,
  height_m: 3.9,
  floor_height_m: 1.2,
  double_deck: false,
  bogies: ["own", "own"],
  bogie_pitch_m: 17,
  bogie_offset_m: 0.5,
  wheel_diameter_m: 0.92,
  nose_shape: "streamlined",
  pantograph_count: 0,
  source: "wikipedia-de-ice-4",
};

const MODEL: VehicleInput = {
  model_id: "example",
  name: "Example",
  generic: false,
  series_id: "db-412",
  category: "hsr",
  formation: [{ car_type: "end" }, { car_type: "end", reversed: true }],
  car_types: [CAR],
  source: "wikipedia-de-ice-4",
};

describe("resolveCar", () => {
  it("takes sourced window panes and pillar colour, and lists the defaults as estimated", () => {
    const sourced = {
      ...CAR,
      window_width_m: 1.9,
      window_pillar_m: 0.16,
      window_pillars: "body" as const,
    };
    const spec = resolveCar({ ...MODEL, car_types: [sourced] }, sourced);
    expect([spec.windowWidth, spec.pillar, spec.pillars]).toEqual([1.9, 0.16, "body"]);
    expect(spec.estimated).not.toContain("window_width_m");
    const fallback = resolveCar(MODEL, CAR);
    expect(fallback.pillars).toBe("band");
    expect(fallback.estimated).toEqual(
      expect.arrayContaining(["window_width_m", "window_pillar_m"]),
    );
  });

  it("places two own bogies around the car centre by pitch and offset", () => {
    const spec = resolveCar(MODEL, CAR);
    expect(spec.bogies.map((b) => [b.x, b.kind])).toEqual([
      [9, "own"],
      [-8, "own"],
    ]);
  });

  it("puts a Jacobs bogie on the car end and the own one a pitch away", () => {
    const spec = resolveCar(MODEL, { ...CAR, bogies: ["own", "jacobs"], bogie_offset_m: null });
    expect(spec.bogies.map((b) => [b.x, b.kind])).toEqual([
      [-12.5 + 17, "own"],
      [-12.5, "jacobs"],
    ]);
    const middle = resolveCar(MODEL, {
      ...CAR,
      role: "middle",
      nose_shape: null,
      bogies: ["jacobs", "jacobs"],
      bogie_pitch_m: null,
    });
    expect(middle.bogies.map((b) => b.x)).toEqual([12.5, -12.5]);
    expect(middle.estimated).not.toContain("bogie_pitch_m");
  });

  it("puts the own bogie of a Jacobs end car 3.1 m from its front when no pitch is sourced", () => {
    const end = resolveCar(MODEL, { ...CAR, bogies: ["own", "jacobs"], bogie_pitch_m: null });
    expect(end.bogies[0].x).toBeCloseTo(12.5 - 3.1, 9);
    expect(end.estimated).toContain("bogie_pitch_m");
  });

  it("gives each pivot the wheelbase of its own kind of bogie", () => {
    const end = resolveCar(MODEL, {
      ...CAR,
      bogies: ["own", "jacobs"],
      bogie_wheelbase_m: 2.3,
      jacobs_wheelbase_m: 2.8,
    });
    expect(end.bogies.map((b) => [b.kind, b.wheelbase, b.estimated])).toEqual([
      ["own", 2.3, false],
      ["jacobs", 2.8, false],
    ]);
    const guessed = resolveCar(MODEL, { ...CAR, bogies: ["own", "jacobs"] });
    expect(guessed.bogies[1].estimated).toBe(true);
    expect(guessed.estimated).toContain("jacobs_wheelbase_m");
  });

  it("spreads a sourced door count between the cab and the rear end", () => {
    const regional = { ...MODEL, category: "sbahn" };
    const spec = resolveCar(regional, { ...CAR, doors_per_side: 3, nose_shape: "blunt" });
    expect(spec.doors).toHaveLength(3);
    const cabStart = 12.5 - (spec.front?.cabLength ?? 0);
    for (const door of spec.doors) expect(door.x + door.width / 2).toBeLessThan(cabStart);
    expect(spec.estimated).toContain("door_positions_m");
  });

  it("takes a measured front instead of the class front", () => {
    const front = {
      source: "commons-photo",
      length_m: 3.0,
      tip_height_m: 1.0,
      bottom_setback_m: 0.4,
      screen_bottom_m: 2.0,
      screen_top_m: 3.2,
      screen_bottom_setback_m: 0.8,
      screen_top_setback_m: 2.2,
      screen_width: 0.8,
      plan: "round" as const,
      estimated: ["plan"],
    };
    const spec = resolveCar(MODEL, { ...CAR, front });
    expect(spec.front?.length).toBe(3);
    expect(spec.nose?.length).toBe(3);
    expect(spec.estimated).toContain("front.plan");
    expect(spec.estimated).not.toContain("front");
    expect(resolveCar(MODEL, CAR).estimated).toContain("front");
  });

  it("gives coaches the unit's skirt line and keeps a front car's own skirt or none", () => {
    const front = {
      source: "commons-photo",
      length_m: 1.2,
      tip_height_m: 1.0,
      bottom_setback_m: 0.05,
      screen_bottom_m: 2.4,
      screen_top_m: 3.7,
      screen_bottom_setback_m: 0.2,
      screen_top_setback_m: 0.6,
      screen_width: 0.8,
      plan: "flat" as const,
    };
    const locomotive = { ...CAR, car_type: "locomotive", role: "locomotive" as const, front };
    const trailer = {
      ...CAR,
      car_type: "driving-trailer",
      role: "driving_trailer" as const,
      front: { ...front, skirt_top_m: 0.95 },
    };
    const coach = { ...CAR, car_type: "middle", role: "coach" as const, nose_shape: null };
    const model = { ...MODEL, car_types: [locomotive, coach, trailer] };
    expect(resolveCar(model, trailer).skirtTop).toBe(0.95);
    expect(resolveCar(model, coach).skirtTop).toBe(0.95);
    expect(resolveCar(model, locomotive).skirtTop).toBeNull();
  });

  it("lists every defaulted value as estimated and no sourced one", () => {
    const spec = resolveCar(MODEL, CAR);
    expect(spec.estimated).toEqual(
      expect.arrayContaining([
        "nose_length_m",
        "door_positions_m",
        "window_sill_m",
        "bogie_wheelbase_m",
      ]),
    );
    for (const field of [
      "length_m",
      "width_m",
      "height_m",
      "bogie_pitch_m",
      "bogie_offset_m",
      "nose_shape",
    ]) {
      expect(spec.estimated).not.toContain(field);
    }
    expect(spec.sources).toEqual(["wikipedia-de-ice-4"]);
  });

  it("draws pantographs only where the source counts them", () => {
    expect(resolveCar(MODEL, CAR).pantographs).toEqual([]);
    const one = resolveCar(MODEL, { ...CAR, pantograph_count: 1 });
    expect(one.pantographs).toHaveLength(1);
    expect(one.estimated).toContain("pantograph_positions_m");
    const placed = resolveCar(MODEL, { ...CAR, pantograph_count: 1, pantograph_positions_m: [4] });
    expect(placed.pantographs).toEqual([4]);
  });

  it("puts the Zg 2 tail lamps on the plain end wall that ends the formation, as an estimate", () => {
    expect(resolveCar(MODEL, CAR).tailLamps).toBeUndefined();
    const coach = { ...CAR, car_type: "coach", role: "coach" as const, nose_shape: null };
    const loco = { ...CAR, car_type: "loco", role: "locomotive" as const };
    const train = {
      ...MODEL,
      formation: [{ car_type: "loco" }, { car_type: "coach" }],
      car_types: [loco, coach],
    };
    const last = resolveCar(train, coach);
    expect(last.tailLamps).toBe("rear");
    expect(last.estimated).toContain("tail_lamps");
    expect(last.sources).toContain("wikipedia-de-zugschlusssignal");
    const turned = {
      ...train,
      formation: [{ car_type: "loco" }, { car_type: "coach", reversed: true }],
    };
    expect(resolveCar(turned, coach).tailLamps).toBe("front");
    expect(resolveCar(train, loco).tailLamps).toBeUndefined();
    const lone = { ...MODEL, formation: [{ car_type: "end" }] };
    expect(resolveCar(lone, CAR).tailLamps).toBe("rear");
    const pushed = { ...train, formation: [{ car_type: "coach" }, { car_type: "loco" }] };
    expect(resolveCar(pushed, loco).tailLamps).toBeUndefined();
  });

  it("gives a locomotive a nose at both ends and no doors", () => {
    const loco = resolveCar(MODEL, { ...CAR, role: "locomotive", nose_shape: "locomotive" });
    expect(loco.noseAtRear).toBe(true);
    expect(loco.doors).toEqual([]);
  });
});

const bogie = (
  x: number,
  kind: "own" | "jacobs",
  wheelbase = 2.5,
  estimated = false,
): BogieSpec => ({
  x,
  kind,
  wheelbase,
  wheelDiameter: 0.85,
  estimated,
});

describe("consistLayout", () => {
  it("lists two pivots per conventional car in order from the front", () => {
    const car = {
      length: 20,
      bogies: [bogie(7, "own"), bogie(-7, "own")] as const,
      reversed: false,
    };
    const layout = consistLayout([car, car]);
    expect(layout.length).toBe(40);
    expect(layout.bogieOffsets).toEqual([3, 17, 23, 37]);
    expect(layout.cars.map((c) => [c.front, c.rear, c.centreFraction])).toEqual([
      [0, 1, 0.5],
      [2, 3, 0.5],
    ]);
  });

  it("shares a Jacobs pivot between neighbours and mirrors a reversed car", () => {
    const end = {
      length: 20,
      bogies: [bogie(7, "own", 2.3), bogie(-10, "jacobs", 2.8)] as const,
    };
    const layout = consistLayout([
      { ...end, reversed: false },
      { ...end, reversed: true },
    ]);
    expect(layout.bogieOffsets).toEqual([3, 20, 37]);
    expect(layout.pivots.map((p) => [p.offset, p.kind, p.bogie])).toEqual([
      [3, "own", "bogie-2300-850"],
      [20, "jacobs", "bogie-2800-850"],
      [37, "own", "bogie-2300-850"],
    ]);
    expect(layout.cars[0]).toMatchObject({ front: 0, rear: 1 });
    expect(layout.cars[1]).toMatchObject({ front: 1, rear: 2 });
    expect(layout.cars[0]?.centreFraction).toBeCloseTo(7 / 17, 6);
  });
});

describe("consist pivots", () => {
  it("give a shared Jacobs pivot the sourced wheelbase of either neighbour", () => {
    const guessed = {
      length: 20,
      bogies: [bogie(7, "own"), bogie(-10, "jacobs", 2.7, true)] as const,
    };
    const sourced = { length: 20, bogies: [bogie(10, "jacobs", 2.8), bogie(-7, "own")] as const };
    const layout = consistLayout([
      { ...guessed, reversed: false },
      { ...sourced, reversed: false },
    ]);
    expect(layout.pivots[1]?.bogie).toBe("bogie-2800-850");
  });
});

describe("palette rows", () => {
  it("uses cited hex values and keeps every other slot neutral", () => {
    const row = liveryRow({
      livery_id: "two-tone",
      name: "Two tone",
      source: "s",
      colours: [
        { role: "upper_body", name: "Ochre", hex: "#AEA04B", source: "s", hex_source: "w" },
        { role: "lower_body", name: "Red", hex: "#9b111e", source: "s", hex_source: "w" },
        { role: "doors", name: "Grey", source: "s" },
      ],
    });
    const neutral = neutralRow();
    expect(row.colours.upper_body).toBe("#aea04b");
    expect(row.colours.window_band).toBe("#aea04b");
    expect(row.colours.stripe).toBe("#9b111e");
    expect(row.colours.body).toBe(neutral.colours.body);
    expect(row.colours.doors).toBe(neutral.colours.doors);
    expect(row.origin.doors).toBe("neutral");
    expect(row.colours.window).toBe(neutral.colours.window);
  });

  it("keeps a colour named without a hex neutral and never uses a category colour", () => {
    const row = liveryRow({
      livery_id: "red",
      name: "Red",
      source: "s",
      colours: [
        { role: "body", name: "Red", hex: "#c1121c", source: "s", hex_source: "w" },
        { role: "stripe", name: "White", source: "s" },
      ],
    });
    expect(row.colours.stripe).toBe(neutralRow().colours.stripe);
    expect(row.colours.doors).toBe("#c1121c");
    const categories = new Set(Object.values(CATEGORY_COLOURS));
    for (const colour of Object.values(neutralRow().colours))
      expect(categories.has(colour)).toBe(false);
  });

  it("paints the helmet in the mask role, the roof and skirt in their roles, the surround dark", () => {
    const basalt = "#4e5754";
    const row = liveryRow({
      livery_id: "helmet",
      name: "Helmet",
      source: "s",
      colours: [
        { role: "body", name: "Red", hex: "#c1121c", source: "s", hex_source: "w" },
        { role: "accent", name: "Grey", hex: "#cbd0cc", source: "s", hex_source: "w" },
        ...(["mask", "roof", "skirt"] as const).map((role) => ({
          role,
          name: "Basaltgrau",
          hex: basalt,
          source: "s",
          hex_source: "w",
        })),
      ],
    });
    expect(row.colours.equipment).toBe(basalt);
    expect(row.colours.roof).toBe(basalt);
    expect(row.colours.skirt).toBe(basalt);
    expect(row.colours.mask).toBe(neutralRow().colours.mask);
    expect(row.origin.mask).toBe("neutral");
    const plain = liveryRow({ livery_id: "plain", name: "Plain", source: "s", colours: [] });
    expect(plain.colours.equipment).toBe(neutralRow().colours.equipment);
  });

  it("puts the model's category colour on the roof band of its own row only", () => {
    const own = modelRow(neutralRow(), "sbahn");
    expect(own.colours.mode).toBe(CATEGORY_COLOURS.sbahn);
    expect(neutralRow().colours.mode).not.toBe(CATEGORY_COLOURS.sbahn);
    expect(own.colours.body).toBe(neutralRow().colours.body);
  });
});
