import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { LiveryInput } from "../src/catalog.ts";
import type { FrontDecal } from "../src/geometry/front.ts";
import { logoParts } from "../src/geometry/panes.ts";
import {
  ATLAS_COLUMNS,
  atlasPng,
  liveryRow,
  logoRows,
  neutralRow,
  SLOTS,
  slotU,
} from "../src/palette.ts";

const livery: LiveryInput = {
  livery_id: "example",
  name: "Example",
  operator_id: "db-regio-ag",
  source: "s",
  colours: [
    { role: "body", name: "Rot", hex: "#c1121c", source: "s", hex_source: "s" },
    { role: "doors", name: "Grau", hex: "#cbd0cc", source: "s", hex_source: "s" },
  ],
};

function alphaOf(png: Uint8Array, row: number, slot: (typeof SLOTS)[number]): number {
  const view = new DataView(png.buffer, png.byteOffset);
  let offset = 8;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ATLAS_COLUMNS * 4 + 1;
  return raw[row * stride + 1 + SLOTS.indexOf(slot) * 4 + 3] as number;
}

describe("the logo columns", () => {
  it("has a column for the plate's letters and border next to the field's, inside the atlas", () => {
    expect(SLOTS.indexOf("logo_ink")).toBeGreaterThan(SLOTS.indexOf("logo"));
    expect(SLOTS.indexOf("logo_ink")).toBeLessThan(ATLAS_COLUMNS);
    expect(slotU("logo_ink")).not.toBe(slotU("logo"));
  });

  it("is visible in a livery of a DB operator, inked like its doors", () => {
    const row = liveryRow(livery, true);
    expect(row.hidden).toEqual([]);
    expect(row.colours.logo_ink).toBe("#cbd0cc");
    const png = atlasPng([row]);
    expect(alphaOf(png, 0, "logo")).toBe(255);
    expect(alphaOf(png, 0, "logo_ink")).toBe(255);
  });

  it("is transparent in the neutral row and in the livery of any other operator", () => {
    expect(neutralRow().hidden).toEqual(["logo", "logo_ink"]);
    const other = liveryRow({ ...livery, operator_id: "hlb" }, false);
    const png = atlasPng([neutralRow(), other]);
    for (const row of [0, 1]) {
      expect(alphaOf(png, row, "logo")).toBe(0);
      expect(alphaOf(png, row, "logo_ink")).toBe(0);
      expect(alphaOf(png, row, "body")).toBe(255);
    }
  });

  it("lists the rows that show the logo, the same rows whose atlas cells are opaque", () => {
    const rows = [
      neutralRow(),
      liveryRow(livery, true),
      liveryRow({ ...livery, operator_id: "hlb" }, false),
      liveryRow({ ...livery, livery_id: "second" }, true),
    ];
    const png = atlasPng(rows);
    expect(logoRows(rows)).toEqual([1, 3]);
    expect(logoRows(rows)).toEqual(
      rows.flatMap((_, r) => (alphaOf(png, r, "logo") === 255 ? [r] : [])),
    );
  });

  it("paints the letters and border of a plate in the ink column and the field in the logo column", () => {
    const flat = (u: number, z: number) => ({
      point: [0, u * 1.4, z] as const,
      normal: [1, 0, 0] as const,
    });
    const plate: FrontDecal = {
      slot: "doors",
      bottom: 1.5,
      top: 1.8,
      inner: 0,
      outer: 0.15,
      round: 6,
      slant: 0,
      logo: true,
    };
    const slots = logoParts(plate, flat).map((p) => p.slot);
    expect(slots).toEqual(["logo_ink", "logo", "logo_ink", "logo", "logo_ink", "logo", "logo"]);
    const red = logoParts({ ...plate, slot: "lower_body", redLetters: true }, flat).map(
      (p) => p.slot,
    );
    expect(red).toEqual([
      "logo",
      "lower_body",
      "logo",
      "lower_body",
      "logo",
      "lower_body",
      "lower_body",
    ]);
  });
});
