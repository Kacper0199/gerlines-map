import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("..", import.meta.url).pathname;
const UI_STYLES = new URL("../../../../packages/ui/src/styles/index.css", import.meta.url);
const MAP_FOLDER = /(^|\/)map\/|(^|\/)signature\/selection-camera\.ts$/;

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "fixtures" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = sources(SRC).map((path) => ({
  name: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}));

describe("reduced motion", () => {
  it("cuts every CSS animation and transition of the app when the person asks for less motion", () => {
    const css = readFileSync(UI_STYLES, "utf8");
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("animation-duration: 0.01ms");
    expect(block).toContain("animation-iteration-count: 1");
    expect(block).toContain("transition-duration: 0.01ms");
  });

  const PREFERENCE = /prefers-reduced-motion: reduce/;
  const read = (name: string) => FILES.find((file) => file.name === name)?.text ?? "";

  it("scrolls smoothly only in the files known to do so, each reading the preference", () => {
    const smooth = FILES.filter((file) => /behavior:\s*[^,}]*"smooth"/.test(file.text)).map(
      (file) => file.name,
    );
    expect(smooth.sort()).toEqual(
      [
        "components/train/card/TrainCard.tsx",
        "journeys/JourneyList.tsx",
        "stats/StatsPanel.tsx",
      ].sort(),
    );
    for (const name of smooth) {
      expect(read(name), name).toMatch(PREFERENCE);
    }
  });

  it("moves the camera outside the map folder only in the files known to do so, each reading the preference", () => {
    const flights = FILES.filter(
      (file) => !MAP_FOLDER.test(file.name) && /\.(easeTo|flyTo|fitBounds)\(/.test(file.text),
    ).map((file) => file.name);
    expect(flights.sort()).toEqual(["components/SearchMap.tsx", "journeys/JourneyMap.tsx"]);
    for (const name of flights) {
      expect(read(name), name).toMatch(PREFERENCE);
    }
  });

  it("gives the pulsing legend rows a still version", () => {
    const rows = FILES.filter((file) => file.text.includes("animate-pulse"));
    expect(rows.map((file) => file.name)).toEqual(["components/shell/LegendDelayRows.tsx"]);
    expect(rows[0]?.text).toContain("motion-reduce:animate-none");
  });
});
