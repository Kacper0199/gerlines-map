import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_BASE, DEFAULT_PUSH_PATH, liveConfigOf, overrideModeOf } from "./source.ts";

describe("the live path in a development page", () => {
  it("reads our own frames at the default base without any setting", () => {
    expect(liveConfigOf("", "development")).toEqual({
      baseUrl: DEFAULT_LIVE_BASE,
      pollMs: 1000,
      timeScale: 1,
      replay: false,
      probe: true,
    });
  });
});

describe("overrideModeOf", () => {
  it("is development in the dev server, probe with ?probe, else production", () => {
    expect(overrideModeOf("", true)).toBe("development");
    expect(overrideModeOf("?probe=1", true)).toBe("development");
    expect(overrideModeOf("?probe=1", false)).toBe("probe");
    expect(overrideModeOf("?replay=10", false)).toBe("production");
  });
});

describe("liveConfigOf in a production page", () => {
  it("follows the live server in real time and ignores every override", () => {
    expect(liveConfigOf("?replay=10&live=https://other.example/live/v1&probe=0&push=off")).toEqual({
      baseUrl: DEFAULT_LIVE_BASE,
      pollMs: 1000,
      pushUrl: DEFAULT_PUSH_PATH,
      timeScale: 1,
      replay: false,
      probe: false,
    });
    expect(liveConfigOf("?live=/other/v1").baseUrl).toBe(DEFAULT_LIVE_BASE);
  });
});

describe("liveConfigOf with probe or in development", () => {
  it("takes a replay speed, marks the data as recorded and polls once per plan second", () => {
    expect(liveConfigOf("?replay=10", "probe")).toMatchObject({
      timeScale: 10,
      replay: true,
      pollMs: 100,
      probe: true,
    });
    expect(liveConfigOf("?replay=2.5", "development")).toMatchObject({
      timeScale: 2.5,
      pollMs: 400,
    });
  });

  it("ignores a replay speed that is not a positive number", () => {
    for (const bad of ["?replay=0", "?replay=-3", "?replay=abc", "?replay=", "?replay=Infinity"]) {
      expect(liveConfigOf(bad, "probe")).toMatchObject({
        timeScale: 1,
        replay: false,
        pollMs: 1000,
      });
    }
  });

  it("caps an absurd replay speed and keeps a floor under the poll interval", () => {
    const config = liveConfigOf("?replay=100000", "probe");
    expect(config.timeScale).toBe(60);
    expect(config.pollMs).toBe(100);
  });

  it("takes another base path in a probe page and a url only in development", () => {
    expect(liveConfigOf("?live=/other/v1", "probe").baseUrl).toBe("/other/v1");
    const url = "?live=http://127.0.0.1:5822/live/v1/";
    expect(liveConfigOf(url, "probe").baseUrl).toBe(DEFAULT_LIVE_BASE);
    expect(liveConfigOf(url, "development").baseUrl).toBe("http://127.0.0.1:5822/live/v1");
  });

  it("refuses a base that is not a path or an http url", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/plain,x",
      "//evil.example/x",
      "file:///x",
    ]) {
      expect(liveConfigOf(`?live=${encodeURIComponent(bad)}`, "development").baseUrl).toBe(
        DEFAULT_LIVE_BASE,
      );
    }
  });
});

describe("the push server of a live page", () => {
  it("is our own in a production page whatever the address says", () => {
    expect(liveConfigOf("").pushUrl).toBe(DEFAULT_PUSH_PATH);
    expect(liveConfigOf("?push=wss://other.example/connection/websocket").pushUrl).toBe(
      DEFAULT_PUSH_PATH,
    );
  });

  it("is ours with ?probe, another path on request, and none with off or in a replay", () => {
    expect(liveConfigOf("", "probe").pushUrl).toBe(DEFAULT_PUSH_PATH);
    expect(liveConfigOf("?push=/other/websocket", "probe").pushUrl).toBe("/other/websocket");
    expect(liveConfigOf("?push=off", "probe").pushUrl).toBeUndefined();
    expect(liveConfigOf("?replay=10", "probe").pushUrl).toBeUndefined();
    expect(liveConfigOf("?push=ws://127.0.0.1:8000/connection/websocket", "probe").pushUrl).toBe(
      undefined,
    );
  });

  it("is off in development unless named, where a ws or http url is taken", () => {
    expect(liveConfigOf("", "development").pushUrl).toBeUndefined();
    const url = "ws://127.0.0.1:8000/connection/websocket";
    expect(liveConfigOf(`?push=${url}`, "development").pushUrl).toBe(url);
    for (const bad of ["javascript:alert(1)", "//evil.example/x", "file:///x"]) {
      expect(
        liveConfigOf(`?push=${encodeURIComponent(bad)}`, "development").pushUrl,
      ).toBeUndefined();
    }
  });
});
