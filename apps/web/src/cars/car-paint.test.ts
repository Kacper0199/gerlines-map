import { existsSync, readFileSync } from "node:fs";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { describe, expect, it } from "vitest";
import { COMBINED_TAIL_BELOW, carPaintShaders, SELECTED_DEPTH_BIAS } from "./car-paint.ts";
import { parseCatalog } from "./catalog.ts";
import { readCarMesh } from "./glb.ts";

const PALETTE = {
  file: "palette.png",
  columns: 32,
  rows: 2,
  modeColumn: 14,
  lightColumn: 12,
  tailColumn: 22,
  logoColumns: [23, 24],
  logoRows: [false, true],
};

describe("carPaintShaders", () => {
  const shaders = carPaintShaders(PALETTE);

  it("writes only the selected train's band after the lighting, the others are shaded like paint", () => {
    expect(shaders["fs:DECKGL_FILTER_COLOR"]).toContain("carBand = vCarSelected");
    expect(shaders["fs:#main-end"]).toContain("fragColor.rgb = vCarMode.rgb");
    expect(shaders["fs:#main-end"]).toContain("picking.isActive < 0.5");
    expect(shaders["fs:#main-end"]).toContain("carBand > 0.5");
    expect(shaders["fs:DECKGL_FILTER_COLOR"]).not.toContain("carBand = 1.0");
  });

  it("pulls only the selected train's cars towards the camera, and away from it while picking, so a train overlapping it on the same track never wins the depth test", () => {
    const main = shaders["vs:#main-end"] as string;
    expect(SELECTED_DEPTH_BIAS).toBeGreaterThanOrEqual(1e-6);
    expect(SELECTED_DEPTH_BIAS).toBeLessThanOrEqual(1e-4);
    expect(main).toContain(
      `if (instanceSelected > 0.5) gl_Position.z += (picking.isActive > 0.5 ? 1.0 : -1.0) * ${SELECTED_DEPTH_BIAS} * gl_Position.w;`,
    );
    expect(main.indexOf("gl_Position.z +=")).toBeLessThan(
      main.indexOf("gl_Position = vec4(0.0, 0.0, 2.0, 1.0)"),
    );
  });

  it("passes the lamp state and mode colour flat, so a triangle never mixes two ends", () => {
    expect(shaders["vs:#decl"]).toContain("flat out float vCarLamp");
    expect(shaders["vs:#decl"]).toContain("flat out vec4 vCarMode");
    expect(shaders["vs:#decl"]).toContain("flat out float vCarSelected");
    expect(shaders["fs:#decl"]).toContain("flat in float vCarLamp");
    expect(shaders["fs:#decl"]).toContain("flat in vec4 vCarMode");
  });

  it("looks up the livery row and the three special columns of the palette", () => {
    expect(shaders["vs:#main-end"]).toContain("/ 2.0");
    expect(shaders["fs:DECKGL_FILTER_COLOR"]).toContain("column == 14.0");
    expect(shaders["fs:DECKGL_FILTER_COLOR"]).toContain("column == 12.0");
    expect(shaders["fs:DECKGL_FILTER_COLOR"]).toContain("column == 22.0");
  });

  it("culls the logo triangles in the vertex shader for a row without a logo, never in the fragment shader", () => {
    const decl = shaders["vs:#decl"] as string;
    const end = shaders["vs:#main-end"] as string;
    expect(decl).toContain("const float LOGO_SHOWN[2] = float[2](0.0, 1.0);");
    expect(end).toContain("float logoCell = floor(texCoords.x * 32.0);");
    expect(end).toContain("logoCell == 23.0 || logoCell == 24.0");
    expect(end).toContain("LOGO_SHOWN[int(instanceLiveryRows + 0.5)] < 0.5");
    expect(end).toContain("gl_Position = vec4(0.0, 0.0, 2.0, 1.0)");
    expect(end.indexOf("instanceLiveryRows + 0.5) /")).toBeGreaterThan(-1);
    for (const stage of ["fs:DECKGL_FILTER_COLOR", "fs:#main-end", "fs:#decl"]) {
      expect(shaders[stage]).not.toContain("discard");
    }
  });

  it("carries one flag per palette row, the rows the manifest lists, whatever the row count", () => {
    const flags = (rows: boolean[]) => {
      const decl = carPaintShaders({ ...PALETTE, rows: rows.length, logoRows: rows })["vs:#decl"];
      const list = /float\[\d+\]\(([^)]*)\)/.exec(decl as string)?.[1] ?? "";
      return list.split(", ").map((value) => value === "1.0");
    };
    const rows = [false, true, true, false, false, true, true, true, false, true];
    expect(flags(rows)).toEqual(rows);
    expect(flags([false])).toEqual([false]);
  });

  it("adds no logo code when every row shows the logo or the palette has no logo columns", () => {
    for (const palette of [
      { ...PALETTE, logoRows: [true, true] },
      { ...PALETTE, logoColumns: [] },
    ]) {
      const plain = carPaintShaders(palette);
      expect(plain["vs:#decl"]).not.toContain("LOGO_SHOWN");
      expect(plain["vs:#main-end"]).not.toContain("gl_Position = ");
    }
  });

  it("lights a combined lamp's white lens red at the trailing end and leaves plain lenses unlit white", () => {
    const filter = shaders["fs:DECKGL_FILTER_COLOR"] as string;
    const light = filter.slice(filter.indexOf("column == 12.0"), filter.indexOf("column == 22.0"));
    expect(light).toContain(`fract(geometry.uv.x * 32.0) < ${COMBINED_TAIL_BELOW}`);
    expect(light).toContain("combined ? vec3(1.7, 0.1, 0.06) : color.rgb * 0.42");
    expect(light.indexOf("vCarLamp == 1.0")).toBeLessThan(light.indexOf("combined ?"));
  });
});

