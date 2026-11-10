import { describe, expect, it } from "vitest";
import { apiEnvironment, statsEnvironment } from "../vite/api-env.ts";

const FILE = [
  "APP_NAME=gerlines-test",
  "APP_CONTACT=https://example.org/contact",
  "ROUTER_BASE_URL=http://127.0.0.1:8092",
  "TRANSITOUS_MODE=recorded",
  "POSTGRES_HOST=127.0.0.1",
  "STORAGE_BUCKET=left-alone",
  "VITE_SOMETHING=exposed",
  "# comment",
].join("\n");

describe("apiEnvironment", () => {
  it("hands the search database and places file to the dev API from the process", () => {
    const environment = apiEnvironment(undefined, {
      SEARCH_DATABASE_URL: "postgres://reader@127.0.0.1:5433/gerlines",
      SEARCH_PLACES_FILE: "/tmp/places-de.tsv",
      DATABASE_URL: "postgres://owner@127.0.0.1:5433/gerlines",
    });

    expect(environment).toEqual({
      SEARCH_DATABASE_URL: "postgres://reader@127.0.0.1:5433/gerlines",
      SEARCH_PLACES_FILE: "/tmp/places-de.tsv",
    });
  });

  it("hands the statistics database to the dev API from the process", () => {
    const environment = apiEnvironment(undefined, {
      STATS_DATABASE_URL: "postgres://reader@127.0.0.1:5433/gerlines",
      DATABASE_URL: "postgres://owner@127.0.0.1:5433/gerlines",
    });

    expect(environment).toEqual({
      STATS_DATABASE_URL: "postgres://reader@127.0.0.1:5433/gerlines",
    });
  });

  it("hands the router and the statistics database to the dev API for the journey planner", () => {
    const environment = apiEnvironment(undefined, {
      ROUTER_BASE_URL: "http://127.0.0.1:8092",
      ROUTER_DATASET_TAG: "de-DELFI",
      STATS_DATABASE_URL: "postgres://reader@127.0.0.1:5433/gerlines_wp27",
      ROUTERX: "left-alone",
    });

    expect(environment).toEqual({
      ROUTER_BASE_URL: "http://127.0.0.1:8092",
      ROUTER_DATASET_TAG: "de-DELFI",
      STATS_DATABASE_URL: "postgres://reader@127.0.0.1:5433/gerlines_wp27",
    });
  });

  it("hands over only the names the dev API reads", () => {
    const environment = apiEnvironment(FILE, {});

    expect(environment).toEqual({
      APP_NAME: "gerlines-test",
      APP_CONTACT: "https://example.org/contact",
      ROUTER_BASE_URL: "http://127.0.0.1:8092",
    });
  });

  it("leaves out a setting of the removed development trips proxy left in an old file", () => {
    expect(apiEnvironment(FILE, {})).not.toHaveProperty("TRANSITOUS_MODE");
  });

  it("never copies anything else from the file or the process", () => {
    const environment = apiEnvironment(FILE, { PATH: "/usr/bin", UNRELATED_NAME: "left-alone" });

    expect(Object.keys(environment).sort()).toEqual(["APP_CONTACT", "APP_NAME", "ROUTER_BASE_URL"]);
  });

  it("lets the process environment win over the file, like a shell export would", () => {
    const environment = apiEnvironment(FILE, {
      ROUTER_BASE_URL: "http://127.0.0.1:9000",
      APP_NAME: "from-shell",
    });

    expect(environment).toMatchObject({
      ROUTER_BASE_URL: "http://127.0.0.1:9000",
      APP_NAME: "from-shell",
    });
  });

  it("works without a file", () => {
    expect(apiEnvironment(undefined, { APP_NAME: "x" })).toEqual({ APP_NAME: "x" });
    expect(apiEnvironment(undefined, {})).toEqual({});
  });

  it("does not change the process environment", () => {
    const before = { ...process.env };

    apiEnvironment(FILE, process.env);

    expect(process.env).toEqual(before);
  });
});

describe("statsEnvironment", () => {
  it("opens the statistics pool only for a database named for statistics, never from the search one", () => {
    expect(
      statsEnvironment({
        SEARCH_DATABASE_URL: "postgres://owner@127.0.0.1:5433/gerlines",
        APP_NAME: "x",
      }),
    ).toEqual({});
    expect(
      statsEnvironment({
        STATS_DATABASE_URL: "postgres://reader@127.0.0.1:5433/gerlines_wp72",
        SEARCH_DATABASE_URL: "postgres://owner@127.0.0.1:5433/gerlines",
      }),
    ).toEqual({ STATS_DATABASE_URL: "postgres://reader@127.0.0.1:5433/gerlines_wp72" });
  });
});
