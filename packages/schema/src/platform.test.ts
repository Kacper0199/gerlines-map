import { describe, expect, it } from "vitest";
import { isDistrictStopNumber, normalizePlatform } from "./platform.ts";

const DELFI_PLATFORMS: readonly (readonly [string, string])[] = [
  ["Gl. 1", "1"],
  ["Gl1", "1"],
  ["Gl. 2", "2"],
  ["Gl2", "2"],
  ["Gl3", "3"],
  ["Gl. 3", "3"],
  ["Gl4", "4"],
  ["1a", "1a"],
  ["A", "A"],
  ["2a", "2a"],
  ["Gl 1", "1"],
  ["Gl 2", "2"],
  ["B", "B"],
  ["Gl.1", "1"],
  ["Gl5", "5"],
  ["Gl6", "6"],
  ["D", "D"],
  ["Gl. 4", "4"],
  ["Gl. 5", "5"],
  ["Gl.3", "3"],
  ["Gl.2", "2"],
  ["Gl.4", "4"],
  ["3A", "3A"],
  ["2A", "2A"],
  ["Gl.13", "13"],
  ["Gl.5", "5"],
  ["Gl.14", "14"],
  ["#1", "1"],
  ["Gl. 7", "7"],
  ["#2", "2"],
  ["Gl.12", "12"],
  ["5b", "5b"],
  ["5a", "5a"],
  ["1a_96", "1a"],
  ["7/8", "7-8"],
  ["G1", "1"],
  ["Gl3-S", "3"],
  ["Gl. 6", "6"],
  ["G2", "2"],
  ["Gl. 8", "8"],
  ["9/10", "9-10"],
  ["Gl.10", "10"],
  ["F", "F"],
  ["C", "C"],
  ["3(U)", "3"],
  ["4(U)", "4"],
  ["6b", "6b"],
  ["5/6", "5-6"],
  ["102-2", "102-2"],
  ["G3", "3"],
  ["Gl.9", "9"],
  ["6a", "6a"],
  ["Bstg 2", "2"],
  ["Gl.1a", "1a"],
  ["Gl.11", "11"],
  ["E", "E"],
  ["Bf1", "Bf1"],
  ["Gl1a", "1a"],
  ["2(U)", "2"],
  ["101-2", "101-2"],
  ["8A", "8A"],
  ["B2", "B2"],
  ["Bstg. 1", "1"],
  ["7A", "7A"],
  ["2a_96", "2a"],
  ["Gl. 9", "9"],
  ["Gl7", "7"],
  ["G4", "4"],
  ["H", "H"],
  ["1(U)", "1"],
  ["Gl.7", "7"],
  ["Gl.8", "8"],
  ["2b", "2b"],
  ["G5", "5"],
  ["GL 3", "3"],
  ["2b_76", "2b"],
  ["1b", "1b"],
  ["1b_76", "1b"],
  ["GL. 2", "2"],
  ["Gl.2a", "2a"],
  ["4b", "4b"],
  ["Gl.1b", "1b"],
  ["Bstg. 3", "3"],
  ["Gl.3a", "3a"],
  ["GL.1", "1"],
  ["Gl.3b", "3b"],
  ["Gl.2b", "2b"],
  ["Bf2", "Bf2"],
  ["Gl. O", "O"],
  ["Gl. W", "W"],
  ["3B", "3B"],
  ["2B", "2B"],
  ["7B", "7B"],
  ["5S", "5S"],
  ["GL.4", "4"],
  ["Bstg 7", "7"],
  ["4A", "4A"],
  ["5A", "5A"],
  ["1S", "1S"],
  ["4a", "4a"],
  ["1B", "1B"],
  ["3a", "3a"],
  ["B1", "B1"],
  ["8b", "8b"],
  ["R", "R"],
  ["4B", "4B"],
  ["1", "1"],
  ["12", "12"],
  ["101", "101"],
];

