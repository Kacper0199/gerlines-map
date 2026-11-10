import { describe, expect, it } from "vitest";
import {
  chooseSource,
  type HeldSource,
  SOURCE_SETTLE_S,
  SOURCE_SWITCH_AFTER_S,
  type SourceActivity,
  sourceGroup,
  sourceRank,
} from "./source-priority.ts";

const T = 1_792_000_000;

function seen(sourceId: string, firstSeen: number, lastSeen = firstSeen): SourceActivity {
  return { sourceId, firstSeen, lastSeen };
}

describe("sourceGroup", () => {
  it("groups the known realtime sources", () => {
    expect(sourceGroup("delfi-gtfs-rt")).toBe("delfi");
    expect(sourceGroup("delfi-gtfs-rt-deincr")).toBe("delfi");
    expect(sourceGroup("gtfsde-rt")).toBe("gtfsde");
    expect(sourceGroup("vbb-gtfs-rt")).toBe("regional");
    expect(sourceGroup("vbn-gtfs-rt")).toBe("regional");
    expect(sourceGroup("db-iris")).toBe("iris");
    expect(sourceGroup("cz-czptt-gtfs-rt")).toBe("neighbour");
    expect(sourceGroup("fr-sncf-gtfs-rt")).toBe("neighbour");
    expect(sourceGroup("some-new-feed")).toBe("neighbour");
  });
});

