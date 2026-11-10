import { describe, expect, it } from "vitest";
import { formattersFor } from "./format.ts";
import { locales } from "./locale.ts";

const WINTER_2035 = Date.UTC(2026, 9, 25, 20, 35);
const SUMMER_2135 = Date.UTC(2026, 6, 1, 19, 35);
const NO_BREAK_SPACE = " ";

describe("clock", () => {
  it.each(locales)("%s shows 21:35 in Berlin time in winter and in summer", (locale) => {
    const { clock } = formattersFor(locale);
    expect(clock(WINTER_2035)).toBe("21:35");
    expect(clock(SUMMER_2135)).toBe("21:35");
  });

  it.each(locales)("%s keeps midnight as 00:05 on the 24 hour clock", (locale) => {
    expect(formattersFor(locale).clock(Date.UTC(2026, 6, 1, 22, 5))).toBe("00:05");
  });
});

describe("day", () => {
  it("writes the day and the month in the grammar of each language", () => {
    expect(formattersFor("en").day(WINTER_2035)).toBe(`25${NO_BREAK_SPACE}October`);
    expect(formattersFor("de").day(WINTER_2035)).toBe(`25.${NO_BREAK_SPACE}Oktober`);
    expect(formattersFor("pl").day(WINTER_2035)).toBe(`25${NO_BREAK_SPACE}października`);
  });

  it.each(locales)("%s never breaks inside the date", (locale) => {
    expect(formattersFor(locale).day(WINTER_2035)).not.toContain(" ");
  });
});

describe("count", () => {
  it("groups with a comma in English, a point in German and a no-break space in Polish", () => {
    expect(formattersFor("en").count(2665)).toBe("2,665");
    expect(formattersFor("de").count(2665)).toBe("2.665");
    expect(formattersFor("pl").count(2665)).toBe(`2${NO_BREAK_SPACE}665`);
  });

  it.each(locales)("%s groups four digit numbers as it groups longer ones", (locale) => {
    const { count } = formattersFor(locale);
    expect(count(1234)).toHaveLength(5);
    expect(count(1234567)).toHaveLength(9);
  });

  it.each(locales)("%s leaves numbers below one thousand alone", (locale) => {
    expect(formattersFor(locale).count(999)).toBe("999");
  });

  it("splits the group separator out so that the interface can narrow it", () => {
    for (const locale of locales) {
      const parts = formattersFor(locale).countParts(26650);
      expect(parts.map((part) => part.type)).toEqual(["integer", "group", "integer"]);
      expect(parts.map((part) => part.value).join("")).toBe(formattersFor(locale).count(26650));
    }
    expect(formattersFor("pl").countParts(26650)[1]?.value).toBe(NO_BREAK_SPACE);
  });

  it("keeps the original type of minus signs, decimals and fractions", () => {
    const types = formattersFor("de")
      .countParts(-1234.5)
      .map((part) => part.type);
    expect(types).toEqual(["minusSign", "integer", "group", "integer", "decimal", "fraction"]);
  });
});

describe("speed", () => {
  it("writes whole kilometres per hour with the unit of each language", () => {
    expect(formattersFor("en").speed(120)).toBe(`120${NO_BREAK_SPACE}km/h`);
    expect(formattersFor("de").speed(120)).toBe(`120${NO_BREAK_SPACE}km/h`);
    expect(formattersFor("pl").speed(120)).toBe(`120${NO_BREAK_SPACE}km/godz.`);
  });

  it.each(locales)("%s never breaks between the number and the unit", (locale) => {
    expect(formattersFor(locale).speed(35)).not.toContain(" ");
  });
});
