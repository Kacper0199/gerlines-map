export interface Variant {
  readonly declarations: readonly string[];
  readonly selectors: readonly string[];
  readonly match: Readonly<Record<string, string>>;
}

export type Message = string | readonly Variant[];
export type MessageCatalog = Readonly<Record<string, Message | undefined>>;

export const CHARACTER_RULES = [
  ["double-dash", /--/],
  ["slash", /[/⁄∕⧸]/],
  ["quotation-mark", /["'`‘-‟′″«»‹›「-』]/],
  ["semicolon", /;/],
  ["middle-dot", /[·•‧∙⋅・]/],
  ["em-dash", /[—―⸺⸻]/],
  ["en-dash", /[‒–]/],
] as const satisfies readonly (readonly [string, RegExp])[];

export type CharacterRule = (typeof CHARACTER_RULES)[number][0];

export type Rule =
  | CharacterRule
  | "missing-key"
  | "extra-key"
  | "unused-key"
  | "placeholder-mismatch"
  | "stale-allow"
  | "allow-without-reason"
  | "invalid-allow";

export interface AllowEntry {
  readonly key: string;
  readonly rule: CharacterRule;
  readonly locale?: string;
  readonly reason: string;
}

export interface CopyLintInput {
  readonly baseLocale: string;
  readonly catalogs: Readonly<Record<string, MessageCatalog>>;
  readonly sources: readonly string[];
  readonly bridge?: string | undefined;
  readonly allow: readonly AllowEntry[];
}

export interface Finding {
  readonly locale: string;
  readonly key: string;
  readonly rule: Rule;
  readonly message: string;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s;"'“”„«»<>]*[^\s;"'“”„«»<>.,)]/gi;
const EXPRESSION_PATTERN = /\{[^{}]*\}/g;
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

function messageKeys(catalog: MessageCatalog): string[] {
  return Object.keys(catalog).filter((key) => !key.startsWith("$") && catalog[key] !== undefined);
}

function leaves(message: Message): string[] {
  return typeof message === "string" ? [message] : message.flatMap((v) => Object.values(v.match));
}

function placeholders(message: Message): string {
  const found = new Set<string>();
  for (const text of leaves(message)) {
    for (const hit of text.matchAll(PLACEHOLDER_PATTERN)) {
      found.add(hit[1] ?? "");
    }
  }
  return [...found].sort().join(", ");
}

function inputNames(message: Message): string {
  if (typeof message === "string") {
    return "";
  }
  const names = new Set<string>();
  for (const variant of message) {
    for (const declaration of variant.declarations) {
      const name = /^input\s+(\w+)/.exec(declaration)?.[1];
      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  return [...names].sort().join(", ");
}

function otherLeaf(message: Message): string | undefined {
  if (typeof message === "string") {
    return message;
  }
  for (const variant of message) {
    const hit = Object.entries(variant.match).find(([condition]) => condition.endsWith("=other"));
    if (hit !== undefined) {
      return hit[1];
    }
  }
  return undefined;
}

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((hit) => hit[1] ?? "");
}

function droppedInVariant(source: Message, message: Message): string | undefined {
  const required = placeholdersOf(otherLeaf(source) ?? "");
  if (typeof message === "string" || required.length === 0) {
    return undefined;
  }
  for (const variant of message) {
    for (const [condition, text] of Object.entries(variant.match)) {
      const missing = required.filter((name) => !placeholdersOf(text).includes(name));
      if (!condition.endsWith("=one") && missing.length > 0) {
        return `${condition} lacks {${missing.join("}, {")}}`;
      }
    }
  }
  return undefined;
}

function placeholderProblem(source: Message, message: Message): string | undefined {
  if (placeholders(source) !== placeholders(message)) {
    return `placeholders {${placeholders(message)}} differ from {${placeholders(source)}}`;
  }
  if (inputNames(source) !== inputNames(message)) {
    return `inputs (${inputNames(message)}) differ from (${inputNames(source)})`;
  }
  const dropped = droppedInVariant(source, message);
  return dropped === undefined ? undefined : `a plural form drops a placeholder: ${dropped}`;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

interface BridgeEntry {
  readonly leaf: string;
  readonly parents: readonly string[];
}

type Frame = { readonly kind: "object" | "block"; readonly name: string | undefined };

const BRIDGE_TOKEN = /(\w+)\s*:\s*\{|\{|\}|\(|\)|(\w+)\s*:(?!:)|\bm\.(\w+)\(/g;

function opensObject(before: string): boolean {
  const text = before.trimEnd();
  return (
    text.endsWith(":") || text.endsWith("return") || (text.endsWith("=") && !text.endsWith("=>"))
  );
}

interface BridgeState {
  readonly frames: Frame[];
  readonly entries: Map<string, BridgeEntry>;
  depth: number;
  leaf: string;
}

function setLeaf(state: BridgeState, name: string): void {
  if (state.depth === 0 && state.frames.at(-1)?.kind === "object") {
    state.leaf = name;
  }
}

function bridgeStep(state: BridgeState, hit: RegExpMatchArray, source: string): void {
  const [token, objectName, propertyName, key] = hit;
  if (objectName !== undefined) {
    setLeaf(state, objectName);
    state.frames.push({ kind: "object", name: objectName });
  } else if (key !== undefined) {
    const parents = state.frames.flatMap((frame) => (frame.name === undefined ? [] : [frame.name]));
    state.entries.set(key, { leaf: state.leaf, parents });
  } else if (propertyName !== undefined) {
    setLeaf(state, propertyName);
  } else if (token === "{") {
    const before = source.slice(Math.max(0, (hit.index ?? 0) - 12), hit.index);
    state.frames.push({ kind: opensObject(before) ? "object" : "block", name: undefined });
  } else if (token === "}") {
    state.frames.pop();
  } else {
    state.depth = Math.max(0, state.depth + (token === "(" ? 1 : -1));
  }
}

export function parseBridge(text: string): Map<string, BridgeEntry> {
  const source = stripComments(text);
  const state: BridgeState = { frames: [], entries: new Map(), depth: 0, leaf: "" };
  for (const hit of source.matchAll(BRIDGE_TOKEN)) {
    bridgeStep(state, hit, source);
  }
  return state.entries;
}

function readsProperty(consumers: string, entry: BridgeEntry): boolean {
  const leaf = new RegExp(`(?:\\.|[{,]\\s*)${entry.leaf}\\b`);
  return (
    leaf.test(consumers) ||
    entry.parents.some((parent) => new RegExp(`\\b${parent}\\s*\\[`).test(consumers))
  );
}

function isUsed(key: string, sources: readonly string[]): boolean {
  const pattern = new RegExp(`(?:\\bm\\.|\\bmessages\\.|["'\`])${key}(?![\\w])`);
  return sources.some((source) => pattern.test(stripComments(source)));
}

function usedKeys(
  keys: Iterable<string>,
  sources: readonly string[],
  bridge: string | undefined,
): Set<string> {
  const mapped = bridge === undefined ? undefined : parseBridge(bridge);
  const consumers = sources.map(stripComments).join("\n");
  const used = new Set<string>();
  for (const key of keys) {
    const entry = mapped?.get(key);
    if (isUsed(key, sources) || (entry !== undefined && readsProperty(consumers, entry))) {
      used.add(key);
    }
  }
  return used;
}

export function copyViolations(text: string): CharacterRule[] {
  const visible = text.normalize("NFKC").replace(URL_PATTERN, "").replace(EXPRESSION_PATTERN, "");
  return CHARACTER_RULES.filter(([, pattern]) => pattern.test(visible)).map(([name]) => name);
}

function invalidAllow(index: number, why: string): Finding {
  return {
    locale: "*",
    key: `allow[${index}]`,
    rule: "invalid-allow",
    message: `allow list: entry ${index} ${why}`,
  };
}

function validEntry(
  entry: unknown,
  index: number,
  locales: readonly string[],
): AllowEntry | Finding {
  if (typeof entry !== "object" || entry === null) {
    return invalidAllow(index, "is not an object");
  }
  const { key, rule, locale, reason } = entry as Record<string, unknown>;
  const ruleNames: readonly unknown[] = CHARACTER_RULES.map(([name]) => name);
  if (typeof key !== "string" || key === "") {
    return invalidAllow(index, "needs a key");
  }
  if (!ruleNames.includes(rule)) {
    return invalidAllow(
      index,
      `has an unknown rule ${String(rule)}, use one of ${ruleNames.join(", ")}`,
    );
  }
  if (locale !== undefined && (typeof locale !== "string" || !locales.includes(locale))) {
    return invalidAllow(index, `has an unknown locale ${String(locale)}`);
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    return invalidAllow(index, "needs a reason");
  }
  return { key, rule: rule as CharacterRule, ...(locale === undefined ? {} : { locale }), reason };
}

export function parseAllow(
  raw: unknown,
  locales: readonly string[],
): { allow: AllowEntry[]; findings: Finding[] } {
  const list = (raw as { allow?: unknown } | null)?.allow;
  if (typeof raw !== "object" || raw === null || !Array.isArray(list)) {
    return {
      allow: [],
      findings: [invalidAllow(0, 'file must be { "allow": [ ... ] }')],
    };
  }
  const allow: AllowEntry[] = [];
  const findings: Finding[] = [];
  list.forEach((entry, index) => {
    const checked = validEntry(entry, index, locales);
    if ("message" in checked) {
      findings.push(checked);
    } else {
      allow.push(checked);
    }
  });
  return { allow, findings };
}

export function renderedExemptions(
  catalogs: Readonly<Record<string, MessageCatalog>>,
  allow: readonly AllowEntry[],
  locale: string,
): (rule: CharacterRule, text: string) => boolean {
  const patterns: { rule: CharacterRule; pattern: RegExp }[] = [];
  for (const entry of allow) {
    const message = catalogs[locale]?.[entry.key];
    if (message === undefined || (entry.locale !== undefined && entry.locale !== locale)) {
      continue;
    }
    for (const leaf of leaves(message)) {
      const source = leaf
        .split(EXPRESSION_PATTERN)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      patterns.push({ rule: entry.rule, pattern: new RegExp(`^${source}$`, "su") });
    }
  }
  return (rule, text) => patterns.some((p) => p.rule === rule && p.pattern.test(text));
}

function allowed(allow: readonly AllowEntry[], locale: string, key: string, rule: Rule): number {
  return allow.findIndex(
    (entry) =>
      entry.key === key &&
      entry.rule === rule &&
      (entry.locale === undefined || entry.locale === locale),
  );
}

function characterFindings(
  locale: string,
  key: string,
  message: Message,
  allow: readonly AllowEntry[],
  used: Set<number>,
): Finding[] {
  const found: Finding[] = [];
  for (const text of leaves(message)) {
    for (const rule of copyViolations(text)) {
      const index = allowed(allow, locale, key, rule);
      if (index >= 0) {
        used.add(index);
      } else if (!found.some((finding) => finding.rule === rule)) {
        found.push({
          locale,
          key,
          rule,
          message: `${locale} ${key}: ${rule.replaceAll("-", " ")} in "${text}"`,
        });
      }
    }
  }
  return found;
}

function allowListFindings(allow: readonly AllowEntry[], used: ReadonlySet<number>): Finding[] {
  const found: Finding[] = [];
  allow.forEach((entry, index) => {
    if ((entry.reason ?? "").trim() === "") {
      found.push({
        locale: "*",
        key: entry.key,
        rule: "allow-without-reason",
        message: `allow list: ${entry.key} ${entry.rule} needs a reason`,
      });
    } else if (!used.has(index)) {
      found.push({
        locale: "*",
        key: entry.key,
        rule: "stale-allow",
        message: `allow list: ${entry.key} ${entry.rule} matches nothing, remove it`,
      });
    }
  });
  return found;
}

function unusedFindings(
  baseLocale: string,
  baseKeys: ReadonlySet<string>,
  sources: readonly string[],
  bridge: string | undefined,
): Finding[] {
  const used = usedKeys(baseKeys, sources, bridge);
  return [...baseKeys]
    .filter((key) => !used.has(key))
    .map((key) => ({
      locale: baseLocale,
      key,
      rule: "unused-key" as const,
      message: `${baseLocale} ${key}: no component or module reads this message`,
    }));
}

function keyFindings(
  locale: string,
  baseLocale: string,
  catalog: MessageCatalog,
  base: MessageCatalog,
): Finding[] {
  const baseKeys = new Set(messageKeys(base));
  const keys = new Set(messageKeys(catalog));
  const found: Finding[] = [];
  for (const key of baseKeys) {
    if (!keys.has(key)) {
      found.push({
        locale,
        key,
        rule: "missing-key",
        message: `${locale} ${key}: missing, ${baseLocale} has it`,
      });
    }
  }
  for (const key of keys) {
    const message = catalog[key];
    const source = base[key];
    if (!baseKeys.has(key)) {
      found.push({
        locale,
        key,
        rule: "extra-key",
        message: `${locale} ${key}: not in ${baseLocale}`,
      });
    } else if (locale !== baseLocale && message !== undefined && source !== undefined) {
      const problem = placeholderProblem(source, message);
      if (problem !== undefined) {
        found.push({
          locale,
          key,
          rule: "placeholder-mismatch",
          message: `${locale} ${key}: ${problem} (reference ${baseLocale})`,
        });
      }
    }
  }
  return found;
}

export function lintCopy(input: CopyLintInput): Finding[] {
  const { baseLocale, catalogs, sources, bridge, allow } = input;
  const base = catalogs[baseLocale] ?? {};
  const findings = unusedFindings(baseLocale, new Set(messageKeys(base)), sources, bridge);
  const usedAllow = new Set<number>();
  for (const [locale, catalog] of Object.entries(catalogs)) {
    findings.push(...keyFindings(locale, baseLocale, catalog, base));
    for (const key of messageKeys(catalog)) {
      const message = catalog[key];
      if (message !== undefined) {
        findings.push(...characterFindings(locale, key, message, allow, usedAllow));
      }
    }
  }
  findings.push(...allowListFindings(allow, usedAllow));
  return findings;
}