describe("sourceRank (D-041 item 3)", () => {
  it("puts IRIS, then gtfs.de, then DELFI first for hsr and ld", () => {
    for (const category of ["hsr", "ld"]) {
      const order = ["db-iris", "gtfsde-rt", "delfi-gtfs-rt", "vbb-gtfs-rt", "cz-czptt-gtfs-rt"];
      const ranks = order.map((source) => sourceRank(category, source));
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      expect(new Set(ranks).size).toBe(order.length);
    }
  });

  it("puts DELFI, then gtfs.de, then VBB and the neighbours first for every other category", () => {
    for (const category of ["night", "rfast", "reg", "sbahn", "urban", "bus", "other", null]) {
      const order = ["delfi-gtfs-rt", "gtfsde-rt", "vbb-gtfs-rt", "cz-czptt-gtfs-rt", "db-iris"];
      const ranks = order.map((source) => sourceRank(category, source));
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
  });
});

describe("chooseSource", () => {
  it("returns null without any source", () => {
    expect(chooseSource("reg", null, [], T)).toBeNull();
  });

  it("picks the best ranked source that has reported", () => {
    const activity = [seen("gtfsde-rt", T - 30), seen("delfi-gtfs-rt", T - 20)];
    expect(chooseSource("reg", null, activity, T)).toEqual({ sourceId: "delfi-gtfs-rt", since: T });
    expect(chooseSource("hsr", null, activity, T)).toEqual({ sourceId: "gtfsde-rt", since: T });
  });

  it("ignores sources first seen after now", () => {
    expect(chooseSource("reg", null, [seen("delfi-gtfs-rt", T + 5)], T)).toBeNull();
  });

  it("keeps the held source when a better one appears after the settle window", () => {
    const held: HeldSource = { sourceId: "gtfsde-rt", since: T - SOURCE_SETTLE_S - 1 };
    const activity = [seen("gtfsde-rt", held.since, T - 10), seen("delfi-gtfs-rt", T - 5)];
    expect(chooseSource("reg", held, activity, T)).toBe(held);
  });

  it("lets a fresh better ranked source displace IRIS outside hsr and ld at any time", () => {
    const held: HeldSource = { sourceId: "db-iris", since: T - 3_600 };
    for (const category of ["night", "rfast", "reg", "sbahn", null]) {
      const activity = [seen("db-iris", held.since, T - 10), seen("delfi-gtfs-rt", T - 5)];
      expect(chooseSource(category, held, activity, T)).toEqual({
        sourceId: "delfi-gtfs-rt",
        since: T,
      });
      const stale = [seen("db-iris", held.since, T - 10), seen("gtfsde-rt", T - 2_000)];
      expect(chooseSource(category, held, stale, T)).toBe(held);
    }
    for (const category of ["hsr", "ld"]) {
      const activity = [seen("db-iris", held.since, T - 10), seen("gtfsde-rt", T - 5)];
      expect(chooseSource(category, held, activity, T)).toBe(held);
    }
  });

  it("upgrades to a better source inside the settle window", () => {
    const held: HeldSource = { sourceId: "gtfsde-rt", since: T - 30 };
    const activity = [seen("gtfsde-rt", T - 30), seen("delfi-gtfs-rt", T - 5)];
    expect(chooseSource("reg", held, activity, T)).toEqual({
      sourceId: "delfi-gtfs-rt",
      since: T - 30,
    });
  });

  it("switches only after the held source has been quiet for 15 minutes while another reported", () => {
    const held: HeldSource = { sourceId: "delfi-gtfs-rt", since: T - 3600 };
    const quiet = T - SOURCE_SWITCH_AFTER_S;
    const stillFresh = [seen("delfi-gtfs-rt", T - 3600, quiet + 1), seen("gtfsde-rt", T - 3000, T)];
    expect(chooseSource("reg", held, stillFresh, T)).toBe(held);
    const stale = [seen("delfi-gtfs-rt", T - 3600, quiet), seen("gtfsde-rt", T - 3000, T)];
    expect(chooseSource("reg", held, stale, T)).toEqual({ sourceId: "gtfsde-rt", since: T });
  });

  it("keeps a quiet held source when no other source reported in the last 15 minutes", () => {
    const held: HeldSource = { sourceId: "delfi-gtfs-rt", since: T - 7200 };
    const activity = [
      seen("delfi-gtfs-rt", T - 7200, T - 3600),
      seen("gtfsde-rt", T - 7000, T - 2000),
    ];
    expect(chooseSource("reg", held, activity, T)).toBe(held);
  });

  it("among fresh sources picks the best ranked when switching", () => {
    const held: HeldSource = { sourceId: "vbb-gtfs-rt", since: T - 7200 };
    const activity = [
      seen("vbb-gtfs-rt", T - 7200, T - 2000),
      seen("cz-czptt-gtfs-rt", T - 600, T),
      seen("gtfsde-rt", T - 600, T - 60),
    ];
    expect(chooseSource("reg", held, activity, T)).toEqual({ sourceId: "gtfsde-rt", since: T });
  });

  it("drops a held source that no longer reports at all", () => {
    const held: HeldSource = { sourceId: "vbb-gtfs-rt", since: T - 7200 };
    expect(chooseSource("reg", held, [seen("gtfsde-rt", T - 60)], T)).toEqual({
      sourceId: "gtfsde-rt",
      since: T,
    });
  });

  it("breaks rank ties by source id so the choice is deterministic", () => {
    const activity = [seen("pl-pkpic-gtfs-rt", T - 1), seen("cz-czptt-gtfs-rt", T - 2)];
    expect(chooseSource("reg", null, activity, T)?.sourceId).toBe("cz-czptt-gtfs-rt");
    expect(chooseSource("reg", null, [...activity].reverse(), T)?.sourceId).toBe(
      "cz-czptt-gtfs-rt",
    );
  });
});

describe("chooseSource with a quiet better source", () => {
  it("settles on the active worse source and never flips back while the better one stays quiet", () => {
    const quietSince = T - SOURCE_SWITCH_AFTER_S - 60;
    let held: HeldSource | null = { sourceId: "delfi-gtfs-rt", since: T - 3600 };
    const choices: string[] = [];
    for (let now = T; now <= T + 600; now += 30) {
      const activity = [
        seen("delfi-gtfs-rt", T - 7200, quietSince),
        seen("gtfsde-rt", T - 7200, now),
      ];
      held = chooseSource("reg", held, activity, now);
      choices.push(held?.sourceId ?? "none");
    }
    expect(new Set(choices)).toEqual(new Set(["gtfsde-rt"]));
    expect(held).toEqual({ sourceId: "gtfsde-rt", since: T });
  });

  it("returns to the better source once it reports again, inside or after the settle window", () => {
    const held: HeldSource = { sourceId: "gtfsde-rt", since: T };
    const back = [seen("delfi-gtfs-rt", T - 7200, T + 60), seen("gtfsde-rt", T - 7200, T + 60)];
    expect(chooseSource("reg", held, back, T + 60)).toEqual({
      sourceId: "delfi-gtfs-rt",
      since: T,
    });
    expect(chooseSource("reg", held, back, T + SOURCE_SETTLE_S + 60)).toBe(held);
  });

  it("gives a stateless reader the best active source before a quiet better one", () => {
    const activity = [
      seen("delfi-gtfs-rt", T - 7200, T - SOURCE_SWITCH_AFTER_S - 1),
      seen("gtfsde-rt", T - 100, T),
    ];
    expect(chooseSource("reg", null, activity, T)?.sourceId).toBe("gtfsde-rt");
    const allQuiet = [
      seen("delfi-gtfs-rt", T - 7200, T - 2000),
      seen("gtfsde-rt", T - 7200, T - 2000),
    ];
    expect(chooseSource("reg", null, allQuiet, T)?.sourceId).toBe("delfi-gtfs-rt");
  });
});
