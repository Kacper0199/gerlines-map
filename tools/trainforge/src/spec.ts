import type { BogieKind, CarRole, CarTypeInput, NoseShape, VehicleInput } from "./catalog.ts";
import type { FrontSpec } from "./geometry/front.ts";
import { classFront, measuredFront, type NoseLevels } from "./geometry/nose.ts";

/**
 * Stylisation defaults: used only where vehicles.yaml has no sourced value, and every use is listed
 * in the car's `estimated` fields (glTF extras and the size report).
 */
interface CategoryStyle {
  readonly width: number;
  readonly height: number;
  readonly floor: number;
  readonly wheel: number;
  readonly wheelbase: number;
  readonly jacobsWheelbase: number;
  readonly doorWidth: number;
  readonly windowWidth: number;
  readonly pillar: number;
}

const STYLE: Readonly<Record<string, CategoryStyle>> = {
  hsr: {
    width: 2.9,
    height: 3.9,
    floor: 1.22,
    wheel: 0.92,
    wheelbase: 2.5,
    jacobsWheelbase: 2.7,
    doorWidth: 0.9,
    windowWidth: 1.5,
    pillar: 0.45,
  },
  ld: {
    width: 2.85,
    height: 4.05,
    floor: 1.2,
    wheel: 0.92,
    wheelbase: 2.5,
    jacobsWheelbase: 2.7,
    doorWidth: 0.8,
    windowWidth: 1.2,
    pillar: 0.55,
  },
  night: {
    width: 2.85,
    height: 4.05,
    floor: 1.2,
    wheel: 0.92,
    wheelbase: 2.5,
    jacobsWheelbase: 2.7,
    doorWidth: 0.8,
    windowWidth: 1.2,
    pillar: 0.55,
  },
  rfast: {
    width: 2.9,
    height: 4.25,
    floor: 0.8,
    wheel: 0.85,
    wheelbase: 2.3,
    jacobsWheelbase: 2.7,
    doorWidth: 1.3,
    windowWidth: 1.7,
    pillar: 0.3,
  },
  reg: {
    width: 2.9,
    height: 4.25,
    floor: 0.8,
    wheel: 0.85,
    wheelbase: 2.3,
    jacobsWheelbase: 2.7,
    doorWidth: 1.3,
    windowWidth: 1.7,
    pillar: 0.3,
  },
  sbahn: {
    width: 3.0,
    height: 4.0,
    floor: 1.0,
    wheel: 0.85,
    wheelbase: 2.2,
    jacobsWheelbase: 2.7,
    doorWidth: 1.3,
    windowWidth: 1.4,
    pillar: 0.35,
  },
  foreign: {
    width: 2.9,
    height: 4.1,
    floor: 1.2,
    wheel: 0.92,
    wheelbase: 2.5,
    jacobsWheelbase: 2.7,
    doorWidth: 0.9,
    windowWidth: 1.4,
    pillar: 0.45,
  },
};

/** Overhang of an end car beyond its own bogie towards the Jacobs joint is length minus this. */
const JACOBS_END_OVERHANG = 3.1;

const NOSE_ROLES: ReadonlySet<CarRole> = new Set([
  "cab",
  "power_head",
  "locomotive",
  "driving_trailer",
  "railcar",
]);

export interface BogieSpec {
  /** Pivot position along the car, metres from the car centre, forward positive. */
  readonly x: number;
  readonly kind: BogieKind;
  readonly wheelbase: number;
  readonly wheelDiameter: number;
  /** The wheelbase is a stylisation default, not a sourced value. */
  readonly estimated: boolean;
}

/** The bogie file a pivot uses: one per wheelbase and wheel diameter. */
export function bogieKey(bogie: Pick<BogieSpec, "wheelbase" | "wheelDiameter">): string {
  return `bogie-${Math.round(bogie.wheelbase * 1000)}-${Math.round(bogie.wheelDiameter * 1000)}`;
}

export interface DoorSpec {
  readonly x: number;
  readonly width: number;
}

