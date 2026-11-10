import { CATEGORY_KEYS, CategoryMark, DelayValue, Num, TimePair } from "../../src/index.ts";
import { Grid, Section, Specimen } from "../layout.tsx";
import { SAMPLE, type SheetStrings } from "../strings.ts";

const DELAY_SAMPLES: readonly (number | null)[] = [51, 6, 0, -2, null];

export function Atoms({ strings }: { strings: SheetStrings }) {
  return (
    <Section
      id="atoms"
      title="Domain atoms"
      note="Numbers use Overpass Mono with tabular figures. Colons and group separators are narrowed. Sample values come from the recorded sample of 23 October 2026."
    >
      <Grid>
        <Specimen label="Category marks, dots from zoom 0">
          {CATEGORY_KEYS.map((key) => (
            <span key={key} className="flex flex-col items-center gap-1">
              <CategoryMark category={key} size={16} title={strings.categories[key]} />
              <span className="type-caption text-ink-muted">{key}</span>
            </span>
          ))}
        </Specimen>
        <Specimen label="Category marks, oriented chevrons from zoom 10">
          {CATEGORY_KEYS.map((key, index) => (
            <span key={key} className="flex flex-col items-center gap-1">
              <CategoryMark
                category={key}
                shape="chevron"
                size={24}
                heading={index * 50}
                title={strings.categories[key]}
              />
              <span className="type-caption text-ink-muted">{index * 50} deg</span>
            </span>
          ))}
        </Specimen>
        <Specimen label="Numbers by locale">
          {(["en", "de", "pl"] as const).map((locale) => (
            <span key={locale} className="type-body-strong flex items-baseline gap-2">
              <span className="type-caption text-ink-muted">{locale}</span>
              <Num value={SAMPLE.total} locale={locale} />
              <Num value={1234567} locale={locale} />
              <Num value={12.5} locale={locale} />
            </span>
          ))}
        </Specimen>
        <Specimen label="Delay values">
          {DELAY_SAMPLES.map((minutes) => (
            <DelayValue
              key={String(minutes)}
              minutes={minutes}
              labels={strings.delay}
              size="inline"
            />
          ))}
        </Specimen>
        <Specimen label="Delay value, headline">
          <DelayValue minutes={SAMPLE.delayMinutes} labels={strings.delay} />
          <DelayValue minutes={0} labels={strings.delay} />
        </Specimen>
        <Specimen label="Times, predicted over struck scheduled" className="items-baseline gap-6">
          <TimePair
            size="headline"
            predicted={SAMPLE.predicted}
            scheduled={SAMPLE.scheduled}
            predictedLabel={strings.predicted}
            scheduledLabel={strings.scheduled}
          />
          <TimePair size="row" predicted={SAMPLE.predicted} scheduled={SAMPLE.scheduled} />
          <TimePair size="passed" predicted={SAMPLE.passedTime} />
        </Specimen>
      </Grid>
    </Section>
  );
}
