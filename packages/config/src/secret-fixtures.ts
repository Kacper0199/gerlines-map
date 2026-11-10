import fixtures from "../secret-fixtures.json" with { type: "json" };

export interface SecretFixture {
  readonly name: string;
  readonly file: string;
  readonly content: string;
}

type TokenName = keyof typeof fixtures.tokens;

function buildToken(name: TokenName): string {
  const { parts, repeat, join } = fixtures.tokens[name];
  return parts.join(join).repeat(repeat);
}

function isTokenName(name: string): name is TokenName {
  return Object.hasOwn(fixtures.tokens, name);
}

function fill(template: string): string {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_placeholder, name: string) => {
    if (!isTokenName(name)) {
      throw new Error(`Unknown fixture token ${name}`);
    }
    return buildToken(name);
  });
}

function materialise(list: readonly SecretFixture[]): SecretFixture[] {
  return list.map((fixture) => ({ ...fixture, content: fill(fixture.content) }));
}

export const mustFail = materialise(fixtures.mustFail);
export const mustPass = materialise(fixtures.mustPass);
