import { describe, expect, it } from "vitest";
import { berlinPlanSlot, irisTimeToIso } from "./berlin-time.ts";
import { documentProblem } from "./document.ts";
import { parseXml, scanXml, XML_MAX_ELEMENTS, XmlError } from "./xml.ts";

describe("parseXml", () => {
  it("reads elements, both quote styles, entities, self-closing tags and text", () => {
    const root = parseXml(
      "<?xml version='1.0'?><!-- c --><a x='1' y=\"&amp;&#228;&#x2013;\"><b/><c>t&lt;<![CDATA[<raw>]]></c></a>",
    );
    expect(root.name).toBe("a");
    expect(root.attributes).toEqual({ x: "1", y: "&ä–" });
    expect(root.children.map((child) => child.name)).toEqual(["b", "c"]);
    expect(root.children[1]?.text).toBe("t<<raw>");
  });

  it.each([
    ["a document type", '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
    ["an unknown entity", "<a>&x;</a>"],
    ["a bare ampersand", "<a b='1 & 2'/>"],
    ["mismatched tags", "<a><b></a></b>"],
    ["an unclosed element", "<a><b/>"],
    ["two roots", "<a/><b/>"],
    ["a duplicate attribute", "<a x='1' x='2'/>"],
    ["text outside the root", "<a/>junk"],
    ["no root", "<?xml version='1.0'?>"],
    ["an inherited name as an entity", "<a>&toString;</a>"],
    ["the prototype as an entity", "<a b='&__proto__;'/>"],
    ["constructor as an entity", "<a>&constructor;</a>"],
  ])("refuses %s", (_case, input) => {
    expect(() => parseXml(input)).toThrow(XmlError);
    expect(() => scanXml(input)).toThrow(XmlError);
  });

  it("refuses a document with more elements than the cap", () => {
    const wide = (count: number) => `<a>${"<b/>".repeat(count - 1)}</a>`;
    expect(parseXml(wide(10), { maxElements: 10 }).children).toHaveLength(9);
    expect(() => parseXml(wide(11), { maxElements: 10 })).toThrow(/more than 10 elements/);
    expect(XML_MAX_ELEMENTS).toBeLessThanOrEqual(200_000);
    expect(() => parseXml(wide(XML_MAX_ELEMENTS + 1))).toThrow(XmlError);
  });
});

describe("scanXml and the document check", () => {
  const timetable = (inner: string) =>
    `<?xml version="1.0"?><timetable station="X">${inner}</timetable>`;

  it("names the root of a well-formed document without building its tree", () => {
    const huge = timetable("<s id='1'><ar pt='2610260009'/></s>".repeat(XML_MAX_ELEMENTS));
    expect(scanXml(huge)).toEqual({ root: "timetable", elements: 2 * XML_MAX_ELEMENTS + 1 });
    expect(documentProblem("application/xml", Buffer.from(huge), "timetable")).toBeNull();
  }, 30_000);

  it("still finds a wrong root, a cut document and a document type in the check", () => {
    expect(
      documentProblem("application/xml", Buffer.from("<html>down</html>"), "timetable"),
    ).toMatch(/root is <html>, expected <timetable>/);
    expect(documentProblem("application/xml", Buffer.from(timetable("<s>")), "timetable")).toMatch(
      /not well-formed/,
    );
    expect(
      documentProblem("application/xml", Buffer.from('<!DOCTYPE t [<!ENTITY x "y">]><t/>'), "t"),
    ).toMatch(/document type/);
  });
});

describe("Berlin time", () => {
  it("builds the plan slot in German local time across the autumn switch", () => {
    expect(berlinPlanSlot(Date.parse("2026-10-25T23:06:00Z"))).toEqual({
      date: "261026",
      hour: "00",
    });
    expect(berlinPlanSlot(Date.parse("2026-10-24T22:30:00Z"))).toEqual({
      date: "261025",
      hour: "00",
    });
    expect(berlinPlanSlot(Date.parse("2026-07-01T12:00:00Z"))).toEqual({
      date: "260701",
      hour: "14",
    });
  });

  it("converts IRIS times to UTC, the earlier instant in the repeated hour", () => {
    expect(irisTimeToIso("2610260009")).toBe("2026-10-25T23:09:00.000Z");
    expect(irisTimeToIso("2607011400")).toBe("2026-07-01T12:00:00.000Z");
    expect(irisTimeToIso("2610250230")).toBe("2026-10-25T00:30:00.000Z");
    expect(irisTimeToIso("2603290230")).toBe("2026-03-29T00:30:00.000Z");
    expect(irisTimeToIso("26102600")).toBeNull();
    expect(irisTimeToIso("2613260000")).toBeNull();
    expect(irisTimeToIso(undefined)).toBeNull();
  });

  it("reads the repeated autumn hour by the answer's time and refuses impossible dates", () => {
    const summer = "2026-10-25T00:30:00.000Z";
    const winter = "2026-10-25T01:30:00.000Z";
    expect(irisTimeToIso("2610250230", Date.parse("2026-10-25T00:10:00Z"))).toBe(summer);
    expect(irisTimeToIso("2610250230", Date.parse("2026-10-25T01:10:00Z"))).toBe(winter);
    expect(irisTimeToIso("2610250230", Date.parse("2026-10-25T03:00:00Z"))).toBe(winter);
    expect(irisTimeToIso("2610250330", Date.parse("2026-10-25T00:10:00Z"))).toBe(
      "2026-10-25T02:30:00.000Z",
    );
    expect(irisTimeToIso("2602300800")).toBeNull();
    expect(irisTimeToIso("2504310800")).toBeNull();
    expect(irisTimeToIso("2802290800")).toBe("2028-02-29T07:00:00.000Z");
  });
});
