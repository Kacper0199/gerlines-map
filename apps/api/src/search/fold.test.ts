import { describe, expect, it } from "vitest";
import { compactOf, foldText, tokensOf, wordsOf } from "./fold.ts";

describe("foldText", () => {
  it("meets umlauts and their two-letter spellings in one form", () => {
    expect(foldText("München")).toBe(foldText("Muenchen"));
    expect(foldText("Köln")).toBe(foldText("Koeln"));
    expect(foldText("Gießen")).toBe(foldText("Giessen"));
    expect(foldText("Bärwalde")).toBe(foldText("Baerwalde"));
    expect(foldText("MÜNSTER")).toBe("munster");
  });

  it("drops Polish and other diacritics, including the ł that has no decomposition", () => {
    expect(foldText("Łódź")).toBe("lodz");
    expect(foldText("Świnoujście")).toBe("swinoujscie");
    expect(foldText("Děčín hl.n.")).toBe("decin hl n");
  });

  it("turns punctuation into single spaces and trims", () => {
    expect(foldText("  Frankfurt (Main)  Hbf ")).toBe("frankfurt main hbf");
    expect(foldText("S+U Alexanderplatz")).toBe("s u alexanderplatz");
  });

  it("removes control characters and keeps digits", () => {
    expect(foldText("ICE\u0000 693​")).toBe("ice 693");
  });
});

describe("tokensOf", () => {
  it("adds the long form of Hbf and Bf so a typed Hauptbahnhof finds the short name", () => {
    expect(tokensOf("Köln Hbf")).toEqual(["koln", "hbf", "hauptbahnhof"]);
    expect(tokensOf("Hamburg-Altona Bf")).toEqual(["hamburg", "altona", "bf", "bahnhof"]);
  });

  it("adds the short form after a spelled out one so a typed Hbf finds Hauptbahnhof", () => {
    expect(tokensOf("Stralsund Hauptbahnhof")).toEqual(["stralsund", "hauptbahnhof", "hbf"]);
    expect(tokensOf("Neustadt Bahnhof")).toEqual(["neustadt", "bahnhof", "bf"]);
    expect(tokensOf("Hauptstraße")).toEqual(["hauptstrasse"]);
  });
});

describe("wordsOf", () => {
  it("keeps only the words that were typed", () => {
    expect(wordsOf("Stralsund Hbf")).toEqual(["stralsund", "hbf"]);
    expect(wordsOf("RE1")).toEqual(["re", "1"]);
  });

  it("splits letters from digits so RE1 and RE 1 give the same tokens", () => {
    expect(tokensOf("RE1")).toEqual(["re", "1"]);
    expect(tokensOf("RE 1")).toEqual(["re", "1"]);
  });
});

describe("compactOf", () => {
  it("joins the folded text without spaces", () => {
    expect(compactOf("ICE 693")).toBe("ice693");
    expect(compactOf("S 41")).toBe("s41");
  });
});
