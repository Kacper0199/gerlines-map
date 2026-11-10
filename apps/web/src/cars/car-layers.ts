import type { Layer } from "@deck.gl/core";
import { liveKeyOf } from "../live/train-ids.ts";
import { TRAIN_ANCHOR_LAYER_ID } from "../map/style/build-style.ts";
import { type CarFrame, markerFade } from "./car-instances.ts";
import { CarOutlineExtension, CarPaintExtension } from "./car-paint.ts";
import { type CarCatalog, parseCatalog } from "./catalog.ts";
import { type Fleet, fleetIndexAttribute, fleetOf } from "./fleet.ts";
import { type DeckMesh, type FleetDraw, fleetLayer } from "./fleet-layer.ts";
import { type CarMesh, type MeshoptDecode, readCarMesh } from "./glb.ts";
import { warnCars } from "./warn.ts";

export const TRAIN_MODELS_URL = "/trains/";
export const CAR_LAYER_PREFIX = "cars-";
export const CAR_OUTLINE_PREFIX = "car-outline-";
/** Width of the dark casing under a car on satellite imagery, as a multiple of the car's width. */
export const OUTLINE_WIDTH_SCALE = 1.9;

const widened = new WeakMap<Float32Array, Float32Array>();

const CAR_PARAMETERS = {
  cullMode: "none",
  depthWriteEnabled: true,
  depthCompare: "less-equal",
} as const;
const OUTLINE_PARAMETERS = {
  cullMode: "none",
  depthWriteEnabled: false,
  depthCompare: "always",
} as const;
const PALETTE_SAMPLING = {
  minFilter: "nearest",
  magFilter: "nearest",
  mipmapFilter: "none",
} as const;

type InstanceValues = Float32Array | Uint8Array;

interface BinaryAttribute {
  readonly value: InstanceValues;
  readonly size: number;
  readonly normalized?: boolean;
}

/** The worker's statics version together with its epoch, or undefined for a fleet merged on the page. */
function staticsStamp(fleet: Fleet): string | undefined {
  return fleet.staticsVersion === undefined
    ? undefined
    : `${fleet.staticsEpoch ?? 0}:${fleet.staticsVersion}`;
}

function sameValues(a: InstanceValues, b: InstanceValues): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The per-instance attributes that hardly ever change from one frame to the next (colour band, livery
 * row, lamps, selection), kept per layer. A frame whose values equal the last one's gets the very same
 * attribute object back, which deck.gl takes as "unchanged" and neither re-binds nor re-uploads; only
 * positions and orientations then travel to the GPU every frame.
 */
export class StaticAttributes {
  private readonly last = new Map<
    string,
    { attribute: BinaryAttribute; version?: number | string }
  >();
  private used = new Set<string>();

  /** Starts a layer list: attributes of layers that are not asked for again are forgotten at `end`. */
  begin(): void {
    this.used = new Set();
  }

  /** With a `version` (the worker's statics version) the values are not compared: the same version is the same values. */
  attribute(
    layerId: string,
    name: string,
    value: InstanceValues,
    size: number,
    normalized = false,
    version?: number | string,
  ): BinaryAttribute {
    const id = `${layerId}/${name}`;
    this.used.add(id);
    const known = this.last.get(id);
    if (known) {
      const same =
        version === undefined
          ? known.version === undefined && sameValues(known.attribute.value, value)
          : known.version === version;
      if (same) return known.attribute;
    }
    const attribute: BinaryAttribute = normalized ? { value, size, normalized } : { value, size };
    this.last.set(id, version === undefined ? { attribute } : { attribute, version });
    return attribute;
  }

  end(): void {
    for (const id of this.last.keys()) if (!this.used.has(id)) this.last.delete(id);
  }
}

/**
 * Instance matrices with the across-the-car axis (column 1 of each 12-float block) stretched. The
 * result is cached per input array, so a render that carries the same frame hands deck the same
 * attribute and nothing is copied or uploaded again.
 */
export function widenMatrices(matrices: Float32Array, scale: number): Float32Array {
  const known = widened.get(matrices);
  if (known) return known;
  const out = Float32Array.from(matrices);
  for (let at = 0; at + 12 <= out.length; at += 12) {
    out[at + 3] = (out[at + 3] as number) * scale;
    out[at + 4] = (out[at + 4] as number) * scale;
    out[at + 5] = (out[at + 5] as number) * scale;
  }
  widened.set(matrices, out);
  return out;
}

