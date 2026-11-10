// @vitest-environment happy-dom

import { changeLocale, copyFor } from "@gerlines/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { titleSizeClass } from "./CardHead.tsx";
import { shareLink, trainShareUrl } from "./share.ts";
import { confidenceLabel, VehicleBlock } from "./VehicleBlock.tsx";

afterEach(async () => {
  cleanup();
  await changeLocale("en", { persist: false });
});

const VEHICLE = {
  seriesId: "test-series",
  seriesName: "Test series",
  variant: "B",
  units: 1,
  cars: 7,
  lengthMetres: 200.4,
  layer: "L2" as const,
  confidence: 0.7,
  source: "wikipedia-de-s-bahn-rhein-ruhr",
  sourceName: "Wikipedia (de), S-Bahn Rhein-Ruhr",
};

const PHOTO = {
  photoId: "test-series-p1",
  seriesId: "test-series",
  small: { url: "/api/v1/photos/test-series-p1-330-0123456789ab.jpg", width: 330, height: 220 },
  large: { url: "/api/v1/photos/test-series-p1-960-0123456789ab.jpg", width: 960, height: 640 },
  focus: { x: 0.5, y: 0.65 },
  title: "Test series.jpg",
  author: "Test author",
  authorUrl: null,
  licence: "CC BY-SA 4.0",
  licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Test_series.jpg",
};

