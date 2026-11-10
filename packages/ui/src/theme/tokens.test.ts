import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { themeCss } from "./theme-css.ts";
import {
  COLOR_TOKENS,
  categoryColor,
  colorValue,
  ROUNDED_TOKENS,
  SPACING_TOKENS,
  TYPOGRAPHY_TOKENS,
} from "./tokens.ts";

const designMarkdown = readFileSync(new URL("../../../../DESIGN.md", import.meta.url), "utf8");
const generatedCss = readFileSync(
  new URL("../styles/theme.generated.css", import.meta.url),
  "utf8",
);

type Section = "colors" | "typography" | "rounded" | "spacing" | "other";

interface FrontMatter {
  colors: Map<string, string>;
  typography: Map<string, Record<string, string>>;
  rounded: Map<string, number>;
  spacing: Map<string, number>;
}

function sectionOf(line: string): Section {
  const name = line.replace(":", "").trim();
  return name === "colors" || name === "typography" || name === "rounded" || name === "spacing"
    ? name
    : "other";
}

function parseInlineMap(body: string): Record<string, string> {
  return Object.fromEntries(
    body.split(",").map((pair) => {
      const [key, ...rest] = pair.split(":");
      return [(key ?? "").trim(), rest.join(":").trim()];
    }),
  );
}

function readEntry(section: Section, line: string): [string, string] | undefined {
  const patterns: Partial<Record<Section, RegExp>> = {
    colors: /^\s+([a-z0-9-]+):\s*"(#[0-9A-Fa-f]{6})"/,
    typography: /^\s+([a-z0-9-]+):\s*\{(.*)\}\s*$/,
    rounded: /^\s+([a-z0-9-]+):\s*(\d+)px/,
    spacing: /^\s+([a-z0-9-]+):\s*(\d+)px/,
  };
  const match = patterns[section]?.exec(line);
  return match?.[1] && match[2] ? [match[1], match[2]] : undefined;
}

function parseFrontMatter(markdown: string): FrontMatter {
  const block = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
  const result: FrontMatter = {
    colors: new Map(),
    typography: new Map(),
    rounded: new Map(),
    spacing: new Map(),
  };
  let section: Section = "other";
  for (const line of block.split("\n")) {
    if (/^\S/.test(line)) {
      section = sectionOf(line);
      continue;
    }
    const entry = readEntry(section, line);
    if (!entry) {
      continue;
    }
    const [name, value] = entry;
    if (section === "colors") {
      result.colors.set(name, value.toUpperCase());
    } else if (section === "typography") {
      result.typography.set(name, parseInlineMap(value));
    } else if (section === "rounded" || section === "spacing") {
      result[section].set(name, Number(value));
    }
  }
  return result;
}

const design = parseFrontMatter(designMarkdown);

/**
 * Token values decided in D-070 that DESIGN.md does not hold yet: a maintainer patches the
 * front matter at the merge and then deletes the entries, which this test demands once DESIGN.md agrees.
 */
const PENDING_IN_DESIGN: Readonly<Record<string, string>> = {};

describe("token parity with DESIGN.md", () => {
  it("lists only values DESIGN.md has not taken over yet", () => {
    for (const [name, value] of Object.entries(PENDING_IN_DESIGN)) {
      expect(design.colors.get(name)).not.toBe(value);
    }
  });

  it("reads every section of the front matter", () => {
    expect(design.colors.size).toBeGreaterThan(70);
    expect(design.typography.size).toBe(10);
    expect(design.rounded.size).toBe(5);
    expect(design.spacing.size).toBe(7);
  });

  it("holds every light colour and its dark counterpart", () => {
    const names = [...design.colors.keys()].filter((name) => !name.endsWith("-dark"));
    expect(Object.keys(COLOR_TOKENS).sort()).toEqual(names.sort());
    for (const name of names) {
      const token: { light: string; dark?: string } =
        COLOR_TOKENS[name as keyof typeof COLOR_TOKENS];
      expect(token.light.toUpperCase()).toBe(PENDING_IN_DESIGN[name] ?? design.colors.get(name));
      expect(token.dark?.toUpperCase()).toBe(
        PENDING_IN_DESIGN[`${name}-dark`] ?? design.colors.get(`${name}-dark`),
      );
    }
  });

  it("holds every typography token", () => {
    expect(Object.keys(TYPOGRAPHY_TOKENS).sort()).toEqual([...design.typography.keys()].sort());
    for (const [name, token] of Object.entries(TYPOGRAPHY_TOKENS)) {
      const source = design.typography.get(name);
      expect(source?.fontFamily).toBe(token.family);
      expect(Number.parseInt(source?.fontSize ?? "", 10)).toBe(token.size);
      expect(Number(source?.fontWeight)).toBe(token.weight);
      expect(Number(source?.lineHeight)).toBe(token.lineHeight);
      expect(source?.letterSpacing).toBe(
        "letterSpacing" in token ? token.letterSpacing : undefined,
      );
    }
  });

  it("holds the radius and spacing scales", () => {
    expect(Object.fromEntries(design.rounded)).toEqual(ROUNDED_TOKENS);
    expect(Object.fromEntries(design.spacing)).toEqual(SPACING_TOKENS);
  });
});

describe("theme.generated.css", () => {
  it("is what the generator produces from the tokens (run pnpm theme to refresh it)", () => {
    expect(generatedCss).toBe(themeCss());
  });

  it("makes dark the default and light an explicit theme", () => {
    expect(generatedCss).toContain(':root,\n:root[data-theme="dark"] {');
    expect(generatedCss).toContain(':root[data-theme="light"] {');
    expect(generatedCss).toContain("--gl-sheet-peek: 304px;");
    expect(generatedCss).toContain("--gl-surface: #17181A;");
    expect(generatedCss).toContain("--gl-surface: #FBFAF7;");
  });
});

describe("colour helpers", () => {
  it("resolves a category colour per theme", () => {
    expect(categoryColor("dark", "sbahn")).toBe("#5FC08A");
    expect(categoryColor("light", "sbahn")).toBe("#17814C");
    expect(categoryColor("dark", "night")).toBe(categoryColor("dark", "hsr"));
  });

  it("falls back to the light value for a token without a dark counterpart", () => {
    expect(colorValue("secondary", "dark")).toBe(colorValue("secondary", "light"));
  });
});