const forge = new URL("../../../../tools/trainforge/dist/", import.meta.url);
const forgeFile = (path: string) => new URL(path, forge);

describe.skipIf(!existsSync(forgeFile("manifest.json")))("lamp columns of the forge build", () => {
  const build = () => {
    const manifest = JSON.parse(readFileSync(forgeFile("manifest.json"), "utf8")) as {
      palette: { slots: string[] };
    };
    return { slots: manifest.palette.slots, palette: parseCatalog(manifest).palette };
  };
  const lensFractions = async (path: string, slot: string) => {
    await MeshoptDecoder.ready;
    const bytes = readFileSync(forgeFile(path));
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const mesh = readCarMesh(data, MeshoptDecoder.decodeGltfBuffer);
    const { slots, palette } = build();
    const column = slots.indexOf(slot);
    const out: number[] = [];
    for (let i = 0; i < mesh.texCoords.length; i += 2) {
      const cell = (mesh.texCoords[i] as number) * palette.columns;
      if (Math.floor(cell) === column) out.push(cell - column);
    }
    return out;
  };

  it("tells a combined lamp (ICE 3, ICE 3neo, ICE T) from a plain one by the lens position in its cell", async () => {
    for (const path of [
      "models/db-403/end.lod0.glb",
      "models/db-408/end.lod0.glb",
      "models/db-411/end.lod0.glb",
    ]) {
      const combined = (await lensFractions(path, "light")).filter((f) => f < COMBINED_TAIL_BELOW);
      expect(combined.length, path).toBeGreaterThan(0);
      for (const f of combined) expect(f).toBeGreaterThan(0.2);
    }
    const plain = await lensFractions("models/db-402/power-car.lod0.glb", "light");
    expect(plain.length).toBeGreaterThan(0);
    for (const f of plain) expect(f).toBeGreaterThan(COMBINED_TAIL_BELOW);
  });

  it("keeps the DB logo field out of every column the paint lights", async () => {
    const { slots, palette } = build();
    const logo = slots.indexOf("logo");
    expect(logo).toBeGreaterThan(0);
    expect([palette.modeColumn, palette.lightColumn, palette.tailColumn]).not.toContain(logo);
    expect(carPaintShaders(palette)["fs:DECKGL_FILTER_COLOR"]).not.toContain(`column == ${logo}.0`);
    expect((await lensFractions("models/db-642/end.lod0.glb", "logo")).length).toBeGreaterThan(0);
  });
});
