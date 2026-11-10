// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import type { StatsLand, StatsNetwork } from "@gerlines/schema/stats";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import land from "./fixtures/land-by-2025-11.json" with { type: "json" };
import network from "./fixtures/network-2025-11.json" with { type: "json" };
import { Provenance } from "./Provenance.tsx";

const NET = network as unknown as StatsNetwork;
const LAND = land as unknown as StatsLand;

beforeEach(() => changeLocale("en"));
afterEach(cleanup);

function note(data: Parameters<typeof Provenance>[0]["data"]): string {
  const view = render(<Provenance data={data} />);
  return view.container.querySelector("details")?.textContent ?? "";
}

describe("method note", () => {
  it("compares with Deutsche Bahn for Germany over whole months", () => {
    expect(note(NET)).toContain("Deutsche Bahn publishes");
  });

  it("leaves the comparison out for a month in progress", () => {
    const partial = { ...NET, period: { from: "2026-11-01", to: "2026-11-08", days: 8 } };
    expect(note(partial)).not.toContain("Deutsche Bahn publishes");
  });

  it("leaves the comparison out for a Land, whose figure Deutsche Bahn does not publish", () => {
    expect(note(LAND)).not.toContain("Deutsche Bahn publishes");
  });

  it("credits piebro and Deutsche Bahn for the days before the live recording", () => {
    for (const data of [NET, LAND]) {
      const text = note(data);
      expect(text).toContain("piebro");
      expect(text).toContain("CC BY 4.0");
      expect(text).toContain("data from Deutsche Bahn");
    }
    changeLocale("de");
    expect(note(NET)).toContain("Daten der Deutschen Bahn");
    changeLocale("pl");
    expect(note(NET)).toContain("dane Deutsche Bahn");
  });

  it("names only the counts that are above zero", () => {
    const both = note({ ...NET, outsideGermany: { foreignStops: 12, unassignedStops: 3 } });
    expect(both).toContain("12 stops abroad and 3 stops without a state");
    const foreign = note({ ...NET, outsideGermany: { foreignStops: 12, unassignedStops: 0 } });
    expect(foreign).toContain("Not counted: 12 stops abroad.");
    expect(foreign).not.toContain("without a state");
    const none = note({ ...NET, outsideGermany: { foreignStops: 0, unassignedStops: 0 } });
    expect(none).not.toContain("Not counted");
    const unassigned = note({ ...NET, outsideGermany: { foreignStops: 0, unassignedStops: 4 } });
    expect(unassigned).toContain("Not counted: 4 stops without a state.");
  });
});
