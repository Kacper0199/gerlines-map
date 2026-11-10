import type { LegalCopy } from "@gerlines/i18n/legal";
import { useLegalCopy } from "@gerlines/i18n/legal";
import { CREDITS_PATH } from "../credits/path.ts";
import { External, LegalLayout, LegalSection, LINK, Missing, useLongDate } from "./LegalLayout.tsx";
import { creditParts, licenceName, NOWRAP_LICENCE_CHARS } from "./licence-names.ts";
import type { Licence, ProviderRow, SourceEntry } from "./model.ts";
import { NotAffiliated } from "./NotAffiliated.tsx";
import { withLanguage } from "./path.ts";
import {
  ELEVATION_ROWS,
  IMAGERY_ROWS,
  MAPTERHORN_SOURCES_URL,
  PROVIDERS_CHECKED,
  VERSATILES_SOURCES_URL,
} from "./providers.ts";
import { GROUP_ORDER, PUBLISHED_MAP_SOURCES, SOURCES, SOURCES_CHECKED } from "./sources.ts";

export type UseId = keyof LegalCopy["uses"];

function isUseId(id: string, uses: LegalCopy["uses"]): id is UseId {
  return Object.hasOwn(uses, id);
}

function LicenceName({ licence }: { licence: Licence }) {
  const text = useLegalCopy().legal;
  const name =
    licence.name === "perProvider"
      ? text.licencePerProvider
      : licence.name === "perFile"
        ? text.licencePerFile
        : licenceName(licence.name);
  if (licence.name === "perFile") {
    return (
      <a href={withLanguage(CREDITS_PATH)} className={LINK}>
        {name}
      </a>
    );
  }
  const nowrap = name.length <= NOWRAP_LICENCE_CHARS;
  if (!licence.url) return nowrap ? <span className="whitespace-nowrap">{name}</span> : name;
  return (
    <External href={licence.url} rel="license noopener noreferrer" nowrap={nowrap}>
      {name}
    </External>
  );
}

function Credit({ attribution }: { attribution: SourceEntry["attribution"] }) {
  const copy = useLegalCopy();
  if (attribution === null) return <Missing>{copy.legal.missingCredit}</Missing>;
  if (typeof attribution === "string") return attribution;
  switch (attribution.note) {
    case "changed":
      return `${attribution.holder}, ${copy.attribution.licenceChanged}`;
    case "mirror":
      return copy.legal.creditMirror(attribution.holders, attribution.mirror);
    case "perPhoto":
      return copy.legal.creditPerPhoto;
    case "imageryProviders":
      return `VersaTiles, ${copy.attribution.imageryProviders}`;
  }
}

function Licences({ licences }: { licences: readonly Licence[] }) {
  const text = useLegalCopy().legal;
  if (licences.length === 0) return <Missing>{text.missingLicence}</Missing>;
  return (
    <ul className="flex flex-col gap-2">
      {licences.map((licence) => (
        <li key={`${licence.name}-${licence.url ?? ""}`}>
          <LicenceName licence={licence} />
        </li>
      ))}
    </ul>
  );
}

const STATUS_KEY = {
  planned: "planned",
  reference: "reference",
  notUsed: "notUsed",
} as const;

const SOURCE_GRID = "lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,1fr)]";
const PROVIDER_GRID = "lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.7fr)_minmax(0,1.1fr)]";
const ROW = "border-t border-hairline py-3 first:border-t-0 lg:first:border-t";
const ROW_LABEL = "shrink-0 text-ink-muted type-caption max-lg:w-28 max-lg:pt-0.5 lg:sr-only";