export interface CarSpec {
  readonly modelId: string;
  readonly carType: string;
  readonly name: string;
  readonly role: CarRole;
  readonly category: string;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly floor: number;
  readonly doubleDeck: boolean;
  readonly lowerDeckFloor: number;
  readonly bogies: readonly [BogieSpec, BogieSpec];
  readonly wheelDiameter: number;
  /** Nose at the front (+x); locomotives and railcars carry one at both ends. */
  readonly nose: { readonly shape: NoseShape; readonly length: number } | null;
  readonly front: FrontSpec | null;
  readonly noseAtRear: boolean;
  /** The plain end wall that ends the unit's formation carries the Zg 2 tail lamps, when it is this car's. */
  readonly tailLamps?: "front" | "rear";
  /** Stripe band heights measured on this car, or null to follow the window sill. */
  readonly stripe: { readonly bottom: number; readonly top: number } | null;
  /** Top of the livery's skirt band along the lower body, measured on the unit's cab car. */
  readonly skirtTop: number | null;
  readonly doors: readonly DoorSpec[];
  readonly windowSill: number;
  readonly windowTop: number;
  readonly windowWidth: number;
  readonly pillar: number;
  /** Pillars between passenger windows wear the window band, the body or the front mask colour. */
  readonly pillars: "band" | "body" | "mask";
  /** Inset of the side wall top, metres; 0 keeps the wall vertical. */
  readonly tumblehome: number;
  /** Measured underside of the body side along the whole car (skirts over the bogies), replacing the category rule. */
  readonly bodyBottom?: number;
  /** Measured bottom of the side skirt over the bogies, replacing the wheel clearance rule there. */
  readonly bogieSkirt?: number;
  /** Roof shoulder superellipse exponent; null takes the category default. */
  readonly roofExponent: number | null;
  readonly pantographs: readonly number[];
  /** Measured roof equipment as [from, to] spans along the car, forward positive; null draws the class boxes. */
  readonly roofEquipment: readonly (readonly [number, number])[] | null;
  /** Measured side panels (grilles, louvres) as [from, to, bottom, top]: a span along the car, forward positive, and heights. */
  readonly sidePanels: readonly (readonly [number, number, number, number])[] | null;
  readonly estimated: readonly string[];
  readonly sources: readonly string[];
}

function style(category: string): CategoryStyle {
  return STYLE[category] ?? (STYLE.reg as CategoryStyle);
}

function pivotPositions(
  kinds: readonly [BogieKind, BogieKind],
  length: number,
  pitch: number,
  offset: number,
): [number, number] {
  const [front, rear] = kinds;
  const half = length / 2;
  if (front === "jacobs" && rear === "jacobs") return [half, -half];
  if (rear === "jacobs") return [-half + pitch, -half];
  if (front === "jacobs") return [half, half - pitch];
  return [pitch / 2 + offset, -pitch / 2 + offset];
}

const LONG_DISTANCE: ReadonlySet<string> = new Set(["hsr", "ld", "night", "foreign"]);

function defaultDoorCount(role: CarRole, category: string): number {
  if (LONG_DISTANCE.has(category)) return role === "middle" || role === "coach" ? 2 : 1;
  return category === "sbahn" ? 3 : 2;
}

function spreadDoors(from: number, to: number, n: number, longDistance: boolean): number[] {
  if (n === 1) return [(from + to) / 2];
  return Array.from({ length: n }, (_, i) =>
    longDistance ? from + (i * (to - from)) / (n - 1) : from + ((i + 0.5) * (to - from)) / n,
  );
}

/**
 * Door centres when no source places them: long-distance doors at the car ends, regional and
 * S-Bahn doors spread evenly between the cab and the rear end. The count is the sourced one
 * when known.
 */
