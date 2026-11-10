import { expression, latest } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { nameText, routeRefText } from "./layer-kit.ts";

function evaluate(text: unknown, properties: Record<string, string>): unknown {
  const parsed = expression.createExpression(
    text,
    "text-field",
    latest.layout_symbol["text-field"] as never,
  );
  if (parsed.result !== "success") {
    throw new Error(JSON.stringify(parsed.value));
  }
  const value = parsed.value.evaluate({ zoom: 8 }, {
    type: "Point",
    properties,
  } as never);
  return typeof value === "object" && value !== null ? String(value) : value;
}

function label(language: string, properties: Record<string, string>): unknown {
  return evaluate(nameText(language), properties);
}

const WROCLAW = {
  name: "Wrocław",
  "name:latin": "Wrocław",
  "name:de": "Breslau",
  "name:pl": "Wrocław",
  "name:en": "Wrocław",
};
const COTTBUS = {
  name: "Cottbus - Chóśebuz",
  "name:latin": "Cottbus - Chóśebuz",
  "name:de": "Cottbus",
  "name:pl": "Chociebuż",
};
const BRUSSELS = {
  name: "Bruxelles - Brussel",
  "name:latin": "Bruxelles - Brussel",
  "name:de": "Brüssel",
  "name:en": "Brussels",
};
const MERANO = { name: "Merano - Meran", "name:latin": "Merano - Meran", "name:de": "Meran" };
const HELLEVOETSLUIS = {
  name: "Hellevoetsluis",
  "name:latin": "Hellevoetsluis",
  "name:de": "krankenhaus",
};
const ZGORZELEC = { name: "Zgorzelec", "name:latin": "Zgorzelec" };
const MUNICH = {
  name: "München",
  "name:latin": "München",
  "name:de": "München",
  "name:en": "Munich",
  "name:pl": "Monachium",
};

describe("place labels in German", () => {
  it("shows the local name abroad, never a German exonym", () => {
    expect(label("de", WROCLAW)).toBe("Wrocław");
    expect(label("de", BRUSSELS)).toBe("Bruxelles - Brussel");
    expect(label("de", HELLEVOETSLUIS)).toBe("Hellevoetsluis");
    expect(label("de", ZGORZELEC)).toBe("Zgorzelec");
  });

  it("takes the German part of a bilingual name", () => {
    expect(label("de", COTTBUS)).toBe("Cottbus");
    expect(label("de", MERANO)).toBe("Meran");
    expect(label("de", { name: "Biel/Bienne", "name:de": "Biel" })).toBe("Biel");
    expect(label("de", { name: "Bolzano / Bozen", "name:de": "Bozen" })).toBe("Bozen");
  });

  it("matches the German name against whole parts only, so Roma never becomes Rom", () => {
    expect(label("de", { name: "Roma", "name:latin": "Roma", "name:de": "Rom" })).toBe("Roma");
    expect(label("de", { name: "Brno - Brünn", "name:de": "Brünn" })).toBe("Brünn");
    expect(label("de", { name: "Bruneck - Brunico", "name:de": "Brun" })).toBe("Bruneck - Brunico");
  });

  it("shows German places by their name", () => {
    expect(label("de", MUNICH)).toBe("München");
  });
});

describe("place labels in English and Polish", () => {
  it("uses the name in the language, then the local Latin name, never a German fallback", () => {
    expect(label("en", MUNICH)).toBe("Munich");
    expect(label("pl", MUNICH)).toBe("Monachium");
    expect(label("pl", WROCLAW)).toBe("Wrocław");
    expect(label("en", ZGORZELEC)).toBe("Zgorzelec");
    expect(label("pl", HELLEVOETSLUIS)).toBe("Hellevoetsluis");
    expect(label("en", COTTBUS)).toBe("Cottbus - Chóśebuz");
  });

  it("never labels a German border town with the Polish name of its twin across the river", () => {
    expect(label("pl", { name: "Görlitz", "name:pl": "Zgorzelec" })).toBe("Görlitz");
    expect(label("pl", { name: "Guben", "name:pl": "Gubin" })).toBe("Guben");
    expect(label("pl", { name: "Lauta Dorf", "name:pl": "Lauta" })).toBe("Lauta Dorf");
    expect(label("pl", { name: "Zgorzelec", "name:pl": "Zgorzelec" })).toBe("Zgorzelec");
    expect(label("pl", { name: "Frankfurt (Oder)", "name:pl": "Frankfurt nad Odrą" })).toBe(
      "Frankfurt nad Odrą",
    );
  });
});

describe("motorway route numbers", () => {
  it("shows the first reference when a road carries several", () => {
    expect(evaluate(routeRefText(), { ref: "E25;E40;E42" })).toBe("E25");
    expect(evaluate(routeRefText(), { ref: "A 4" })).toBe("A 4");
  });
});
