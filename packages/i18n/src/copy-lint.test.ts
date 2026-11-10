import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHARACTER_RULES,
  type CopyLintInput,
  copyViolations,
  lintCopy,
  type Message,
  parseAllow,
  renderedExemptions,
} from "./copy-lint.ts";

function plural(one: string, other: string): Message {
  return [
    {
      declarations: ["input count", "local countPlural = count: plural"],
      selectors: ["countPlural"],
      match: { "countPlural=one": one, "countPlural=other": other },
    },
  ];
}

function input(overrides: Partial<CopyLintInput> = {}): CopyLintInput {
  return {
    baseLocale: "en",
    catalogs: {
      en: {
        $schema: "x",
        greeting: "Hello {name}",
        stops: plural("{count} stop", "{count} stops"),
      },
      de: {
        $schema: "x",
        greeting: "Hallo {name}",
        stops: plural("{count} Halt", "{count} Halte"),
      },
    },
    sources: ["m.greeting({ name }, o); m.stops({ count }, o);"],
    allow: [],
    ...overrides,
  };
}

function rules(findings: ReturnType<typeof lintCopy>): string[] {
  return findings.map((finding) => `${finding.locale}:${finding.key}:${finding.rule}`).sort();
}

describe("lintCopy", () => {
  it("passes clean catalogs", () => {
    expect(lintCopy(input())).toEqual([]);
  });

  it.each([
    ["double dash", "Rail -- live", "double-dash"],
    ["slash", "IC/EC trains", "slash"],
    ["straight quotation mark", 'The "fast" train', "quotation-mark"],
    ["apostrophe", "Don't wait", "quotation-mark"],
    ["German low quotation mark", "Der „schnelle“ Zug", "quotation-mark"],
    ["French quotation mark", "Le «rapide»", "quotation-mark"],
    ["semicolon", "Stop; go", "semicolon"],
    ["middle dot", "Berlin · Hamburg", "middle-dot"],
    ["em dash", "Rail — live", "em-dash"],
    ["en dash", "Berlin – Hamburg", "en-dash"],
    ["bullet", "Berlin • Hamburg", "middle-dot"],
    ["dot operator", "Berlin ⋅ Hamburg", "middle-dot"],
    ["bullet operator", "Berlin ∙ Hamburg", "middle-dot"],
    ["katakana middle dot", "Berlin ・ Hamburg", "middle-dot"],
    ["Greek ano teleia", "Berlin \u0387 Hamburg", "middle-dot"],
    ["full-width slash", "IC／EC", "slash"],
    ["fraction slash", "IC⁄EC", "slash"],
    ["division slash", "IC∕EC", "slash"],
    ["full-width semicolon", "Stop； go", "semicolon"],
    ["Greek question mark", "Stop\u037E go", "semicolon"],
    ["full-width quotation mark", "Der ＂Zug＂", "quotation-mark"],
    ["single high-reversed quote", "Der ‛Zug", "quotation-mark"],
    ["backtick", "Der `Zug`", "quotation-mark"],
    ["prime", "Der Zug′", "quotation-mark"],
    ["corner bracket", "「Zug」", "quotation-mark"],
    ["horizontal bar", "Rail ― live", "em-dash"],
    ["two-em dash", "Rail ⸺ live", "em-dash"],
    ["small em dash", "Rail ﹘ live", "em-dash"],
    ["figure dash", "Berlin ‒ Hamburg", "en-dash"],
  ])("fails on a %s in a message value", (_name, text, rule) => {
    const findings = lintCopy(
      input({ catalogs: { en: { greeting: text }, de: { greeting: "Hallo" } } }),
    );
    expect(rules(findings)).toContain(`en:greeting:${rule}`);
  });

  it("checks every variant of a plural message", () => {
    const findings = lintCopy(
      input({
        catalogs: {
          en: { stops: plural("{count} stop", "{count} stops; all") },
          de: { stops: plural("{count} Halt", "{count} Halte") },
        },
        sources: ["m.stops()"],
      }),
    );
    expect(rules(findings)).toEqual(["en:stops:semicolon"]);
  });

  it("does not read declarations, selectors or keys as copy", () => {
    const withMarks: Message = [
      {
        declarations: ["input count", "local countPlural = count: plural; /* x */"],
        selectors: ["countPlural"],
        match: { "countPlural=one": "{count} stop", "countPlural=other": "{count} stops" },
      },
    ];
    expect(
      lintCopy(
        input({
          catalogs: {
            en: { "a/b;c": "Hello", stops: withMarks },
            de: { "a/b;c": "Hallo", stops: withMarks },
          },
          sources: ["m['a/b;c'](); m.stops()", "'a/b;c'"],
        }),
      ),
    ).toEqual([]);
  });

  it("ignores inlang markup and placeholders when it looks for slashes", () => {
    expect(copyViolations("Das ist {#b}fett{/b} und {count}")).toEqual([]);
  });

  it("finds a semicolon right after a URL", () => {
    expect(copyViolations("see https://x.de; then")).toEqual(["semicolon"]);
    expect(copyViolations('see https://x.de/a" then')).toEqual(["quotation-mark"]);
    expect(copyViolations("see https://x.de/a, then")).toEqual([]);
  });

  it("ignores URLs when it looks for slashes", () => {
    const findings = lintCopy(
      input({
        catalogs: {
          en: { greeting: "See https://example.org/a/b?c=1 now" },
          de: { greeting: "Siehe https://example.org/a/b?c=1 jetzt" },
        },
        sources: ["m.greeting()"],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("still finds a slash next to a URL", () => {
    const findings = lintCopy(
      input({
        catalogs: {
          en: { greeting: "A/B https://example.org/a" },
          de: { greeting: "Hallo" },
        },
        sources: ["m.greeting()"],
      }),
    );
    expect(rules(findings)).toEqual(["en:greeting:slash"]);
  });

  it("honours an allow entry for one key, locale and rule, and nothing else", () => {
    const catalogs = {
      en: { code: "Line S1/S2", other: "A/B" },
      de: { code: "Linie S1/S2", other: "A/B" },
    };
    const findings = lintCopy({
      baseLocale: "en",
      catalogs,
      sources: ["m.code(); m.other();"],
      allow: [{ key: "code", rule: "slash", reason: "line codes of the S-Bahn network" }],
    });
    expect(rules(findings)).toEqual(["de:other:slash", "en:other:slash"]);
  });

  it("limits an allow entry to its locale when one is given", () => {
    const findings = lintCopy({
      baseLocale: "en",
      catalogs: { en: { code: "S1/S2" }, de: { code: "S1/S2" } },
      sources: ["m.code()"],
      allow: [{ key: "code", locale: "de", rule: "slash", reason: "line codes" }],
    });
    expect(rules(findings)).toEqual(["en:code:slash"]);
  });

  it("reports an allow entry that matches nothing", () => {
    const findings = lintCopy(
      input({ allow: [{ key: "greeting", rule: "slash", reason: "was needed once" }] }),
    );
    expect(rules(findings)).toEqual(["*:greeting:stale-allow"]);
  });

  it("requires a reason on every allow entry", () => {
    const findings = lintCopy({
      baseLocale: "en",
      catalogs: { en: { code: "S1/S2" }, de: { code: "S1/S2" } },
      sources: ["m.code()"],
      allow: [{ key: "code", rule: "slash", reason: " " }],
    });
    expect(rules(findings)).toContain("*:code:allow-without-reason");
  });

  it("reports a key missing in a locale", () => {
    const findings = lintCopy(
      input({
        catalogs: {
          en: { greeting: "Hello {name}", extra: "More" },
          de: { greeting: "Hallo {name}" },
        },
        sources: ["m.greeting(); m.extra();"],
      }),
    );
    expect(rules(findings)).toEqual(["de:extra:missing-key"]);
  });

  it("reports a key that exists only in a translation", () => {
    const findings = lintCopy(
      input({
        catalogs: {
          en: { greeting: "Hello {name}" },
          de: { greeting: "Hallo {name}", stray: "Nur hier" },
        },
        sources: ["m.greeting(); m.stray();"],
      }),
    );
    expect(rules(findings)).toEqual(["de:stray:extra-key"]);
  });

  it("reports an unused key once, for the base locale", () => {
    const findings = lintCopy(input({ sources: ["m.greeting({ name }, o);"] }));
    expect(rules(findings)).toEqual(["en:stops:unused-key"]);
  });

  it("counts a key as used by a property access, a call or a quoted name", () => {
    const findings = lintCopy(input({ sources: ["messages.greeting", "const key = 'stops';"] }));
    expect(findings).toEqual([]);
  });

  it("does not count a longer key that only starts with the name", () => {
    const findings = lintCopy(input({ sources: ["m.greeting_long(); m.stops();"] }));
    expect(rules(findings)).toEqual(["en:greeting:unused-key"]);
  });

  it("does not count a mention in a comment as a use", () => {
    const findings = lintCopy(
      input({ sources: ["// m.stops() was removed\n/* m.stops() */ m.greeting();"] }),
    );
    expect(rules(findings)).toEqual(["en:stops:unused-key"]);
  });

  describe("with the bridge copy.ts", () => {
    const bridge = [
      "export function createCopy() {",
      "  return {",
      "    card: {",
      "      follow: m.greeting({}, o),",
      "      count: (n: number) =>",
      "        n <= 1 ? m.stops_soon({}, o) : m.stops({ n }, o),",
      "    },",
      "    errors: { first: m.err_first({}, o), second: m.err_second({}, o) },",
      "    attribution: (text: string) => {",
      "      return text === '' ? 'x' : m.credit({ text }, o);",
      "    },",
      "  };",
      "}",
    ].join("\n");
    const catalog = {
      greeting: "Hello",
      stops_soon: "Soon",
      stops: "Stops",
      err_first: "A",
      err_second: "B",
      credit: "Credit",
    };
    const lint = (sources: string[], bridgeText = bridge) =>
      lintCopy({
        baseLocale: "en",
        catalogs: { en: catalog, de: catalog },
        sources,
        bridge: bridgeText,
        allow: [],
      });

    it("counts a key as used when a component reads its property", () => {
      const findings = lint([
        "copy.card.follow; copy.card.count(2); copy.errors[code]; copy.attribution(x)",
      ]);
      expect(findings).toEqual([]);
    });

    it("reports a key that copy.ts wires but no component reads", () => {
      const findings = lint(["copy.card.count(2); copy.errors[code]; copy.attribution(x)"]);
      expect(rules(findings)).toEqual(["en:greeting:unused-key"]);
    });

    it("reads a function property that holds two messages, in an expression body and a block body", () => {
      expect(rules(lint(["copy.card.follow; copy.errors[code]"]))).toEqual([
        "en:credit:unused-key",
        "en:stops:unused-key",
        "en:stops_soon:unused-key",
      ]);
    });

    it("counts every property under an object that is read by a computed key", () => {
      expect(rules(lint(["copy.card.follow; copy.card.count(1); copy.attribution(x)"]))).toEqual([
        "en:err_first:unused-key",
        "en:err_second:unused-key",
      ]);
    });

    it("counts a direct use of m.key outside copy.ts", () => {
      const findings = lint([
        "copy.card.count(2); copy.errors[code]; copy.attribution(x); m.greeting()",
      ]);
      expect(findings).toEqual([]);
    });

    it("does not count the bridge's own call as a use, and ignores comments in it", () => {
      const withComment = `${bridge}\n// m.stops_soon()`;
      expect(
        rules(lint(["copy.card.follow; copy.errors[code]; copy.attribution(x)"], withComment)),
      ).toEqual(["en:stops:unused-key", "en:stops_soon:unused-key"]);
    });
  });

  it("reports placeholders that differ from the base locale", () => {
    const findings = lintCopy(
      input({
        catalogs: {
          en: { greeting: "Hello {name}", stops: plural("{count} stop", "{count} stops") },
          de: { greeting: "Hallo {person}", stops: plural("{count} Halt", "{count} Halte") },
        },
      }),
    );
    expect(rules(findings)).toEqual(["de:greeting:placeholder-mismatch"]);
  });

  it("accepts a one form without the number when the other forms keep it", () => {
    const findings = lintCopy(
      input({
        catalogs: {
          en: { greeting: "Hello {name}", stops: plural("one stop", "{count} stops") },
          de: { greeting: "Hallo {name}", stops: plural("{count} Halt", "{count} Halte") },
        },
      }),
    );
    expect(findings).toEqual([]);
  });

  it("reports a plural input that is named differently from English", () => {
    const renamed: Message = [
      {
        declarations: ["input n", "local countPlural = n: plural"],
        selectors: ["countPlural"],
        match: { "countPlural=one": "{count} Halt", "countPlural=other": "{count} Halte" },
      },
    ];
    const findings = lintCopy(
      input({
        catalogs: {
          en: input().catalogs.en ?? {},
          de: { greeting: "Hallo {name}", stops: renamed },
        },
      }),
    );
    expect(rules(findings)).toEqual(["de:stops:placeholder-mismatch"]);
  });

  it("reports a plural form other than one that drops the number the base form has", () => {
    const polish = (few: string): Message => [
      {
        declarations: ["input count", "local countPlural = count: plural"],
        selectors: ["countPlural"],
        match: {
          "countPlural=one": "{count} przystanek",
          "countPlural=few": few,
          "countPlural=many": "{count} przystanków",
          "countPlural=other": "{count} przystanków",
        },
      },
    ];
    const catalogs = (few: string) => ({
      en: { stops: plural("{count} stop", "{count} stops") },
      pl: { stops: polish(few) },
    });
    expect(
      rules(
        lintCopy({
          baseLocale: "en",
          catalogs: catalogs("{count} przystanki"),
          sources: ["m.stops()"],
          allow: [],
        }),
      ),
    ).toEqual([]);
    expect(
      rules(
        lintCopy({
          baseLocale: "en",
          catalogs: catalogs("kilka przystanków"),
          sources: ["m.stops()"],
          allow: [],
        }),
      ),
    ).toEqual(["pl:stops:placeholder-mismatch"]);
  });

  it("explains each finding in a sentence that names the key", () => {
    const [finding] = lintCopy(
      input({ catalogs: { en: { greeting: "A/B" }, de: { greeting: "Hallo" } } }),
    );
    expect(finding?.message).toContain("greeting");
    expect(finding?.message).toContain("A/B");
  });
});

describe("copyViolations", () => {
  it("is the one rule set: every rule has an example", () => {
    expect(CHARACTER_RULES.map(([name]) => name).sort()).toEqual(
      [
        "double-dash",
        "em-dash",
        "en-dash",
        "middle-dot",
        "quotation-mark",
        "semicolon",
        "slash",
      ].sort(),
    );
  });

  it("returns every rule a text breaks, once", () => {
    expect(copyViolations("A/B; C/D")).toEqual(["slash", "semicolon"]);
  });
});

describe("parseAllow", () => {
  const locales = ["en", "de"];

  it("accepts valid entries", () => {
    const parsed = parseAllow(
      { allow: [{ key: "code", rule: "slash", locale: "de", reason: "line codes" }] },
      locales,
    );
    expect(parsed.findings).toEqual([]);
    expect(parsed.allow).toHaveLength(1);
  });

  it.each([
    ["no reason", { key: "code", rule: "slash" }],
    ["unknown rule", { key: "code", rule: "slashes", reason: "x" }],
    ["unknown locale", { key: "code", rule: "slash", locale: "fr", reason: "x" }],
    ["no key", { rule: "slash", reason: "x" }],
  ])("reports an entry with %s instead of throwing", (_name, entry) => {
    const parsed = parseAllow({ allow: [entry] }, locales);
    expect(parsed.allow).toEqual([]);
    expect(parsed.findings.map((finding) => finding.rule)).toEqual(["invalid-allow"]);
  });

  it("reports a misspelled top-level field and a non-object file", () => {
    expect(parseAllow({ allows: [] }, locales).findings.map((f) => f.rule)).toEqual([
      "invalid-allow",
    ]);
    expect(parseAllow([], locales).findings.map((f) => f.rule)).toEqual(["invalid-allow"]);
  });
});

describe("renderedExemptions", () => {
  it("exempts a rendered string that comes from an allowed message, placeholders filled", () => {
    const catalogs = { en: { line: "Line {code}, S1/S2" }, de: { line: "Linie {code}, S1/S2" } };
    const allow = [{ key: "line", rule: "slash" as const, reason: "line codes" }];
    const exempt = renderedExemptions(catalogs, allow, "en");
    expect(exempt("slash", "Line 7, S1/S2")).toBe(true);
    expect(exempt("slash", "Something else A/B")).toBe(false);
    expect(exempt("semicolon", "Line 7, S1/S2")).toBe(false);
  });

  it("works for the allowed locale only", () => {
    const catalogs = { en: { line: "S1/S2" }, de: { line: "S1/S2" } };
    const allow = [{ key: "line", rule: "slash" as const, locale: "de", reason: "codes" }];
    expect(renderedExemptions(catalogs, allow, "de")("slash", "S1/S2")).toBe(true);
    expect(renderedExemptions(catalogs, allow, "en")("slash", "S1/S2")).toBe(false);
  });
});

describe("copy lint command", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const script = fileURLToPath(new URL("../../../scripts/lint-copy.ts", import.meta.url));

  function repo(messages: Record<string, Record<string, unknown>>, source: string): string {
    const root = mkdtempSync(join(tmpdir(), "copy-lint-"));
    roots.push(root);
    const i18n = join(root, "packages", "i18n");
    mkdirSync(join(i18n, "messages"), { recursive: true });
    mkdirSync(join(i18n, "project.inlang"), { recursive: true });
    mkdirSync(join(i18n, "src"), { recursive: true });
    writeFileSync(
      join(i18n, "project.inlang", "settings.json"),
      JSON.stringify({ baseLocale: "en", locales: Object.keys(messages) }),
    );
    for (const [locale, catalog] of Object.entries(messages)) {
      writeFileSync(join(i18n, "messages", `${locale}.json`), JSON.stringify(catalog));
    }
    writeFileSync(join(i18n, "src", "consumer.ts"), source);
    return root;
  }

  function run(root: string): { status: number; output: string } {
    try {
      const output = execFileSync(process.execPath, [script, "--root", root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, output };
    } catch (error) {
      const failure = error as { status: number; stdout: string; stderr: string };
      return { status: failure.status, output: `${failure.stdout}${failure.stderr}` };
    }
  }

  it("exits 0 and says how many messages it checked when the copy is clean", () => {
    const root = repo({ en: { hello: "Hello" }, de: { hello: "Hallo" } }, "m.hello()");
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/1 message/);
  });

  it("exits 1 and prints one line per finding", () => {
    const root = repo({ en: { hello: "Hello/Hi" }, de: { hello: "Hallo" } }, "m.hello()");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/en hello: slash/);
  });

  it("reports a broken allow list file as a finding, not a crash", () => {
    const root = repo({ en: { code: "S1" }, de: { code: "S1" } }, "m.code()");
    writeFileSync(join(root, "packages", "i18n", "copy-lint.allow.json"), "{ nope");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/allow list/);
  });

  it("does not skip sources because the checkout lives under a folder named dist", () => {
    const root = repo({ en: { hello: "Hello" }, de: { hello: "Hallo" } }, "m.hello()");
    const nested = join(root, "dist", "checkout");
    mkdirSync(nested, { recursive: true });
    cpSync(join(root, "packages"), join(nested, "packages"), { recursive: true });
    expect(run(nested).status).toBe(0);
  });

  it("reads the allow list next to the messages", () => {
    const root = repo({ en: { code: "S1/S2" }, de: { code: "S1/S2" } }, "m.code()");
    writeFileSync(
      join(root, "packages", "i18n", "copy-lint.allow.json"),
      JSON.stringify({ allow: [{ key: "code", rule: "slash", reason: "line codes" }] }),
    );
    expect(run(root).status).toBe(0);
  });
});

describe("the messages of this repository", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));

  it("pass the copy lint command", () => {
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../../../scripts/lint-copy.ts", import.meta.url)), "--root", root],
      { encoding: "utf8" },
    );
    expect(output).toMatch(/copy lint: \d+ messages? in en, de, pl/);
  }, 60_000);
});
