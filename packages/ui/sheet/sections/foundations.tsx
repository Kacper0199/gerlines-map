import {
  CATEGORY_KEYS,
  ClockText,
  type ColorName,
  colorValue,
  DELAY_KEYS,
  ROUNDED_TOKENS,
  SPACING_TOKENS,
  type ThemeName,
  TYPOGRAPHY_TOKENS,
  type TypographyName,
  tokenContrast,
} from "../../src/index.ts";
import { Grid, Section, Specimen } from "../layout.tsx";
import type { SheetStrings } from "../strings.ts";

const ROLE_PAIRS: readonly {
  readonly label: string;
  readonly fg: ColorName;
  readonly bg: ColorName;
  readonly role: string;
}[] = [
  { label: "Ink on surface", fg: "ink", bg: "surface", role: "text" },
  { label: "Muted ink on surface", fg: "ink-muted", bg: "surface", role: "text" },
  { label: "Muted ink on raised", fg: "ink-muted", bg: "neutral", role: "text" },
  { label: "Text on selection", fg: "on-primary", bg: "primary", role: "text" },
  { label: "Selection text on surface", fg: "primary-text", bg: "surface", role: "text" },
  { label: "Passed on surface", fg: "passed", bg: "surface", role: "part" },
  { label: "Focus ring on surface", fg: "focus", bg: "surface", role: "part" },
  { label: "Error on surface", fg: "error", bg: "surface", role: "part" },
];

const TYPE_SAMPLES: Readonly<Record<TypographyName, string>> = {
  display: "21:35",
  headline: "ICE 379",
  wordmark: "GerLines",
  title: "Frankfurt (Main) Hbf",
  "body-strong": "Berlin Hbf to Basel SBB",
  body: "Position is estimated between reports.",
  label: "Realtime",
  caption: "Photo credit and data source",
  data: "+51 min",
  "data-small": "20:44",
};

const TYPE_CLASS: Readonly<Record<TypographyName, string>> = {
  display: "type-display",
  headline: "type-headline",
  wordmark: "type-wordmark",
  title: "type-title",
  "body-strong": "type-body-strong",
  body: "type-body",
  label: "type-label",
  caption: "type-caption",
  data: "type-data",
  "data-small": "type-data-small",
};

function ColourPair({ pair, theme }: { pair: (typeof ROLE_PAIRS)[number]; theme: ThemeName }) {
  const ratio = tokenContrast(pair.fg, pair.bg, theme);
  const needed = pair.role === "text" ? 4.5 : 3;
  const part = pair.role !== "text";
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
      style={
        part
          ? undefined
          : { background: colorValue(pair.bg, theme), color: colorValue(pair.fg, theme) }
      }
    >
      <span className="type-label flex items-center gap-2">
        {part ? (
          <span
            aria-hidden="true"
            className="size-4 rounded-sm border"
            style={{ background: colorValue(pair.fg, theme) }}
          />
        ) : null}
        {pair.label}
      </span>
      <span className="num type-data-small">
        {ratio.toFixed(1)} {ratio >= needed ? "ok" : `below ${needed}`}
      </span>
    </div>
  );
}

export function Foundations({ theme, strings }: { theme: ThemeName; strings: SheetStrings }) {
  return (
    <Section
      id="foundations"
      title="Foundations"
      note="Tokens come from DESIGN.md through packages/ui/src/theme/tokens.ts. Ratios are computed for the active theme."
    >
      <Grid>
        <Specimen label="Contrast pairs" className="flex-col items-stretch">
          {ROLE_PAIRS.map((pair) => (
            <ColourPair key={pair.label} pair={pair} theme={theme} />
          ))}
        </Specimen>
        <Specimen label="Category colours" className="flex-col items-stretch gap-1">
          {CATEGORY_KEYS.map((key) => (
            <div key={key} className="flex items-center gap-3">
              <span
                className="size-6 rounded-md border"
                style={{ background: `var(--gl-cat-${key === "night" ? "hsr" : key})` }}
              />
              <span className="type-body">{strings.categories[key]}</span>
            </div>
          ))}
        </Specimen>
        <Specimen label="Delay colours" className="flex-col items-stretch gap-1">
          {DELAY_KEYS.map((key) => (
            <div key={key} className="flex items-center gap-3">
              <span
                className="size-6 rounded-md border"
                style={{ background: `var(--gl-delay-${key})` }}
              />
              <span className="type-body">{key}</span>
            </div>
          ))}
        </Specimen>
      </Grid>
      <Specimen label="Type scale" className="flex-col items-stretch gap-2">
        {(Object.keys(TYPOGRAPHY_TOKENS) as TypographyName[]).map((name) => {
          const token = TYPOGRAPHY_TOKENS[name];
          return (
            <div
              key={name}
              className="grid grid-cols-[8rem_1fr] items-baseline gap-3 border-b pb-2 max-[640px]:grid-cols-1"
            >
              <span className="type-caption text-ink-muted">
                {name} {token.size}px {token.weight}
              </span>
              <span className={TYPE_CLASS[name]}>
                {name === "display" || name === "data-small" ? (
                  <ClockText text={TYPE_SAMPLES[name]} />
                ) : (
                  TYPE_SAMPLES[name]
                )}
              </span>
            </div>
          );
        })}
      </Specimen>
      <Grid>
        <Specimen label="Radius">
          {Object.entries(ROUNDED_TOKENS).map(([name, value]) => (
            <div key={name} className="flex flex-col items-center gap-1">
              <span
                className="size-12 border bg-raised"
                style={{ borderRadius: Math.min(value, 24) }}
              />
              <span className="type-caption text-ink-muted">
                {name} {value}
              </span>
            </div>
          ))}
        </Specimen>
        <Specimen label="Spacing">
          {Object.entries(SPACING_TOKENS).map(([name, value]) => (
            <div key={name} className="flex flex-col items-start gap-1">
              <span className="h-3 bg-ink-muted" style={{ width: value }} />
              <span className="type-caption text-ink-muted">
                {name} {value}
              </span>
            </div>
          ))}
        </Specimen>
        <Specimen label="Elevation">
          <div className="card-surface type-body p-4">Card shadow and hairline</div>
        </Specimen>
      </Grid>
    </Section>
  );
}