function deckMesh(mesh: CarMesh): DeckMesh {
  return {
    attributes: {
      positions: { value: mesh.positions, size: 3 },
      normals: { value: mesh.normals, size: 3 },
      texCoords: { value: mesh.texCoords, size: 2 },
    },
    indices: { value: mesh.indices, size: 1 },
  };
}

/**
 * The forge's models on the page: the manifest, the palette atlas and every mesh at a level of
 * detail once a frame asks for it. `changed` runs when a mesh arrives so the map redraws.
 */
export class CarModels {
  catalog: CarCatalog | undefined;
  private palette: ImageBitmap | undefined;
  private extension: CarPaintExtension | undefined;
  private readonly outline = new CarOutlineExtension();
  private readonly statics = new StaticAttributes();
  private readonly meshes = new Map<string, DeckMesh | null>();
  private readonly failures = new Map<string, { attempts: number; retryAt: number }>();
  private readyIds: string[] = [];
  private decode: MeshoptDecode | undefined;
  private readonly base: string;
  private readonly changed: () => void;

  constructor(changed: () => void, base = TRAIN_MODELS_URL) {
    this.changed = changed;
    this.base = base;
  }

  /** Loads the manifest, palette and decoder; returns the manifest for the worker. */
  async load(): Promise<unknown> {
    const [manifest, palette, decoder] = await Promise.all([
      fetch(`${this.base}manifest.json`).then((response) => {
        if (!response.ok) throw new Error(`train manifest ${response.status}`);
        return response.json() as Promise<unknown>;
      }),
      fetch(`${this.base}palette.png`)
        .then((response) => response.blob())
        .then((blob) => createImageBitmap(blob, { premultiplyAlpha: "none" })),
      import("meshoptimizer/decoder").then(async ({ MeshoptDecoder }) => {
        await MeshoptDecoder.ready;
        return MeshoptDecoder;
      }),
    ]);
    this.catalog = parseCatalog(manifest);
    this.palette = palette;
    this.decode = decoder.decodeGltfBuffer;
    this.extension = new CarPaintExtension(this.catalog.palette);
    this.changed();
    return manifest;
  }

  /** Meshes loaded so far, as `mesh@lod` (the worker keeps a train's chevron until all of its are). */
  ready(): readonly string[] {
    return this.readyIds;
  }

