import { describe, expect, it } from "vitest";
import type { PlaybackState } from "../live/playback/driver.ts";
import { POSITION_WRITE_MS, startPlaybackUrlSync } from "./playback-sync.ts";

const AT = 1_762_000_000;

function state(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    phase: "playing",
    playing: true,
    position: AT,
    speed: 1,
    windowStart: AT - (AT % 3600),
    windowEnd: AT - (AT % 3600) + 3600,
    error: null,
    notice: null,
    ...overrides,
  };
}

function setup(search = "", ready = true) {
  let current: PlaybackState | null = null;
  let wall = 0;
  let canSend = ready;
  const listeners = new Set<() => void>();
  const pops = new Set<() => void>();
  const location = { pathname: "/", search, hash: "" };
  const calls: [string, string][] = [];
  const history = {
    pushState: (_: unknown, __: string, url?: string | URL | null) => {
      calls.push(["push", String(url)]);
      location.search = String(url).replace("/", "");
    },
    replaceState: (_: unknown, __: string, url?: string | URL | null) => {
      calls.push(["replace", String(url)]);
      location.search = String(url).replace("/", "");
    },
  };
  const commands: string[] = [];
  const sync = startPlaybackUrlSync(
    {
      location,
      history,
      addPopListener: (listener) => {
        pops.add(listener);
        return () => pops.delete(listener);
      },
      now: () => wall,
    },
    {
      state: () => current,
      ready: () => canSend,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      start: (at) => commands.push(`start ${at}`),
      seek: (at) => commands.push(`seek ${at}`),
      stop: () => commands.push("stop"),
    },
  );
  return {
    sync,
    calls,
    commands,
    location,
    set: (next: PlaybackState | null, advance = 0) => {
      wall += advance;
      current = next;
      for (const listener of listeners) listener();
    },
    ready: () => {
      canSend = true;
      for (const listener of listeners) listener();
    },
    pop: (search: string) => {
      location.search = search;
      for (const listener of pops) listener();
    },
  };
}

describe("playback url sync", () => {
  it("starts a playback from a link that carries a moment", () => {
    const t = setup("?at=2025-11-01T12:00:00Z");
    expect(t.commands).toEqual([`start ${Date.UTC(2025, 10, 1, 12) / 1000}`]);
  });

  it("waits until the worker can take the command", () => {
    const t = setup("?at=2025-11-01T12:00:00Z", false);
    expect(t.commands).toEqual([]);
    t.ready();
    expect(t.commands).toHaveLength(1);
  });

  it("ignores a moment that is not one", () => {
    const t = setup("?at=yesterday");
    expect(t.commands).toEqual([]);
  });

  it("writes a new entry when a playback begins and one when it ends", () => {
    const t = setup("?map=7.00,51.00000,10.00000");
    t.set(state());
    expect(t.calls[0]?.[0]).toBe("push");
    expect(t.calls[0]?.[1]).toContain("map=7.00");
    expect(t.calls[0]?.[1]).toContain("at=2025-11-01T");
    t.set(null);
    expect(t.calls[1]?.[0]).toBe("push");
    expect(t.calls[1]?.[1]).not.toContain("at=");
    expect(t.calls[1]?.[1]).toContain("map=7.00");
  });

  it("replaces the entry with the position at most every few seconds while playing", () => {
    const t = setup();
    t.set(state());
    t.calls.length = 0;
    t.set(state({ position: AT + 1 }), 1000);
    expect(t.calls).toEqual([]);
    t.set(state({ position: AT + 10 }), POSITION_WRITE_MS);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.[0]).toBe("replace");
  });

  it("writes the moment of a pause and of a seek at once, not while seeking", () => {
    const t = setup();
    t.set(state());
    t.calls.length = 0;
    t.set(state({ phase: "seeking", position: AT + 900 }), 10);
    expect(t.calls).toEqual([]);
    t.set(state({ phase: "paused", position: AT + 900 }), 10);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.[0]).toBe("replace");
  });

  it("follows Back and Forward: stop without a moment, seek to another, start from a moment", () => {
    const t = setup();
    t.set(state());
    t.calls.length = 0;
    t.pop("");
    expect(t.commands.at(-1)).toBe("stop");
    t.pop("?at=2025-11-01T12:30:00Z");
    expect(t.commands.at(-1)).toMatch(/^(seek|start) /);
  });

  it("does not add an entry for what the address already says", () => {
    const t = setup();
    t.set(state());
    t.pop("");
    t.calls.length = 0;
    t.set(null);
    expect(t.calls).toEqual([]);
    t.pop("?at=2025-11-01T12:00:00Z");
    t.set(state({ position: Date.UTC(2025, 10, 1, 12) / 1000 }));
    expect(t.calls.every(([mode]) => mode === "replace")).toBe(true);
  });
});
