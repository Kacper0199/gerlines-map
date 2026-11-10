import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import { GeoFiles } from "./geo-base.ts";
import { type LookMap, type LookState, lookStyle, MapLook } from "./map-look.ts";
import { nameText } from "./style/layer-kit.ts";

const ORIGIN = "http://host";
const STATE: LookState = {
  style: "dark",
  labelLanguage: "en",
  focus: null,
  terrain3d: false,
  buildings: false,
};
const laender = JSON.parse(
  readFileSync(join(process.cwd(), "public/geo/laender.geojson"), "utf8"),
) as unknown;

function servedFiles() {
  const fetchJson = vi.fn(async (url: string) =>
    url.endsWith("/laender.geojson")
      ? laender
      : { type: "FeatureCollection", features: [], name: url.split("/geo/")[1] },
  );
  return { files: new GeoFiles(ORIGIN, fetchJson), fetchJson };
}

function fakeMap(failing: readonly string[] = []) {
  const handlers = new Map<string, Array<() => void>>();
  const map = {
    on: vi.fn((type: string, handler: () => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    }),
    once: vi.fn((type: string, handler: () => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    }),
    setStyle: vi.fn(),
    getLayer: vi.fn(() => ({})),
    setLayoutProperty: vi.fn((id: string) => {
      if (failing.includes(id)) {
        throw new Error(`cannot relabel ${id}`);
      }
    }),
  };
  const fire = (type: string) => {
    const list = handlers.get(type) ?? [];
    handlers.set(type, []);
    for (const handler of list) {
      handler();
    }
  };
  return { map, fire, asLookMap: map as unknown as LookMap };
}

function sourceData(spec: StyleSpecification, id: string): unknown {
  return (spec.sources[id] as { data?: unknown }).data;
}

describe("MapLook", () => {
  it("changes the label language without reloading the style", () => {
    const { files } = servedFiles();
    const fake = fakeMap();
    const look = new MapLook(fake.asLookMap, STATE, ORIGIN, files, lookStyle(STATE, ORIGIN));

    look.update({ labelLanguage: "pl" });

    expect(fake.map.setStyle).not.toHaveBeenCalled();
    expect(fake.map.setLayoutProperty).toHaveBeenCalledWith(
      "place_city",
      "text-field",
      nameText("pl"),
    );
  });

  it("keeps relabelling after a layer fails and retries once the map is idle", () => {
    const { files } = servedFiles();
    const fake = fakeMap(["water_name"]);
    const look = new MapLook(fake.asLookMap, STATE, ORIGIN, files, lookStyle(STATE, ORIGIN));

    look.update({ labelLanguage: "de" });

    const relabelled = fake.map.setLayoutProperty.mock.calls.map(([id]) => id);
    expect(relabelled.indexOf("water_name")).toBeLessThan(relabelled.indexOf("place_city"));
    expect(fake.map.once).toHaveBeenCalledWith("idle", expect.any(Function));
    fake.map.setLayoutProperty.mockClear();
    fake.fire("idle");
    expect(fake.map.setLayoutProperty).toHaveBeenCalledWith(
      "place_city",
      "text-field",
      nameText("de"),
    );
  });

  it("passes the geo files as data once they are loaded, and fetches them only once", async () => {
    const { files, fetchJson } = servedFiles();
    const fake = fakeMap();
    const look = new MapLook(fake.asLookMap, STATE, ORIGIN, files, lookStyle(STATE, ORIGIN));

    const facts = await look.laender();
    look.update({ style: "light" });
    look.update({ style: "satellite" });

    expect(facts).toHaveLength(16);
    const last = fake.map.setStyle.mock.calls.at(-1)?.[0] as StyleSpecification;
    expect(sourceData(last, "mask")).toBe(files.data.mask);
    expect(sourceData(last, "outline")).toBe(files.data.outline);
    expect(sourceData(last, "neighbours")).toBe(files.data.neighbours);
    expect(fetchJson).toHaveBeenCalledTimes(4);
  });

  it("applies a Land focus only once its mask is held, so no unmasked frame shows", async () => {
    const { files } = servedFiles();
    const fake = fakeMap();
    const look = new MapLook(fake.asLookMap, STATE, ORIGIN, files, lookStyle(STATE, ORIGIN));
    await look.laender();
    fake.map.setStyle.mockClear();

    look.update({ focus: "DE-BY" });
    expect(fake.map.setStyle).not.toHaveBeenCalled();
    await files.landMask("DE-BY");
    await Promise.resolve();

    const spec = fake.map.setStyle.mock.calls.at(-1)?.[0] as StyleSpecification;
    expect(sourceData(spec, "mask")).toBe(files.data.landMasks?.["DE-BY"]);
  });

  it("touches the map no more once disposed", async () => {
    const { files } = servedFiles();
    const fake = fakeMap();
    const look = new MapLook(fake.asLookMap, STATE, ORIGIN, files, lookStyle(STATE, ORIGIN));
    const loading = look.laender();
    look.dispose();
    await loading;

    expect(fake.map.setStyle).not.toHaveBeenCalled();
  });
});
