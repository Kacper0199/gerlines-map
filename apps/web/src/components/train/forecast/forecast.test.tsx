// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import type { TrainForecast } from "@gerlines/schema";
import { TooltipProvider } from "@gerlines/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TrainPanel } from "../card/TrainCard.tsx";
import { MINUTE, T0, testDetail } from "../test-detail.ts";
import { ForecastBlock } from "./ForecastBlock.tsx";
import { FORECAST_ROWS, forecastModel } from "./forecast-model.ts";

const FORECAST: TrainForecast = {
  method: "b1-change",
  fromIndex: 1,
  fromDelayMinutes: 4,
  upperQuantile: 0.8,
  trainedFrom: "2026-08",
  trainedTo: "2026-10",
  sourceName: "piebro/deutsche-bahn-data",
  attribution:
    "Deutsche Bahn train data, collected and processed by piebro, data from Deutsche Bahn",
  licence: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  stops: [
    {
      index: 2,
      stopsAhead: 1,
      expectedDelayMinutes: 5,
      upperDelayMinutes: 8,
      level: "train",
      runs: 61,
    },
    {
      index: 3,
      stopsAhead: 2,
      expectedDelayMinutes: 3,
      upperDelayMinutes: 7,
      level: "stop",
      runs: 340,
    },
    {
      index: 4,
      stopsAhead: 3,
      expectedDelayMinutes: -1,
      upperDelayMinutes: 4,
      level: "category",
      runs: 9000,
    },
  ],
};

const ANCHORED: TrainForecast = {
  ...FORECAST,
  stops: FORECAST.stops.map((stop, i) =>
    i < 2 ? { ...stop, basis: "feed_plus_spread" as const } : { ...stop, basis: "b1" as const },
  ),
};

const FEED_ONLY: TrainForecast = {
  ...FORECAST,
  stops: FORECAST.stops.map((stop) => ({ ...stop, basis: "feed_plus_spread" as const })),
};

afterEach(async () => {
  cleanup();
  await changeLocale("en", { persist: false });
});

describe("forecastModel", () => {
  it("names each forecast stop from the detail in route order", () => {
    const model = forecastModel(testDetail({ forecast: FORECAST }));
    expect(model?.fromName).toBe("Berlin-Spandau");
    expect(
      model?.rows.map((row) => [row.name, row.expectedMinutes, row.upperMinutes, row.level]),
    ).toEqual([
      ["Stendal Hbf", 5, 8, "train"],
      ["Wolfsburg Hbf", 3, 7, "stop"],
      ["Hannover Hbf", -1, 4, "category"],
    ]);
    expect(model?.more).toBe(0);
  });

  it("keeps each stop's basis, B1 when the API sent none, and names the feed it anchors on", () => {
    const plain = forecastModel(testDetail({ forecast: FORECAST }));
    expect(plain?.rows.map((row) => row.basis)).toEqual(["b1", "b1", "b1"]);
    expect(plain?.feedSourceName).toBeNull();
    expect(plain?.historyRows).toBe(true);
    const mixed = forecastModel(testDetail({ forecast: ANCHORED }));
    expect(mixed?.rows.map((row) => row.basis)).toEqual([
      "feed_plus_spread",
      "feed_plus_spread",
      "b1",
    ]);
    expect(mixed?.feedSourceName).toBe("gtfs.de realtime (free, beta)");
    expect(mixed?.historyRows).toBe(true);
    expect(forecastModel(testDetail({ forecast: FEED_ONLY }))?.historyRows).toBe(false);
  });

  it("is null without a forecast, for a cancelled train and for timetable data", () => {
    expect(forecastModel(testDetail())).toBeNull();
    expect(forecastModel(testDetail({ forecast: null }))).toBeNull();
    expect(forecastModel(testDetail({ forecast: FORECAST, cancelled: true }))).toBeNull();
    const timetable = testDetail({ forecast: FORECAST });
    expect(
      forecastModel({ ...timetable, provenance: { ...timetable.provenance, kind: "timetable" } }),
    ).toBeNull();
  });

  it("keeps the first rows and counts the rest", () => {
    const first = FORECAST.stops[0];
    if (!first) throw new Error("no stop");
    const many = Array.from({ length: FORECAST_ROWS + 2 }, () => first);
    const model = forecastModel(testDetail({ forecast: { ...FORECAST, stops: many } }));
    expect(model?.rows).toHaveLength(FORECAST_ROWS);
    expect(model?.more).toBe(2);
  });
});

