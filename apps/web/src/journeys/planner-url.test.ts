import { describe, expect, it } from "vitest";
import { parseUrlView, writeUrlView } from "../url/url-state.ts";
import {
  CLOSED_PLANNER,
  type PlannerUrl,
  parsePlannerUrl,
  sameSearch,
  writePlannerUrl,
} from "./planner-url.ts";

const BERLIN = "8c1b6a9e-0d6f-5c1d-9a51-6f3f1f3a2b10";
const MUENCHEN = "1d1b6a9e-0d6f-5c1d-9a51-6f3f1f3a2b11";

const FULL: PlannerUrl = {
  open: true,
  from: BERLIN,
  to: MUENCHEN,
  time: "2026-11-10T07:00",
  arriveBy: true,
  categories: ["rfast", "reg"],
  operator: "metronom",
  selected: "0123456789abcdef",
};

describe("planner address", () => {
  it("round trips every field", () => {
    const search = writePlannerUrl("", FULL);
    expect(search).toBe(
      `?plan=1&jfrom=${BERLIN}&jto=${MUENCHEN}&jtime=2026-11-10T07:00&jarr=1&jcat=rfast,reg&jop=metronom&jsel=0123456789abcdef`,
    );
    expect(parsePlannerUrl(search)).toEqual(FULL);
  });

  it("is closed without plan=1 whatever else the address holds", () => {
    expect(parsePlannerUrl(`?jfrom=${BERLIN}`)).toEqual({ ...CLOSED_PLANNER, from: BERLIN });
    expect(parsePlannerUrl("?lang=de")).toEqual(CLOSED_PLANNER);
    expect(writePlannerUrl(`?plan=1&jfrom=${BERLIN}&lang=de`, CLOSED_PLANNER)).toBe("?lang=de");
  });

  it("keeps a planner set aside by another panel without plan=1", () => {
    const aside = { ...FULL, open: false };
    const search = writePlannerUrl("?lang=de", aside);
    expect(search).toBe(
      `?lang=de&jfrom=${BERLIN}&jto=${MUENCHEN}&jtime=2026-11-10T07:00&jarr=1&jcat=rfast,reg&jop=metronom&jsel=0123456789abcdef`,
    );
    expect(parsePlannerUrl(search)).toEqual(aside);
    expect(sameSearch(aside, FULL)).toBe(false);
  });

  it("drops what it cannot read and keeps the rest", () => {
    const parsed = parsePlannerUrl(
      `?plan=1&jfrom=nope&jto=${MUENCHEN.toUpperCase()}&jtime=2026-02-30T07:00&jcat=ice,reg&jop=%22x%22&jsel=XYZ`,
    );
    expect(parsed).toEqual({ ...CLOSED_PLANNER, open: true, to: MUENCHEN });
  });

  it("reads an operator list as the form and the server take it, and refuses what the server would", () => {
    const read = (value: string) =>
      parsePlannerUrl(`?plan=1&jop=${encodeURIComponent(value)}`).operator;
    expect(read("erixx, metronom")).toBe("erixx, metronom");
    expect(read("DB Regio AG")).toBe("DB Regio AG");
    expect(read("Länderbahn,ODEG")).toBe("Länderbahn,ODEG");
    expect(read("a,b,c,d,e,f")).toBeNull();
    expect(read("x")).toBeNull();
    expect(read("erixx,")).toBeNull();
    expect(read(`${"a".repeat(41)}`)).toBeNull();
    const back = writePlannerUrl("", { ...FULL, operator: "erixx, metronom" });
    expect(parsePlannerUrl(back).operator).toBe("erixx, metronom");
  });

  it("reads every category, or none, as all of them", () => {
    expect(parsePlannerUrl("?plan=1&jcat=hsr,ld,night,rfast,reg,sbahn").categories).toBeNull();
    expect(parsePlannerUrl("?plan=1&jcat=").categories).toBeNull();
    expect(parsePlannerUrl("?plan=1&jcat=reg,hsr").categories).toEqual(["hsr", "reg"]);
  });

  it("lives beside the map view parameters without touching them", () => {
    const view = `?train=${BERLIN}&land=DE-BY&map=8.00,50.00000,10.00000&lang=pl`;
    const both = writePlannerUrl(view, FULL);
    expect(parseUrlView(both)).toEqual(parseUrlView(view));
    expect(parsePlannerUrl(writeUrlView(both, parseUrlView(view)))).toEqual(FULL);
  });

  it("compares searches without the shown journey", () => {
    expect(sameSearch(FULL, { ...FULL, selected: null })).toBe(true);
    expect(sameSearch(FULL, { ...FULL, time: "2026-11-10T08:00" })).toBe(false);
    expect(sameSearch(FULL, { ...FULL, categories: ["reg", "rfast"] })).toBe(false);
  });
});
