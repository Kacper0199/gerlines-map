import { CATEGORIES, CATEGORY_RGBA, categoryIndex } from "./palette.ts";
import { decodePolyline } from "./polyline.ts";
import { buildShapeStore, type ShapeStore } from "./shapes.ts";

export interface RailFixture {
  segments: { c: string; d: number; l: number; p: string }[];
}

export async function fetchFixture(url: string): Promise<RailFixture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fixture ${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const body = gzipped
    ? new Response(bytes).body?.pipeThrough(new DecompressionStream("gzip"))
    : new Response(bytes).body;
  if (!body) throw new Error("fixture body unavailable");
  return (await new Response(body).json()) as RailFixture;
}

export interface LoadedFixture {
  store: ShapeStore;
  durations: Float64Array;
  categories: Uint8Array;
  categoryRgba: Uint8Array;
}

export function prepareFixture(fixture: RailFixture): LoadedFixture {
  const polylines = fixture.segments.map((segment) => decodePolyline(segment.p));
  const durations = Float64Array.from(fixture.segments, (segment) => segment.d);
  const categories = Uint8Array.from(fixture.segments, (segment) => categoryIndex(segment.c));
  const categoryRgba = new Uint8Array(CATEGORIES.length * 4);
  CATEGORIES.forEach((category, index) => {
    categoryRgba.set(CATEGORY_RGBA[category], index * 4);
  });
  return { store: buildShapeStore(polylines), durations, categories, categoryRgba };
}