const DELFI_STOP_CODES: readonly string[] = [
  "DB",
  "SEinw",
  "SAusw",
  "S-Mue",
  "SBahn",
  "DB1",
  "S-Fre",
  "DB2",
  "S-Tut",
  "RiMue",
  "Gleis",
  "S-Her",
  "RiHer",
  "DB3",
  "Sausw",
  "RiMam",
  "SEV A",
  "SEV B",
  "SMue3",
  "SMue",
  "Seinw",
  "Mue3",
  "S-Gel",
  "DB4",
  "SEVIn",
  "TS",
  "TN",
  "Rosen",
  "S-Pet",
  "GN",
  "Mue2",
  "GS",
  "SEV 2",
  "SEV-F",
  "Gel3",
  "SEV-M",
  "BN",
  "RiAlt",
  "S-Wol",
  "S-Alt",
  "CS",
  "CN",
  "DB5",
  "RiDAH",
  "BO",
  "RiN",
  "BW",
  "Gel2",
  "TO",
  "TW",
  "BS2",
  "RiS",
  "GeoDB",
  "LGB",
  "TW2",
  "RiO",
];

const NEIGHBOUR_PLATFORMS: readonly (readonly [string, string])[] = [
  ["Gl. 2", "2"],
  ["Gl. 1", "1"],
  ["Gl.1a", "1a"],
  ["Gl.2b", "2b"],
  ["Gl.13", "13"],
  ["Gl.2a", "2a"],
  ["Voie 3", "3"],
  ["voie 12", "12"],
  ["Quai 2", "2"],
  ["Peron II, tor 3", "3"],
  ["peron 3", "3"],
  ["tor 2", "2"],
  ["Tor 4a", "4a"],
  ["kolej 5", "5"],
  ["nástupiště 2, kolej 4", "4"],
  ["Spoor 7a", "7a"],
  ["Spor 3", "3"],
  ["Perron 1", "1"],
  ["Binario 1", "1"],
  ["Bin. 2", "2"],
  ["Platform 9", "9"],
  ["Pl. 3", "3"],
  ["Track 5", "5"],
  ["Steig 4", "4"],
  ["Bahnsteig 6", "6"],
  ["Gleis 4a", "4a"],
  ["Gleis 7", "7"],
];

const IRIS_AND_ROUTER_PLATFORMS: readonly (readonly [string, string])[] = [
  ["11 D-G", "11 D-G"],
  ["19", "19"],
  ["Pos. 4", "4"],
  ["Pos. 12", "12"],
  ["1 (U2)", "1"],
  ["1 (U1/U3)", "1"],
  ["2 (U9)", "2"],
  ["U2", "U2"],
];

const OTHER_SHAPES: readonly (readonly [string, string])[] = [
  ["4 a", "4a"],
  ["  Gl.  7 ", "7"],
  ["10 A-D", "10 A-D"],
  ["10 A–D", "10 A-D"],
  ["Gl. 10 A-D", "10 A-D"],
  ["5 D-G", "5 D-G"],
  ["Gleis 4a Abschnitt A-C", "4a A-C"],
  ["Gleis 12 Sektor B", "12 B"],
  ["1-2", "1-2"],
  ["1 - 2", "1-2"],
  ["13a-c", "13a-c"],
  ["A1", "A1"],
  ["1 Süd", "1 Süd"],
  ["Gleis 1 Süd", "1 Süd"],
  ["Pl. 2", "2"],
  ["II", "II"],
  ["Peron IV", "IV"],
  ["1/3", "1/3"],
];

