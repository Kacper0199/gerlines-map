import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  type CategoryKey,
  Checkbox,
  LanguageSwitch,
  LegendRow,
  type MapStyleKind,
  Num,
  SearchField,
  Separator,
  StatusChip,
  StyleThumb,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
} from "../../src/index.ts";
import { Grid, LabelledRow, Section, Specimen } from "../layout.tsx";
import { LOCALE_OPTIONS, SAMPLE, type SheetStrings } from "../strings.ts";

const LEGEND_ORDER: readonly CategoryKey[] = ["hsr", "ld", "night", "rfast", "reg", "sbahn"];
const STYLE_KINDS: readonly MapStyleKind[] = ["dark", "light", "satellite", "terrain"];

function LegendCard({ strings }: { strings: SheetStrings }) {
  return (
    <Card className="w-full max-w-[260px] gap-2 py-3" aria-label={strings.legendTitle}>
      <CardHeader className="gap-0.5 px-3">
        <CardTitle className="type-body-strong">{strings.legendTitle}</CardTitle>
        <p className="type-caption text-ink-muted">
          <Num value={SAMPLE.total} locale={strings.locale} /> {strings.total},{" "}
          <Num value={SAMPLE.realtime} locale={strings.locale} /> {strings.realtime}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col px-2">
        {LEGEND_ORDER.map((key) => (
          <LegendRow
            key={key}
            category={key}
            name={strings.categories[key]}
            count={SAMPLE.counts[key]}
            locale={strings.locale}
            defaultChecked={key !== "sbahn"}
          />
        ))}
        <Separator className="my-1" />
        <LegendRow
          category="foreign"
          name={strings.categories.foreign}
          count={SAMPLE.counts.foreign}
          locale={strings.locale}
        />
        <p className="type-caption px-1 pt-2 text-ink-muted">{strings.untracked}</p>
      </CardContent>
    </Card>
  );
}

export function Controls({
  strings,
  onLocale,
}: {
  strings: SheetStrings;
  onLocale: (code: string) => void;
}) {
  const [style, setStyle] = useState<MapStyleKind>("dark");
  const [query, setQuery] = useState("");
  return (
    <Section
      id="controls"
      title="Tabs, fields and toggles"
      note="Colour mode tabs, the search field, the language switch, the map style picker and the legend rows."
    >
      <Grid>
        <Specimen label="Underline tabs" className="flex-col items-start">
          <Tabs defaultValue="category">
            <TabsList aria-label={strings.colourBy}>
              <TabsTrigger value="category">{strings.modes.category}</TabsTrigger>
              <TabsTrigger value="delay">{strings.modes.delay}</TabsTrigger>
              <TabsTrigger value="operator" disabled>
                {strings.modes.operator}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </Specimen>
        <Specimen label="Search field, default and filled" className="flex-col items-stretch">
          <SearchField
            label={strings.searchLabel}
            placeholder={strings.searchPlaceholder}
            clearLabel={strings.clearSearch}
            value={query}
            onValueChange={setQuery}
          />
          <SearchField
            label={strings.searchLabel}
            clearLabel={strings.clearSearch}
            defaultValue={SAMPLE.line}
          />
        </Specimen>
        <Specimen label="Search field, error and disabled" className="flex-col items-stretch">
          <SearchField
            label={strings.searchLabel}
            clearLabel={strings.clearSearch}
            defaultValue="Frankfurt"
            invalid
          />
          <p className="type-caption text-ink-muted">{strings.searchError}</p>
          <SearchField
            label={strings.searchLabel}
            placeholder={strings.searchPlaceholder}
            clearLabel={strings.clearSearch}
            disabled
          />
        </Specimen>
        <Specimen label="Language switch">
          <LanguageSwitch
            label={strings.languageLabel}
            locales={LOCALE_OPTIONS}
            value={strings.locale}
            onValueChange={onLocale}
          />
        </Specimen>
        <Specimen label="Map style picker" className="grid w-full max-w-[260px] grid-cols-2 gap-2">
          {STYLE_KINDS.map((kind) => (
            <StyleThumb
              key={kind}
              kind={kind}
              label={strings.styles[kind]}
              pressed={style === kind}
              disabled={kind === "satellite" || kind === "terrain"}
              onPress={() => setStyle(kind)}
            />
          ))}
        </Specimen>
        <Specimen label="Legend card" className="items-start">
          <LegendCard strings={strings} />
        </Specimen>
        <Specimen label="Switch states" className="flex-col items-start gap-3">
          <LabelledRow label={strings.realtimeState}>
            <Switch defaultChecked aria-label={strings.realtimeState} />
          </LabelledRow>
          <LabelledRow label={strings.timetableOnly}>
            <Switch aria-label={strings.timetableOnly} />
          </LabelledRow>
          <LabelledRow label={strings.stale}>
            <Switch disabled defaultChecked aria-label={strings.stale} />
          </LabelledRow>
        </Specimen>
        <Specimen label="Checkbox states" className="flex-col items-start gap-3">
          <LabelledRow label={strings.categories.hsr}>
            <Checkbox defaultChecked aria-label={strings.categories.hsr} />
          </LabelledRow>
          <LabelledRow label={strings.categories.reg}>
            <Checkbox aria-label={strings.categories.reg} />
          </LabelledRow>
          <LabelledRow label={strings.searchError}>
            <Checkbox aria-invalid aria-label={strings.searchError} />
          </LabelledRow>
        </Specimen>
        <Specimen label="Status chips">
          <StatusChip>{strings.realtimeState}</StatusChip>
          <StatusChip variant="outline">{strings.timetableOnly}</StatusChip>
          <StatusChip variant="muted">{strings.stale}</StatusChip>
          <StatusChip variant="error">{strings.cancelled}</StatusChip>
        </Specimen>
      </Grid>
    </Section>
  );
}