function Source({ entry }: { entry: SourceEntry }) {
  const text = useLegalCopy().legal;
  const use = isUseId(entry.id, text.uses) ? text.uses[entry.id] : null;
  const label = ROW_LABEL;
  return (
    <li className={ROW}>
      <dl className={`grid grid-cols-1 gap-x-6 gap-y-1.5 ${SOURCE_GRID}`}>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="sr-only">{text.columns.provider}</dt>
          <dd className="type-body-strong break-words">
            {entry.url ? <External href={entry.url}>{entry.provider}</External> : entry.provider}
          </dd>
          {entry.status === "used" ? null : (
            <dd className="flex items-baseline gap-1.5 type-caption text-ink-muted">
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 translate-y-[-1px] rounded-full border border-ink-muted"
              />
              {text.statuses[STATUS_KEY[entry.status]]}
            </dd>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="sr-only">{text.columns.use}</dt>
          <dd className="type-body">{use ?? <Missing />}</dd>
        </div>
        <div className="flex min-w-0 gap-3 lg:flex-col lg:gap-1">
          <dt className={label}>{text.columns.licence}</dt>
          <dd className="min-w-0 type-body break-words">
            <Licences licences={entry.licences} />
          </dd>
        </div>
        <div className="flex min-w-0 gap-3 lg:flex-col lg:gap-1">
          <dt className={label}>{text.columns.credit}</dt>
          <dd className="min-w-0 type-body break-words">
            <Credit attribution={entry.attribution} />
          </dd>
        </div>
      </dl>
    </li>
  );
}

function ColumnHeads({ labels, grid }: { labels: readonly string[]; grid: string }) {
  return (
    <div
      aria-hidden="true"
      className={`hidden gap-x-6 pb-1 type-caption text-ink-muted lg:grid ${grid}`}
    >
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </div>
  );
}

function SourceHeads() {
  const text = useLegalCopy().legal;
  const { provider, use, licence, credit } = text.columns;
  return <ColumnHeads labels={[provider, use, licence, credit]} grid={SOURCE_GRID} />;
}

function ProviderName({ row }: { row: ProviderRow }) {
  const parts = creditParts(row.provider);
  const name = parts ? (
    <>
      {parts.head} <span className="whitespace-nowrap">{parts.joint}</span>
      {parts.rest}
    </>
  ) : (
    row.provider
  );
  return row.url ? <External href={row.url}>{name}</External> : name;
}

function ProviderItem({ row, withDataset }: { row: ProviderRow; withDataset: boolean }) {
  const text = useLegalCopy().legal;
  return (
    <li className={ROW}>
      <dl className={`grid grid-cols-1 gap-x-6 gap-y-1.5 ${PROVIDER_GRID}`}>
        <div className="flex min-w-0 gap-3 max-lg:order-2 lg:flex-col lg:gap-1">
          <dt className={ROW_LABEL}>{text.columns.area}</dt>
          <dd className="min-w-0 type-body break-words">{row.coverage || text.worldwide}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1 max-lg:order-1">
          <dt className="sr-only">{text.columns.credit}</dt>
          <dd className="type-body-strong break-words">
            <ProviderName row={row} />
          </dd>
          {withDataset && row.dataset ? (
            <dd className="type-body break-words text-ink-muted">{row.dataset}</dd>
          ) : null}
        </div>
        <div className="flex min-w-0 gap-3 max-lg:order-3 lg:flex-col lg:gap-1">
          <dt className={ROW_LABEL}>{text.columns.licence}</dt>
          <dd className="min-w-0 type-body break-words">
            <LicenceName licence={{ name: row.licence, url: row.licenceUrl }} />
          </dd>
        </div>
      </dl>
    </li>
  );
}

function ProviderList({
  rows,
  withDataset,
  caption,
}: {
  rows: readonly ProviderRow[];
  withDataset: boolean;
  caption: string;
}) {
  const { columns } = useLegalCopy().legal;
  const credit = withDataset ? `${columns.credit}, ${columns.dataset}` : columns.credit;
  return (
    <div>
      <ColumnHeads labels={[columns.area, credit, columns.licence]} grid={PROVIDER_GRID} />
      <ul aria-label={caption}>
        {rows.map((row) => (
          <ProviderItem
            key={`${row.coverage}-${row.provider}-${row.dataset ?? ""}`}
            row={row}
            withDataset={withDataset}
          />
        ))}
      </ul>
    </div>
  );
}

function ProviderSection({
  id,
  title,
  intro,
  listUrl,
  rows,
  withDataset,
}: {
  id: string;
  title: string;
  intro: string;
  listUrl: string;
  rows: readonly ProviderRow[];
  withDataset: boolean;
}) {
  const text = useLegalCopy().legal;
  const checked = useLongDate(PROVIDERS_CHECKED);
  return (
    <LegalSection id={id} title={title}>
      <div className="flex max-w-[65ch] flex-col gap-1">
        <p className="type-body text-ink-muted">{intro}</p>
        <p className="type-caption text-ink-muted">
          {text.checked(checked)}. <External href={listUrl}>{text.fullList}</External>
        </p>
      </div>
      <ProviderList rows={rows} withDataset={withDataset} caption={title} />
    </LegalSection>
  );
}

function PublishedLicence({ entry }: { entry: SourceEntry }) {
  const text = useLegalCopy().legal;
  return (
    <li>
      {entry.provider}:{" "}
      {entry.licences.length === 0 ? (
        <Missing>{text.missingLicence}</Missing>
      ) : (
        entry.licences.map((licence, index) => (
          <span key={`${licence.name}-${licence.url ?? ""}`}>
            {index > 0 ? ", " : null}
            <LicenceName licence={licence} />
          </span>
        ))
      )}
    </li>
  );
}

/** Every data source with its use, licence and required credit, and what we publish under which licence (WP-9.6). */
export function SourcesPage() {
  const copy = useLegalCopy();
  const text = copy.legal;
  const checked = useLongDate(SOURCES_CHECKED);
  return (
    <LegalLayout
      current="sources"
      title={text.sourcesTitle}
      intro={
        <>
          <p className="type-body text-ink-muted">{text.sourcesIntro}</p>
          <p className="type-caption text-ink-muted">
            {text.checked(checked)}.{" "}
            <a href={withLanguage(CREDITS_PATH)} className={LINK}>
              {copy.photos.creditsLink}
            </a>
          </p>
        </>
      }
    >
      <NotAffiliated />
      {GROUP_ORDER.map((group) => (
        <LegalSection key={group} id={`group-${group}`} title={text.groups[group]}>
          <div>
            <SourceHeads />
            <ul>
              {SOURCES.filter((entry) => entry.group === group).map((entry) => (
                <Source key={entry.id} entry={entry} />
              ))}
            </ul>
          </div>
        </LegalSection>
      ))}
      <ProviderSection
        id="imagery"
        title={text.imageryTitle}
        intro={text.imageryIntro}
        listUrl={VERSATILES_SOURCES_URL}
        rows={IMAGERY_ROWS}
        withDataset={false}
      />
      <ProviderSection
        id="elevation"
        title={text.elevationTitle}
        intro={text.elevationIntro}
        listUrl={MAPTERHORN_SOURCES_URL}
        rows={ELEVATION_ROWS}
        withDataset
      />
      <LegalSection id="published" title={text.publishedTitle}>
        <div className="flex max-w-[65ch] flex-col gap-3 type-body">
          <p className="text-ink-muted">{text.publishedIntro}</p>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            <li>{text.publishedCode}</li>
            <li>
              {text.publishedMap}
              <ul className="mt-1 flex list-[circle] flex-col gap-1 pl-5">
                {PUBLISHED_MAP_SOURCES.flatMap((id) => {
                  const entry = SOURCES.find((candidate) => candidate.id === id);
                  return entry ? [<PublishedLicence key={id} entry={entry} />] : [];
                })}
              </ul>
              <p className="mt-1">{text.publishedMapCombined}</p>
            </li>
            <li>{text.publishedShapes}</li>
            <li>{text.publishedCatalogue}</li>
          </ul>
        </div>
      </LegalSection>
    </LegalLayout>
  );
}