describe("ForecastBlock", () => {
  const model = forecastModel(testDetail({ forecast: FORECAST }));
  if (!model) throw new Error("no model");

  it("labels the values as a forecast with method, months, source and licence", () => {
    render(<ForecastBlock forecast={model} />);
    expect(screen.getByRole("heading", { name: "Forecast from history" })).toBeTruthy();
    expect(screen.getByText("From +4 min at Berlin-Spandau")).toBeTruthy();
    expect(screen.getByText("+5 min, 8 in 10 under +8 min")).toBeTruthy();
    expect(screen.getByText("−1 min, 8 in 10 under +4 min")).toBeTruthy();
    expect(screen.getByText("This train")).toBeTruthy();
    expect(screen.getByText("Trains of this kind here")).toBeTruthy();
    const note = screen.getByText(/^Forecast, not measured\./);
    expect(note.textContent).toContain("From runs Aug 2026 to Oct 2026");
    expect(note.textContent).toContain("in the same delay range as this train");
    expect(note.textContent).not.toContain("as late as this one");
    expect(note.textContent).toContain("Method B1");
    expect(note.textContent).toContain(
      "Source Deutsche Bahn train data, collected and processed by piebro",
    );
    expect(screen.getByRole("link", { name: "CC-BY-4.0" }).getAttribute("href")).toBe(
      "https://creativecommons.org/licenses/by/4.0/",
    );
  });

  it("says the typical value is the feed's forecast and the bound adds the spread from history", () => {
    const anchored = forecastModel(testDetail({ forecast: FEED_ONLY }));
    if (!anchored) throw new Error("no model");
    render(<ForecastBlock forecast={anchored} />);
    expect(
      screen.getByRole("heading", { name: "Forecast with a range from history" }),
    ).toBeTruthy();
    expect(screen.getByText("+5 min, 8 in 10 under +8 min")).toBeTruthy();
    expect(screen.getByText("Live forecast, spread of this train")).toBeTruthy();
    expect(screen.getByText("Live forecast, spread of trains of this kind")).toBeTruthy();
    expect(screen.queryByText("This train")).toBeNull();
    const note = screen.getByText(/^Forecast, not measured\./);
    expect(note.textContent).toContain(
      "The typical value is the arrival delay the live data from gtfs.de realtime (free, beta) predicts",
    );
    expect(note.textContent).toContain(
      "The 8 in 10 bound adds the spread of runs Aug 2026 to Oct 2026",
    );
    expect(note.textContent).toContain("came closer than method B1 in a live check");
    expect(note.textContent).not.toContain("At stops without a live forecast");
    expect(note.textContent).not.toContain("beat the current delay carried forward");
    expect(note.textContent).toContain("Source Deutsche Bahn train data");
  });

  it("marks the stops without a live forecast when the bases mix", () => {
    const mixed = forecastModel(testDetail({ forecast: ANCHORED }));
    if (!mixed) throw new Error("no model");
    render(<ForecastBlock forecast={mixed} />);
    expect(screen.getByText("Live forecast, spread of this train")).toBeTruthy();
    expect(screen.getByText("Live forecast, spread of trains of this kind here")).toBeTruthy();
    expect(screen.getByText("Trains of this kind")).toBeTruthy();
    expect(screen.getByText(/^Forecast, not measured\./).textContent).toContain(
      "At stops without a live forecast, both values come from those runs.",
    );
  });

  it("reads in German and Polish", async () => {
    await changeLocale("de", { persist: false });
    const { unmount } = render(<ForecastBlock forecast={model} />);
    expect(screen.getByText("Prognose aus der Historie")).toBeTruthy();
    expect(screen.getByText("+5 min, 8 von 10 unter +8 min")).toBeTruthy();
    expect(screen.getByText(/^Prognose, nicht gemessen\./).textContent).toContain(
      "Quelle Zugdaten der Deutschen Bahn, gesammelt und aufbereitet von piebro",
    );
    unmount();
    await changeLocale("pl", { persist: false });
    const polish = render(<ForecastBlock forecast={model} />);
    expect(screen.getByText("Prognoza z historii")).toBeTruthy();
    expect(screen.getByText("+5 min, 8 na 10 poniżej +8 min")).toBeTruthy();
    expect(screen.getByText(/^Prognoza, nie pomiar\./).textContent).toContain(
      "Źródło Dane pociągów Deutsche Bahn, zebrane i przetworzone przez piebro",
    );
    polish.unmount();
  });

  it("reads the feed basis in German and Polish", async () => {
    const anchored = forecastModel(testDetail({ forecast: ANCHORED }));
    if (!anchored) throw new Error("no model");
    await changeLocale("de", { persist: false });
    const { unmount } = render(<ForecastBlock forecast={anchored} />);
    expect(screen.getByText("Prognose mit Spanne aus der Historie")).toBeTruthy();
    expect(screen.getByText("Live-Prognose, Streuung dieses Zuges")).toBeTruthy();
    const german = screen.getByText(/^Prognose, nicht gemessen\./).textContent;
    expect(german).toContain("die die Echtzeitdaten von gtfs.de realtime (free, beta)");
    expect(german).toContain(
      "An Halten ohne Live-Prognose stammen beide Werte aus diesen Fahrten.",
    );
    unmount();
    await changeLocale("pl", { persist: false });
    render(<ForecastBlock forecast={anchored} />);
    expect(screen.getByText("Prognoza z zakresem z historii")).toBeTruthy();
    expect(screen.getByText("Prognoza na żywo, rozrzut tego pociągu")).toBeTruthy();
    const polish = screen.getByText(/^Prognoza, nie pomiar\./).textContent;
    expect(polish).toContain("które dane na żywo z gtfs.de realtime (free, beta) przewidują");
    expect(polish).toContain(
      "Na stacjach bez prognozy na żywo obie wartości pochodzą z tych kursów.",
    );
  });

  it("shows the attribution the API sent for a source it has no translation of", async () => {
    await changeLocale("de", { persist: false });
    const other = { ...model, sourceName: "other/set", attribution: "Other data, CC BY 4.0" };
    render(<ForecastBlock forecast={other} />);
    expect(screen.getByText(/^Prognose, nicht gemessen\./).textContent).toContain(
      "Quelle Other data, CC BY 4.0.",
    );
  });

  it("appears on the card with all stops open, and not without a forecast", () => {
    const view = render(
      <TooltipProvider>
        <TrainPanel
          state={{ status: "ready", detail: testDetail({ forecast: FORECAST }) }}
          nowMs={T0 + 30 * MINUTE}
          handlers={{}}
          onClose={() => {}}
          defaultStopsOpen
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("region", { name: "Forecast from history" })).toBeTruthy();
    view.unmount();
    render(
      <TooltipProvider>
        <TrainPanel
          state={{ status: "ready", detail: testDetail() }}
          nowMs={T0 + 30 * MINUTE}
          handlers={{}}
          onClose={() => {}}
          defaultStopsOpen
        />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("region", { name: "Forecast from history" })).toBeNull();
  });
});