function defaultDoors(
  role: CarRole,
  category: string,
  length: number,
  cab: number,
  width: number,
  count: number | null | undefined,
): number[] {
  if (role === "locomotive" || role === "power_head") return [];
  const longDistance = LONG_DISTANCE.has(category);
  const n = count ?? defaultDoorCount(role, category);
  if (n <= 0) return [];
  const rear = -length / 2 + 0.9 + width / 2;
  const front = (cab > 0 ? length / 2 - cab - 0.4 : length / 2 - 0.9) - width / 2;
  if (longDistance && n <= 2) return n === 1 ? [rear] : [front, rear];
  const inset = longDistance ? 0 : 0.6;
  return spreadDoors(rear + inset, front - inset, n, longDistance);
}

const ROLE_LENGTH: Readonly<Record<CarRole, number>> = {
  cab: 26,
  middle: 26,
  coach: 26.4,
  driving_trailer: 26.8,
  power_head: 20.5,
  locomotive: 19,
  railcar: 25,
};

/**
 * The length each car without a sourced length gets: an equal share of what the sourced unit
 * length leaves after the sourced cars, or undefined when the unit length is unknown.
 */
export function unitShareLength(model: VehicleInput): number | undefined {
  if (!model.unit_length_m) return undefined;
  const byType = new Map(model.car_types.map((c) => [c.car_type, c.length_m]));
  const lengths = model.formation.map((f) => byType.get(f.car_type));
  const unknown = lengths.filter((l) => l === null || l === undefined).length;
  if (unknown === 0) return undefined;
  const known = lengths.reduce<number>((sum, l) => sum + (l ?? 0), 0);
  const share = (model.unit_length_m - known) / unknown;
  return share > 5 ? share : undefined;
}

/** The same front stretched or squeezed along the car to another length. */
function rescaleFront(front: FrontSpec, length: number): FrontSpec {
  const k = length / front.length;
  return {
    ...front,
    length,
    bottomSetback: front.bottomSetback * k,
    screenBottomSetback: front.screenBottomSetback * k,
    screenTopSetback: front.screenTopSetback * k,
    straight: front.straight * k,
    ...(front.profileByHeight
      ? { profileByHeight: front.profileByHeight.map(([z, s]) => [z, s * k] as const) }
      : {}),
    cabLength: Math.max(length, front.cabLength - front.length + length),
    ...(front.sideProfile
      ? { sideProfile: front.sideProfile.map(([s, z]) => [s * k, z] as const) }
      : {}),
    ...(front.planWidths
      ? { planWidths: front.planWidths.map(([s, w]) => [s * k, w] as const) }
      : {}),
    ...(front.stripeCurve
      ? { stripeCurve: front.stripeCurve.map(([s, b, t]) => [s * k, b, t] as const) }
      : {}),
  };
}

/** Collects the fields that fall back to a stylisation default, in the order they are resolved. */
class Picker {
  readonly estimated: string[] = [];

  pick<T>(field: string, value: T | null | undefined, fallback: () => T): T {
    if (value !== null && value !== undefined) return value;
    this.estimated.push(field);
    return fallback();
  }
}

interface Section {
  readonly width: number;
  readonly height: number;
  readonly floor: number;
  readonly lowerDeckFloor: number;
}

function resolveSection(p: Picker, car: CarTypeInput, s: CategoryStyle): Section {
  const width = p.pick("width_m", car.width_m, () => s.width);
  const height = p.pick("height_m", car.height_m, () => (car.double_deck ? 4.6 : s.height));
  const floor = p.pick("floor_height_m", car.floor_height_m, () => s.floor);
  const lowerDeckFloor = car.double_deck
    ? p.pick("lower_deck_floor_m", car.lower_deck_floor_m, () => 0.6)
    : floor;
  return { width, height, floor, lowerDeckFloor };
}

function resolveWindows(p: Picker, car: CarTypeInput, section: Section) {
  const deckLevel = car.double_deck ? section.lowerDeckFloor + 2.0 : section.floor;
  const sill = p.pick("window_sill_m", car.window_sill_m, () => deckLevel + 0.75);
  const top = p.pick("window_top_m", car.window_top_m, () =>
    Math.min(deckLevel + 1.75, section.height - (car.double_deck ? 0.45 : 0.55)),
  );
  return { sill, top };
}