describe("VehicleBlock", () => {
  it("says the vehicle is not identified yet and why", () => {
    render(<VehicleBlock vehicle={null} photo={null} wide />);
    expect(screen.getByText("Not identified yet")).toBeTruthy();
    expect(screen.getByText(/fleet data, which is not connected yet/)).toBeTruthy();
  });

  it("names the series, the units, the cars, the length, the confidence and the source", () => {
    render(<VehicleBlock vehicle={VEHICLE} photo={null} wide />);
    expect(screen.getByText("Test series B")).toBeTruthy();
    expect(screen.getByText("1 unit, 7 cars, 200 m")).toBeTruthy();
    expect(screen.getByText("Likely. Source Wikipedia (de), S-Bahn Rhein-Ruhr")).toBeTruthy();
    expect(screen.getByText("No photo with a free licence yet")).toBeTruthy();
  });

  it("shows the units beside the length when the data has no car count", () => {
    const twoUnits = { ...VEHICLE, units: 2, cars: null, lengthMetres: 138.86 };
    render(<VehicleBlock vehicle={twoUnits} photo={null} wide />);
    expect(screen.getByText("2 units, 139 m")).toBeTruthy();
  });

  it("counts the units in German and Polish with the right plural", async () => {
    const twoUnits = { ...VEHICLE, units: 2, cars: null, lengthMetres: 138.86 };
    await changeLocale("de", { persist: false });
    const view = render(<VehicleBlock vehicle={twoUnits} photo={null} wide />);
    expect(screen.getByText("2 Einheiten, 139 m")).toBeTruthy();
    view.unmount();
    await changeLocale("pl", { persist: false });
    render(<VehicleBlock vehicle={{ ...twoUnits, units: 5 }} photo={null} wide />);
    expect(screen.getByText("5 jednostek, 139 m")).toBeTruthy();
  });

  it("names a DB Class series by its Baureihe number and the source by its display name", async () => {
    const s422 = { ...VEHICLE, seriesName: "DB Class 422", br: "422", variant: null };
    await changeLocale("de", { persist: false });
    const de = render(<VehicleBlock vehicle={s422} photo={null} wide />);
    expect(screen.getByText("Baureihe 422")).toBeTruthy();
    expect(
      screen.getByText("Wahrscheinlich. Quelle Wikipedia (de), S-Bahn Rhein-Ruhr"),
    ).toBeTruthy();
    de.unmount();
    await changeLocale("pl", { persist: false });
    render(<VehicleBlock vehicle={s422} photo={null} wide />);
    expect(screen.getByText("Seria DB 422")).toBeTruthy();
  });

  it("never prints a source id: a source without a name from the API is left out", () => {
    const unnamed = { ...VEHICLE, source: "wikipedia-de-new", sourceName: null };
    const view = render(<VehicleBlock vehicle={unnamed} photo={null} wide />);
    expect(screen.getByText("Likely")).toBeTruthy();
    expect(screen.queryByText(/wikipedia-de-new/)).toBeNull();
    view.unmount();
    const { sourceName: _name, ...older } = VEHICLE;
    render(<VehicleBlock vehicle={older} photo={null} wide />);
    expect(screen.getByText("Likely")).toBeTruthy();
    expect(screen.queryByText(/wikipedia-de-s-bahn-rhein-ruhr/)).toBeNull();
  });

  it("shows the source name the API sends, also for a source the web build never listed", () => {
    const fresh = { ...VEHICLE, source: "wikipedia-de-new", sourceName: "Wikipedia (de), Neu" };
    render(<VehicleBlock vehicle={fresh} photo={null} wide />);
    expect(screen.getByText("Likely. Source Wikipedia (de), Neu")).toBeTruthy();
  });

  it("says the 3D model is the related series when the table of identical bodies names one", () => {
    const bodies = {
      "test-series": { relatedSeriesId: "db-423", relatedName: "DB Class 423" },
    };
    render(<VehicleBlock vehicle={VEHICLE} photo={null} wide bodies={bodies} />);
    expect(
      screen.getByText(
        "The 3D model on the map is that of the related DB Class 423, which has the same body.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Test series B")).toBeTruthy();
  });

  it("words the related model without repeating the word series in German and Polish", () => {
    expect(copyFor("de").train.vehicleRelatedModel("DB Class 423")).toBe(
      "Das 3D-Modell auf der Karte zeigt die verwandte DB Class 423 mit demselben Wagenkasten.",
    );
    expect(copyFor("pl").train.vehicleRelatedModel("DB Class 423")).toBe(
      "Model 3D na mapie przedstawia pokrewny pojazd DB Class 423 o takim samym nadwoziu.",
    );
  });

  it("says nothing about the model for a series the table does not name", () => {
    render(<VehicleBlock vehicle={VEHICLE} photo={null} wide />);
    expect(screen.queryByText(/related/)).toBeNull();
  });

  it("credits the photo with its title, author and licence, links the source and notes the crop", () => {
    render(<VehicleBlock vehicle={VEHICLE} photo={PHOTO} wide />);
    const title = screen.getByRole("link", { name: "Test series" });
    expect(title.getAttribute("href")).toBe(
      "https://commons.wikimedia.org/wiki/File:Test_series.jpg",
    );
    const caption = screen.getByRole("figure").querySelector("figcaption")?.textContent;
    expect(caption).toBe("Test series. Photo Test author, CC BY-SA 4.0. Cropped and resized.");
    const licence = screen.getByRole("link", { name: "CC BY-SA 4.0" });
    expect(licence.getAttribute("href")).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    const image = screen.getByRole("img", { name: "Test series B" });
    expect(image.getAttribute("src")).toBe(PHOTO.small.url);
    expect(image.getAttribute("srcset")).toBe(`${PHOTO.small.url} 330w, ${PHOTO.large.url} 960w`);
    expect(image.getAttribute("style")).toContain("50% 65%");
  });

  it("names a licence without a link as text, for public domain files", () => {
    const publicDomain = { ...PHOTO, licence: "Public domain", licenceUrl: null };
    render(<VehicleBlock vehicle={VEHICLE} photo={publicDomain} wide />);
    expect(screen.getByText("Public domain")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Public domain" })).toBeNull();
  });

  it("words the confidence in three steps", () => {
    const copy = copyFor("en").train;
    expect(confidenceLabel(0.95, copy)).toBe("Confirmed");
    expect(confidenceLabel(0.6, copy)).toBe("Likely");
    expect(confidenceLabel(0.2, copy)).toBe("Possible");
  });
});

describe("share", () => {
  it("adds the train to the current address and keeps the other parameters", () => {
    const url = trainShareUrl("6f1c2a7e-6c3b-5d55-9a43-2f6b8e0c1d11", {
      origin: "https://gerlines.example",
      pathname: "/",
      search: "?lang=de",
    });
    expect(url).toBe(
      "https://gerlines.example/?lang=de&train=6f1c2a7e-6c3b-5d55-9a43-2f6b8e0c1d11",
    );
  });

  it("uses the share sheet on touch screens and the clipboard elsewhere", async () => {
    const share = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    expect(await shareLink("u", "t", { share, clipboard: { writeText }, prefersSheet: true })).toBe(
      "shared",
    );
    expect(share).toHaveBeenCalledWith({ url: "u", title: "t" });
    expect(
      await shareLink("u", "t", { share, clipboard: { writeText }, prefersSheet: false }),
    ).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("u");
  });

  it("reports a failed copy", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    expect(await shareLink("u", "t", { clipboard: { writeText }, prefersSheet: false })).toBe(
      "failed",
    );
    expect(await shareLink("u", "t", { prefersSheet: false })).toBe("failed");
  });
});

describe("titleSizeClass", () => {
  it("steps the title down for one long word so it fits beside the delay", () => {
    expect(titleSizeClass("RE6")).toBe("text-[28px] sm:text-[32px]");
    expect(titleSizeClass("Regionalbahn Rhein")).toBe("text-[28px] sm:text-[32px]");
    expect(titleSizeClass("Weißeritztalbahn")).toBe("text-[22px] sm:text-[24px]");
    expect(titleSizeClass("Lößnitzgrundbahn")).toBe("text-[22px] sm:text-[24px]");
    expect(titleSizeClass("Schwarzwaldbahnhofstrasse")).toBe("text-[20px]");
  });
});
