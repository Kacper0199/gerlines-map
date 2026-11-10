import { describe, expect, it } from "vitest";
import { normalizeTrainNumber, tripInstanceId, uuidv5 } from "./ids.ts";

describe("uuidv5", () => {
  it("matches Python uuid.uuid5 over the GerLines namespace", () => {
    expect(uuidv5("stop_place:de:11000:900003201")).toBe("5085cee6-dcb1-58ca-9420-5b87a29e0893");
    expect(uuidv5("Zürich Hbf ü")).toBe("2f35f77d-435d-5520-a5fa-7cc422dfbf7c");
  });
});

describe("tripInstanceId", () => {
  it("hashes service date, operator, train number, origin and origin departure", () => {
    expect(
      tripInstanceId({
        serviceDate: "2026-10-25",
        operatorId: "db-fernverkehr-ag",
        trainNumber: "73",
        originStopPlaceId: "00000000-0000-0000-0000-000000000001",
        originDeparture: Date.parse("2026-10-25T11:00:00Z"),
      }),
    ).toBe("fce7cd29-36a4-5341-b5cd-4c9aeb5d8049");
  });

  it("normalizes train numbers", () => {
    expect(normalizeTrainNumber("006196")).toBe("6196");
    expect(normalizeTrainNumber(" 0 ")).toBe("0");
    expect(normalizeTrainNumber("RE 7")).toBe("RE 7");
    expect(normalizeTrainNumber("")).toBeNull();
    expect(normalizeTrainNumber(null)).toBeNull();
  });
});