function resolveFront(
  p: Picker,
  car: CarTypeInput,
  noseShape: NoseShape,
  levels: NoseLevels,
  noseRoom: number,
): FrontSpec {
  let front: FrontSpec;
  if (car.front) {
    front = measuredFront(car.front, levels);
    p.estimated.push(...(car.front.estimated ?? []).map((f) => `front.${f}`));
  } else {
    p.estimated.push("front");
    const byClass = classFront(noseShape, levels);
    if (car.nose_length_m == null) p.estimated.push("nose_length_m");
    front = rescaleFront(byClass, car.nose_length_m ?? byClass.length);
  }
  return front.length > noseRoom ? rescaleFront(front, noseRoom) : front;
}

function resolveRunningGear(
  p: Picker,
  car: CarTypeInput,
  s: CategoryStyle,
  length: number,
  hasNose: boolean,
) {
  const own = car.bogies.includes("own");
  const jacobs = car.bogies.includes("jacobs");
  const pitch = own
    ? p.pick("bogie_pitch_m", car.bogie_pitch_m, () =>
        jacobs ? length - JACOBS_END_OVERHANG : length * 0.69,
      )
    : length;
  const offset =
    car.bogies[0] === "own" && car.bogies[1] === "own" && hasNose
      ? p.pick("bogie_offset_m", car.bogie_offset_m, () => 0)
      : (car.bogie_offset_m ?? 0);
  const wheelDiameter = p.pick("wheel_diameter_m", car.wheel_diameter_m, () => s.wheel);
  const ownWheelbase = own
    ? p.pick("bogie_wheelbase_m", car.bogie_wheelbase_m, () => s.wheelbase)
    : s.wheelbase;
  const jacobsWheelbase = jacobs
    ? p.pick("jacobs_wheelbase_m", car.jacobs_wheelbase_m, () => s.jacobsWheelbase)
    : s.jacobsWheelbase;
  const bogies = pivotPositions(car.bogies, length, pitch, offset).map((x, i) => {
    const kind = car.bogies[i] as BogieKind;
    const sourced = kind === "jacobs" ? car.jacobs_wheelbase_m : car.bogie_wheelbase_m;
    return {
      x,
      kind,
      wheelbase: kind === "jacobs" ? jacobsWheelbase : ownWheelbase,
      wheelDiameter,
      estimated: sourced == null,
    };
  }) as unknown as readonly [BogieSpec, BogieSpec];
  return { bogies, wheelDiameter };
}

function resolvePantographs(p: Picker, car: CarTypeInput, length: number): number[] {
  const count = p.pick("pantograph_count", car.pantograph_count, () =>
    car.role === "locomotive" || car.role === "power_head" ? 2 : 0,
  );
  if (!count) return [];
  return [
    ...p.pick("pantograph_positions_m", car.pantograph_positions_m, () =>
      [length / 2 - 6, -(length / 2 - 6)].slice(0, count),
    ),
  ];
}

function measuredStripe(car: CarTypeInput): CarSpec["stripe"] {
  const bottom = car.front?.stripe_bottom_m;
  const top = car.front?.stripe_top_m;
  return bottom != null && top != null ? { bottom, top } : null;
}

function unitSkirtTop(model: VehicleInput, car: CarTypeInput): number | null {
  if (car.front) return car.front.skirt_top_m ?? null;
  return model.car_types.find((c) => c.front?.skirt_top_m != null)?.front?.skirt_top_m ?? null;
}

/** Measured roof equipment and side panels of a car type, null where the catalogue gives none. */
function measuredExtras(car: CarTypeInput) {
  return { roofEquipment: car.roof_equipment_m ?? null, sidePanels: car.side_panels_m ?? null };
}

/** Source of the rule that the last vehicle shows two red lights low at its end (Zg 2). */
const ZG2_SOURCE = "wikipedia-de-zugschlusssignal";