  /** The mesh of a level of detail, or undefined while it loads (the load starts here). */
  mesh(key: string, lod: number): DeckMesh | undefined {
    const id = `${key}@${lod}`;
    const known = this.meshes.get(id);
    if (known) return known;
    if (known === null) return undefined;
    const failure = this.failures.get(id);
    if (failure && performance.now() < failure.retryAt) return undefined;
    const file = this.catalog?.meshes.get(key)?.files[lod];
    if (!file) return undefined;
    this.meshes.set(id, null);
    void fetch(`${this.base}${file}`)
      .then((response) => {
        if (!response.ok) throw new Error(`${file} ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => {
        this.meshes.set(id, deckMesh(readCarMesh(data, this.decode)));
        this.failures.delete(id);
        this.readyIds = [...this.readyIds, id];
        this.changed();
      })
      .catch((error: unknown) => {
        this.meshes.delete(id);
        const attempts = (this.failures.get(id)?.attempts ?? 0) + 1;
        warnCars(`${file} failed to load (attempt ${attempts})`, error);
        this.failures.set(id, { attempts, retryAt: performance.now() + retryDelayMs(attempts) });
      });
    return undefined;
  }

  layers(frame: CarFrame | undefined, { outline = false } = {}): Layer[] {
    if (!(frame && frame.fade > 0 && this.palette && this.extension)) return [];
    for (const id of frame.wanted) {
      const at = id.lastIndexOf("@");
      this.mesh(id.slice(0, at), Number(id.slice(at + 1)));
    }
    return carLayerList(
      frame,
      {
        mesh: (key, lod) => this.mesh(key, lod),
        palette: this.palette,
        extension: this.extension,
        outlineExtension: this.outline,
        statics: this.statics,
      },
      outline,
    );
  }
}

interface LayerParts {
  readonly mesh: (key: string, lod: number) => DeckMesh | undefined;
  readonly palette: ImageBitmap;
  readonly extension: CarPaintExtension;
  readonly outlineExtension: CarOutlineExtension;
  readonly statics: StaticAttributes;
}

function draws(fleet: Fleet, parts: LayerParts): FleetDraw[] {
  const loaded: FleetDraw[] = [];
  for (const range of fleet.ranges) {
    const mesh = parts.mesh(range.mesh, range.lod);
    if (mesh)
      loaded.push({
        id: `${range.mesh}@${range.lod}`,
        mesh,
        start: range.start,
        count: range.count,
      });
  }
  return loaded;
}

function outlineLayer(
  fleet: Fleet,
  fleetDraws: FleetDraw[],
  fade: number,
  parts: LayerParts,
): Layer {
  const id = `${CAR_OUTLINE_PREFIX}fleet`;
  return fleetLayer({
    id,
    data: {
      length: fleet.count,
      attributes: {
        getPosition: { value: fleet.positions, size: 3 },
        instanceModelMatrix: {
          value: widenMatrices(fleet.matrices, OUTLINE_WIDTH_SCALE),
          size: 12,
        },
        getColor: parts.statics.attribute(id, "color", fleet.colors, 4, true, fleet.staticsVersion),
      },
    } as never,
    fleet: fleetDraws,
    extensions: [parts.outlineExtension],
    opacity: fade,
    pickable: false,
    parameters: OUTLINE_PARAMETERS,
    beforeId: TRAIN_ANCHOR_LAYER_ID,
  });
}

function carLayer(fleet: Fleet, fleetDraws: FleetDraw[], fade: number, parts: LayerParts): Layer {
  const id = `${CAR_LAYER_PREFIX}fleet`;
  const { statics } = parts;
  const version = staticsStamp(fleet);
  return fleetLayer({
    id,
    data: {
      length: fleet.count,
      attributes: {
        getPosition: { value: fleet.positions, size: 3 },
        instanceModelMatrix: { value: fleet.matrices, size: 12 },
        getColor: statics.attribute(id, "color", fleet.colors, 4, true, version),
        getLiveryRow: statics.attribute(id, "livery", fleet.liveryRows, 1, false, version),
        getLamps: statics.attribute(id, "lamps", fleet.lamps, 2, false, version),
        getSelected: statics.attribute(id, "selected", fleet.selected, 1, false, version),
        getFleetIndex: fleetIndexAttribute(fleet.count),
      },
    } as never,
    fleet: fleetDraws,
    texture: parts.palette as never,
    textureParameters: PALETTE_SAMPLING,
    extensions: [parts.extension],
    opacity: fade,
    pickable: true,
    parameters: CAR_PARAMETERS,
    beforeId: TRAIN_ANCHOR_LAYER_ID,
  });
}

/**
 * The deck layers of a car frame: one layer holds every car of every mesh. With `outline` a second
 * layer with the casings comes first, so a casing (drawn over whatever is below it) can never cover
 * a car.
 */
export function carLayerList(frame: CarFrame, parts: LayerParts, outline = false): Layer[] {
  const fleet = fleetOf(frame);
  const fleetDraws = draws(fleet, parts);
  const layers: Layer[] = [];
  parts.statics.begin();
  if (fleetDraws.length > 0) {
    if (outline) layers.push(outlineLayer(fleet, fleetDraws, frame.fade, parts));
    layers.push(carLayer(fleet, fleetDraws, frame.fade, parts));
  }
  parts.statics.end();
  return layers;
}

/** Wait before retrying a failed model file: 1 s doubling to at most 60 s. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
}

/** The train key of a picked car instance (its index within the whole fleet). */
export function pickedCarKey(
  frame: CarFrame | undefined,
  layerId: string,
  index: number,
): number | undefined {
  if (!(frame && layerId.startsWith(CAR_LAYER_PREFIX) && index >= 0)) return undefined;
  return fleetOf(frame).trainKeys[index];
}

/**
 * Opacity the selected train's chevron marker gives way by: nothing until its cars are wide enough to
 * see (R-14), then the marker fades; 0 for a train that is not drawn as cars, so it keeps its marker.
 * `cover` (0 to 1) is how far the relief buries the cars, as inside a tunnel: the marker stays in
 * step with it, because the cars are depth tested and a buried train must not vanish.
 */
export function selectedMarkerFade(
  frame: CarFrame | undefined,
  selectedId: string,
  zoom: number,
  latDeg: number,
  cover = 0,
): number {
  const key = liveKeyOf(selectedId);
  if (!(frame && key !== null && frame.drawnKeys.includes(key))) return 0;
  return markerFade(zoom, latDeg) * (1 - cover);
}