describe("normalizePlatform", () => {
  it.each(DELFI_PLATFORMS)("reads the DELFI platform code %j as %j", (raw, platform) => {
    expect(normalizePlatform(raw)).toBe(platform);
  });

  it.each(DELFI_STOP_CODES)("drops the DELFI stop code %j, which is no platform", (raw) => {
    expect(normalizePlatform(raw)).toBeNull();
  });

  it.each(NEIGHBOUR_PLATFORMS)("reads the neighbour platform %j as %j", (raw, platform) => {
    expect(normalizePlatform(raw)).toBe(platform);
  });

  it.each(IRIS_AND_ROUTER_PLATFORMS)("reads the IRIS or router track %j as %j", (raw, platform) => {
    expect(normalizePlatform(raw)).toBe(platform);
  });

  it.each(OTHER_SHAPES)("reads %j as %j", (raw, platform) => {
    expect(normalizePlatform(raw)).toBe(platform);
  });

  it.each([null, undefined, "", "  "])("keeps an empty value %j as null", (raw) => {
    expect(normalizePlatform(raw)).toBeNull();
  });

  const everyValue = [
    ...DELFI_PLATFORMS,
    ...NEIGHBOUR_PLATFORMS,
    ...IRIS_AND_ROUTER_PLATFORMS,
    ...OTHER_SHAPES,
  ].map(([raw]) => raw);

  it("reads its own output unchanged", () => {
    for (const raw of [...everyValue, ...DELFI_STOP_CODES]) {
      const once = normalizePlatform(raw);
      expect(normalizePlatform(once), raw).toBe(once);
    }
  });

  it("never leaves a word for platform or track in front of the value", () => {
    const label =
      /^(?:gleis|gl|g(?=\d)|bahnsteig|bstg|steig|pl|platform|track|tor|peron|kolej|voie|quai|spoor|spor|binario|bin|pos|#)\b/iu;
    for (const raw of everyValue) {
      expect(normalizePlatform(raw) ?? "", raw).not.toMatch(label);
    }
  });
});

describe("normalizePlatform with the stop's DHID", () => {
  const VRS_AND_OWL: readonly [string, string][] = [
    ["87", "de:05315:11201:7:75"],
    ["83", "de:05315:11201"],
    ["74", "de:05315:19101:7:71"],
    ["91", "de:05315:11901:7:79"],
    ["78", "de:05314:61101:7:71"],
    ["91", "de:05711:5500:91:91"],
    ["98", "de:05711:5500:94:98"],
    ["913", "de:05758:1741:93:913"],
    ["Gl. 87", "de:05315:11201:7:75"],
  ];

  it.each(VRS_AND_OWL)("drops the stop number %j at %s, which is no track", (raw, dhid) => {
    expect(normalizePlatform(raw, dhid)).toBeNull();
  });

  it.each([
    ["5", "de:05315:11201", "5"],
    ["11", "de:05315:16601:7:71", "11"],
    ["G2", "de:05774:7000:92:G2", "2"],
    ["104", "de:06412:7010:2:1", "104"],
    ["101", "de:08212:90:1:101", "101"],
    ["87", "de:09162:5:47:87", "87"],
    ["87", null, "87"],
    ["87", "not a dhid", "87"],
  ] as const)("keeps %j at %s as %j", (raw, dhid, platform) => {
    expect(normalizePlatform(raw, dhid)).toBe(platform);
  });

  it.each(VRS_AND_OWL)("calls %j at %s a district stop number", (raw, dhid) => {
    expect(isDistrictStopNumber(raw, dhid)).toBe(true);
  });

  it.each([
    ["5", "de:05315:11201"],
    ["87", "de:09162:5:47:87"],
    ["87", null],
    ["DB", "de:05315:11201"],
    ["", "de:05315:11201"],
    [null, "de:05315:11201"],
  ] as const)("does not call %j at %s a district stop number", (raw, dhid) => {
    expect(isDistrictStopNumber(raw, dhid)).toBe(false);
  });

  it.each([
    ...VRS_AND_OWL,
    ["5", "de:05315:11201"],
    ["87", "de:09162:5:47:87"],
    ["Gl. 4", null],
    ["DB", "de:05315:11201"],
  ] as const)("agrees with normalizePlatform for %j at %s", (raw, dhid) => {
    const dropped = normalizePlatform(raw) !== null && normalizePlatform(raw, dhid) === null;
    expect(isDistrictStopNumber(raw, dhid)).toBe(dropped);
  });
});