/** The end of this car type that ends the formation with a plain end wall (no cab), if any. */
function plainTrailingEnd(model: VehicleInput, car: CarTypeInput, cabs: boolean) {
  const last = model.formation[model.formation.length - 1];
  if (last?.car_type !== car.car_type) return undefined;
  if (last.reversed) return NOSE_ROLES.has(car.role) ? undefined : "front";
  return cabs ? undefined : "rear";
}

function carSources(model: VehicleInput, car: CarTypeInput, tailLamps: boolean): string[] {
  const views = car.front ? [car.front.source, car.front.view_source ?? car.front.source] : [];
  const fields = Object.values(car.field_sources ?? {});
  const rule = tailLamps ? [ZG2_SOURCE] : [];
  return [...new Set([model.source, car.source, ...fields, ...views, ...rule])].sort();
}

/** Fills every value of a car type: sourced values first, stylisation defaults for the rest. */
export function resolveCar(model: VehicleInput, car: CarTypeInput): CarSpec {
  const s = style(model.category);
  const p = new Picker();
  const length = p.pick(
    "length_m",
    car.length_m,
    () => unitShareLength(model) ?? ROLE_LENGTH[car.role],
  );
  const section = resolveSection(p, car, s);
  const hasNose = NOSE_ROLES.has(car.role);
  const noseShape = hasNose
    ? p.pick("nose_shape", car.nose_shape, () => "rounded" as NoseShape)
    : null;
  const twoNoses = car.role === "locomotive" || car.role === "railcar";
  const windows = resolveWindows(p, car, section);
  const levels = {
    floor: section.floor,
    sill: windows.sill,
    top: windows.top,
    height: section.height,
  };
  const front = noseShape
    ? resolveFront(p, car, noseShape, levels, twoNoses ? length / 2 - 1.5 : length - 3)
    : null;
  const gear = resolveRunningGear(p, car, s, length, hasNose);
  const doorWidth = p.pick("door_width_m", car.door_width_m, () => s.doorWidth);
  const doorXs = p.pick("door_positions_m", car.door_positions_m, () =>
    defaultDoors(
      car.role,
      model.category,
      length,
      front?.cabLength ?? 0,
      doorWidth,
      car.doors_per_side,
    ),
  );
  const pantographs = resolvePantographs(p, car, length);
  const windowWidth = p.pick("window_width_m", car.window_width_m, () => s.windowWidth);
  const pillar = p.pick("window_pillar_m", car.window_pillar_m, () => s.pillar);
  const tumblehome = car.tumblehome_m ?? 0;
  const roofExponent = car.roof_exponent ?? null;
  const tailLamps = plainTrailingEnd(model, car, twoNoses);
  if (tailLamps) p.estimated.push("tail_lamps");
  const sources = carSources(model, car, tailLamps !== undefined);
  return {
    modelId: model.model_id,
    tumblehome,
    ...(car.body_bottom_m != null ? { bodyBottom: car.body_bottom_m } : {}),
    ...(car.bogie_skirt_m != null ? { bogieSkirt: car.bogie_skirt_m } : {}),
    roofExponent,
    carType: car.car_type,
    name: car.name,
    role: car.role,
    category: model.category,
    length,
    width: section.width,
    height: section.height,
    floor: section.floor,
    doubleDeck: car.double_deck,
    lowerDeckFloor: section.lowerDeckFloor,
    bogies: gear.bogies,
    wheelDiameter: gear.wheelDiameter,
    nose: noseShape ? { shape: noseShape, length: front?.length ?? 0 } : null,
    front,
    noseAtRear: twoNoses,
    ...(tailLamps ? { tailLamps } : {}),
    stripe: measuredStripe(car),
    skirtTop: unitSkirtTop(model, car),
    doors: [...doorXs].sort((a, b) => b - a).map((x) => ({ x, width: doorWidth })),
    windowSill: windows.sill,
    windowTop: windows.top,
    windowWidth,
    pillar,
    pillars: car.window_pillars ?? "band",
    pantographs,
    ...measuredExtras(car),
    estimated: p.estimated,
    sources,
  };
}
