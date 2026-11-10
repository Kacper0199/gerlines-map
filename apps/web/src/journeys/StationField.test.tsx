// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import type { SearchStation } from "@gerlines/schema/search";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plannerStationOf } from "./planner-address.ts";
import type { PlannerStation } from "./planner-store.ts";
import { StationField } from "./StationField.tsx";

function station(fields: Partial<SearchStation> & Pick<SearchStation, "id" | "name">) {
  return {
    kind: "station" as const,
    lon: 7.5895,
    lat: 47.5476,
    eva: null,
    dhid: null,
    lines: [],
    trainsToday: 190,
    ...fields,
  };
}

const BASEL = station({
  id: "7d062e86-a7af-5199-98c3-b2b62cd9b516",
  name: "Basel SBB",
  eva: 8500010,
  stopId: "ch:1:sloid:10",
});
const BASEL_BAD = station({
  id: "2a1b3c4d-5e6f-5a7b-8c9d-0e1f2a3b4c5d",
  name: "Basel Bad Bf",
  dhid: "de:08336:7020",
});
const BASEL_ST_JOHANN = station({
  id: "3b2c4d5e-6f7a-5b8c-9d0e-1f2a3b4c5d6e",
  name: "Basel St. Johann",
  stopId: null,
});

function answering(results: readonly object[]) {
  return async () =>
    Response.json({ query: "basel", serviceDate: "2026-11-10", timetableVersion: "3", results });
}

function field(fetch: ReturnType<typeof answering>) {
  const chosen: (PlannerStation | null)[] = [];
  render(
    <StationField
      label="From"
      placeholder="Station"
      value={null}
      onChange={(next) => chosen.push(next)}
      fetch={fetch}
    />,
  );
  return chosen;
}

beforeEach(async () => {
  await changeLocale("en", { persist: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("plannerStationOf", () => {
  it("keeps the stop id journeys take, the DHID from an answer that lacks one, else none", () => {
    expect(plannerStationOf(BASEL).stopId).toBe("ch:1:sloid:10");
    expect(plannerStationOf(BASEL_BAD).stopId).toBe("de:08336:7020");
    expect(plannerStationOf({ ...BASEL_BAD, stopId: "de:08336:7020" }).stopId).toBe(
      "de:08336:7020",
    );
    expect(plannerStationOf(BASEL_ST_JOHANN).stopId).toBeNull();
  });
});

describe("StationField", () => {
  it("takes a station abroad by its feed stop id and keeps one without any stop id muted", async () => {
    const chosen = field(answering([BASEL_ST_JOHANN, BASEL, BASEL_BAD]));
    await userEvent.type(screen.getByRole("combobox"), "Basel");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    const [stJohann, basel] = screen.getAllByRole("option");
    expect(stJohann?.getAttribute("aria-disabled")).toBe("true");
    expect(basel?.getAttribute("aria-disabled")).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(chosen.at(-1)).toMatchObject({ name: "Basel SBB", stopId: "ch:1:sloid:10" });
  });

  it("still takes a station from an older answer that names only the DHID", async () => {
    const chosen = field(answering([BASEL_BAD]));
    await userEvent.type(screen.getByRole("combobox"), "Basel Bad");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    await userEvent.click(screen.getByRole("option"));
    expect(chosen.at(-1)).toMatchObject({ name: "Basel Bad Bf", stopId: "de:08336:7020" });
  });
});
