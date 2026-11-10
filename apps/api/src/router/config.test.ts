import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../config.ts";
import { readRouterConfig } from "./config.ts";

const APP = { APP_NAME: "gerlines", APP_CONTACT: "https://example.org/contact" };

describe("readRouterConfig", () => {
  it("is off without ROUTER_BASE_URL: there is no default router", () => {
    expect(readRouterConfig({}, "0.0.0")).toBeUndefined();
    expect(readRouterConfig({ ...APP, ROUTER_BASE_URL: "  " }, "0.0.0")).toBeUndefined();
  });

  it("reads the base URL, the dataset tag and builds the User-Agent with the contact", () => {
    expect(
      readRouterConfig({ ...APP, ROUTER_BASE_URL: "http://127.0.0.1:8092/" }, "1.2.3"),
    ).toEqual({
      baseUrl: "http://127.0.0.1:8092",
      datasetTag: "de-DELFI",
      userAgent: "gerlines/1.2.3 (+https://example.org/contact)",
    });
    expect(
      readRouterConfig(
        { ...APP, ROUTER_BASE_URL: "http://router:8080", ROUTER_DATASET_TAG: "de-test" },
        "1",
      )?.datasetTag,
    ).toBe("de-test");
  });

  it.each([
    [{ ROUTER_BASE_URL: "not a url" }],
    [{ ROUTER_BASE_URL: "file:///etc/passwd" }],
    [{ ROUTER_BASE_URL: "http://router-user@127.0.0.1:8092" }],
    [{ ROUTER_BASE_URL: "http://127.0.0.1:8092?x=1" }],
    [{ ROUTER_BASE_URL: "http://127.0.0.1:8092/motis" }],
    [{ ROUTER_BASE_URL: "https://router.example.org/motis/" }],
    [{ ROUTER_BASE_URL: "http://127.0.0.1:8092", ROUTER_DATASET_TAG: "de_DELFI" }],
  ])("refuses %j", (env) => {
    expect(() => readRouterConfig({ ...APP, ...env }, "0.0.0")).toThrow(ConfigurationError);
  });

  it.each([
    [{ APP_NAME: undefined }, /APP_NAME/],
    [{ APP_CONTACT: undefined }, /APP_CONTACT/],
    [{ APP_CONTACT: "a (b)" }, /User-Agent/],
  ])("refuses a router without a valid User-Agent %j", (override, message) => {
    const env = { ...APP, ROUTER_BASE_URL: "http://127.0.0.1:8092", ...override };
    expect(() => readRouterConfig(env, "0.0.0")).toThrow(ConfigurationError);
    expect(() => readRouterConfig(env, "0.0.0")).toThrow(message);
  });
});
