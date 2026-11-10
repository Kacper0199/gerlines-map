import { formattersFor } from "@gerlines/i18n";
import { statusCopyFor } from "@gerlines/i18n/status";
import { describe, expect, it } from "vitest";
import { STATUS_SAMPLE } from "./fixtures.ts";
import { type LiveTiming, statusView, timeLabel } from "./model.ts";

const en = statusCopyFor("en").status;
const format = formattersFor("en");
const AT = Date.parse(STATUS_SAMPLE.at);
const ANSWERED: LiveTiming = { now: AT, answeredAt: AT };
const text = (phrase: { text: string } | null) => phrase?.text ?? null;

describe("status view", () => {
  const view = statusView(STATUS_SAMPLE, en, format, ANSWERED);

  it("groups the sources by kind in a fixed order", () => {
    expect(view.groups.map((group) => [group.title, group.rows.map((row) => row.id)])).toEqual([
      ["Timetable", ["delfi-timetable"]],
      ["Realtime in Germany", ["delfi-realtime", "gtfsde-realtime"]],
      ["DB station boards", ["db-iris"]],
      ["Neighbouring countries", ["nl-ovapi", "pl-pkpic"]],
    ]);
  });

  it("names each state, the recorded and the map time in Berlin time, and a missing value as missing", () => {
    const rows = view.groups.flatMap((group) => group.rows);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId["delfi-timetable"]).toMatchObject({
      stateLabel: "Up to date",
      recorded: { figure: "20:02" },
      onMap: null,
      area: null,
    });
    expect(byId["gtfsde-realtime"]).toMatchObject({
      stateLabel: "Data is stale",
      recorded: { text: "Recorded 12:50", figure: "12:50" },
      onMap: { text: "On the map 12:58", figure: "12:58" },
    });
    expect(byId["db-iris"]).toMatchObject({
      stateLabel: "Not recorded",
      recorded: null,
      onMap: { text: "Not on the map", figure: null },
    });
    expect(byId["pl-pkpic"]).toMatchObject({ stateLabel: "Down", area: "Poland" });
  });

  it("leaves the map times out when the live engine gives no reading, instead of Not on the map", () => {
    for (const state of ["not_recorded", "down"] as const) {
      const unread = statusView(
        {
          ...STATUS_SAMPLE,
          live: { ...STATUS_SAMPLE.live, confirmedAt: null, frameAgeSeconds: null, state },
        },
        en,
        format,
        ANSWERED,
      );
      const rows = unread.groups.flatMap((group) => group.rows);
      expect(rows.map((row) => row.onMap)).toEqual(rows.map(() => null));
      expect(text(rows.find((row) => row.id === "gtfsde-realtime")?.recorded ?? null)).toBe(
        "Recorded 12:50",
      );
    }
  });

  it("states the live map's age in seconds, then its time, and says when it sends nothing", () => {
    expect(view.live).toEqual({
      state: "ok",
      stateLabel: "Up to date",
      detail: { text: "Last update 4 s ago", figure: "4" },
    });
    const late = statusView(
      {
        ...STATUS_SAMPLE,
        live: { ...STATUS_SAMPLE.live, frameAgeSeconds: 400, state: "stale" },
      },
      en,
      format,
      ANSWERED,
    );
    expect(late.live.detail).toEqual({ text: "Last update at 12:59", figure: "12:59" });
    const none = statusView(
      {
        ...STATUS_SAMPLE,
        live: { ...STATUS_SAMPLE.live, confirmedAt: null, frameAgeSeconds: null, state: "down" },
      },
      en,
      format,
      ANSWERED,
    );
    expect(none.live).toMatchObject({
      stateLabel: "Down",
      detail: { text: "The live map sends no updates", figure: null },
    });
    const unread = statusView(
      {
        ...STATUS_SAMPLE,
        live: {
          ...STATUS_SAMPLE.live,
          confirmedAt: null,
          frameAgeSeconds: null,
          state: "not_recorded",
        },
      },
      en,
      format,
      ANSWERED,
    );
    expect(unread.live).toMatchObject({
      stateLabel: "Not recorded",
      detail: { text: "No reading of the live map" },
    });
  });

  it("ages the server's reading by the time since the answer was read", () => {
    const later = (ms: number) =>
      statusView(STATUS_SAMPLE, en, format, { now: AT + ms, answeredAt: AT }).live;
    expect(later(20_400)).toMatchObject({ state: "ok", detail: { text: "Last update 24 s ago" } });
    expect(later(27_000)).toMatchObject({
      state: "stale",
      stateLabel: "Data is stale",
      detail: { text: "Last update 31 s ago" },
    });
    const cached = statusView(STATUS_SAMPLE, en, format, {
      now: AT + 30_000,
      answeredAt: AT + 18_000,
    }).live;
    expect(cached.detail.text).toBe("Last update 16 s ago");
  });

  it("takes this map's own newest frame first, also without a reading from the server", () => {
    const unread = {
      ...STATUS_SAMPLE,
      live: {
        ...STATUS_SAMPLE.live,
        confirmedAt: null,
        frameAgeSeconds: null,
        state: "down" as const,
      },
    };
    const own = (ageMs: number) =>
      statusView(unread, en, format, { now: AT, answeredAt: AT, mapFrameAt: AT - ageMs }).live;
    expect(own(2_000)).toEqual({
      state: "ok",
      stateLabel: "Up to date",
      detail: { text: "Last update 2 s ago", figure: "2" },
    });
    expect(own(45_000)).toMatchObject({ state: "stale", detail: { text: "Last update 45 s ago" } });
    expect(own(10 * 60_000).detail).toEqual({ text: "Last update at 12:50", figure: "12:50" });
  });

  it("takes the limits in the note from the answer, and the time of the answer", () => {
    expect(view.note).toContain("5 to 20 minutes");
    expect(view.asOf).toEqual({ text: "As of 13:00", figure: "13:00" });
  });

  it("speaks German and Polish", () => {
    const de = statusView(STATUS_SAMPLE, statusCopyFor("de").status, formattersFor("de"), ANSWERED);
    expect(de.groups[3]?.rows[0]?.area).toBe("Niederlande");
    const pl = statusView(STATUS_SAMPLE, statusCopyFor("pl").status, formattersFor("pl"), ANSWERED);
    expect(text(pl.groups[0]?.rows[0]?.recorded ?? null)).toBe("Zarejestrowano 5 listopada 20:02");
  });

  it("leaves the day out on the same Berlin day", () => {
    const at = Date.parse("2026-11-08T22:30:00Z");
    expect(timeLabel(Date.parse("2026-11-08T22:10:00Z"), at, format)).toBe("23:10");
    expect(timeLabel(Date.parse("2026-11-08T23:10:00Z"), at, format)).toBe("9 November 00:10");
  });
});
