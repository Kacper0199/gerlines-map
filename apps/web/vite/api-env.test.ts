import { describe, expect, it } from "vitest";
import { apiEnvironment } from "./api-env.ts";

describe("apiEnvironment", () => {
  it("forwards the photo settings and the process values over the file, nothing else", () => {
    const file =
      "PHOTO_DIR=/data/photos\nVEHICLE_DATABASE_URL=postgres://file\nPOSTGRES_PASSWORD=x\n";
    const environment = apiEnvironment(file, {
      VEHICLE_DATABASE_URL: "postgres://process",
      HOME: "/home/user",
    });
    expect(environment).toEqual({
      PHOTO_DIR: "/data/photos",
      VEHICLE_DATABASE_URL: "postgres://process",
    });
  });
});
