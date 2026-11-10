import { useLegalCopy } from "@gerlines/i18n/legal";
import { useSignatureCopy } from "@gerlines/i18n/signature";
import { Notice } from "@gerlines/ui";
import { FilePen } from "lucide-react";
import { SHORTCUTS_STORAGE_KEY } from "../a11y/shortcuts.ts";
import { DEM_TILES_URL, SATELLITE_TILES_URL, TILES_URL } from "../map/style/build-style.ts";
import { BUILDINGS_STORAGE_KEY, TERRAIN_STORAGE_KEY } from "../map/terrain/policy.ts";
import { COLOUR_MODE_KEY } from "../modes/colour-mode.ts";
import { LABEL_MODE_KEY } from "../modes/label-mode.ts";
import { SELECTION_TILT_STORAGE_KEY } from "../signature/tilt-policy.ts";
import { MAP_STYLE_STORAGE_KEY, THEME_STORAGE_KEY } from "../theme/preference.ts";
import { LegalLayout, LegalSection, LINK, Missing, useLongDate } from "./LegalLayout.tsx";
import { IMPRINT_PATH, withLanguage } from "./path.ts";

export const PRIVACY_DRAFT_DATE = "2026-11-08";
export const LOCALE_STORAGE_KEY = "PARAGLIDE_LOCALE";

function hostOf(url: string): string {
  return new URL(url.replace(/\{[^}]+\}/g, "0")).host;
}

function Prose({ children }: { children: React.ReactNode }) {
  return <div className="flex max-w-[65ch] flex-col gap-3 type-body">{children}</div>;
}

function KeyTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: readonly [string, string];
  rows: readonly (readonly [string, string])[];
}) {
  return (
    <div className="max-w-[75ch] overflow-x-auto">
      <table className="w-full border-collapse text-left type-body">
        <caption className="sr-only">{caption}</caption>
        <thead className="type-caption text-ink-muted">
          <tr>
            <th scope="col" className="py-2 pr-4 font-normal">
              {head[0]}
            </th>
            <th scope="col" className="py-2 font-normal">
              {head[1]}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, what]) => (
            <tr key={key} className="border-t border-hairline align-top">
              <td className="py-2 pr-4 break-all">{key}</td>
              <td className="py-2">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Draft privacy policy built from what the code does (WP-9.6); needs the owner's review and a legal check. */
export function PrivacyPage() {
  const text = useLegalCopy().legal;
  const signature = useSignatureCopy();
  const draftDate = useLongDate(PRIVACY_DRAFT_DATE);
  return (
    <LegalLayout
      current="privacy"
      title={text.privacyTitle}
      intro={
        <Notice icon={<FilePen />} role="status" className="mt-2">
          <p className="type-body-strong">{text.draftTitle}</p>
          <p>{text.draftBody}</p>
          <p className="type-caption text-ink-muted">{text.draftDate(draftDate)}</p>
        </Notice>
      }
    >
      <LegalSection id="controller" title={text.privacyControllerTitle}>
        <Prose>
          <p>
            {text.privacyController}{" "}
            <a href={withLanguage(IMPRINT_PATH)} className={LINK}>
              {text.imprintLink}
            </a>
          </p>
          <p>
            <Missing />
          </p>
        </Prose>
      </LegalSection>
      <LegalSection id="summary" title={text.privacySummaryTitle}>
        <Prose>
          <p>{text.privacySummary}</p>
        </Prose>
      </LegalSection>
      <LegalSection id="server" title={text.privacyServerTitle}>
        <Prose>
          <p>{text.privacyServer}</p>
          <p>{text.privacyRateLimits}</p>
          <p>{text.privacyQueries}</p>
          <p>{text.privacyReliability}</p>
        </Prose>
      </LegalSection>
      <LegalSection id="hosting" title={text.privacyHostingTitle}>
        <Prose>
          <p>{text.privacyHosting}</p>
          <p>
            <Missing />
          </p>
        </Prose>
      </LegalSection>
      <LegalSection id="storage" title={text.privacyStorageTitle}>
        <Prose>
          <p>{text.privacyStorage}</p>
        </Prose>
        <KeyTable
          caption={text.privacyStorageTitle}
          head={[text.privacyStorageKey, text.privacyStorageWhat]}
          rows={[
            [LOCALE_STORAGE_KEY, text.privacyStorageLocale],
            [THEME_STORAGE_KEY, text.privacyStorageTheme],
            [MAP_STYLE_STORAGE_KEY, text.privacyStorageMapStyle],
            [COLOUR_MODE_KEY, text.privacyStorageColourMode],
            [LABEL_MODE_KEY, text.privacyStorageLabelMode],
            [TERRAIN_STORAGE_KEY, text.privacyStorageTerrain],
            [BUILDINGS_STORAGE_KEY, text.privacyStorageBuildings],
            [SHORTCUTS_STORAGE_KEY, text.privacyStorageShortcuts],
            [SELECTION_TILT_STORAGE_KEY, signature.privacyStorage],
          ]}
        />
      </LegalSection>
      <LegalSection id="hosts" title={text.privacyHostsTitle}>
        <Prose>
          <p>{text.privacyHosts}</p>
        </Prose>
        <KeyTable
          caption={text.privacyHostsTitle}
          head={[text.privacyHost, text.privacyHostUse]}
          rows={[
            [hostOf(TILES_URL), text.privacyHostOpenFreeMap],
            [hostOf(SATELLITE_TILES_URL), text.privacyHostVersatiles],
            [hostOf(DEM_TILES_URL), text.privacyHostMapterhorn],
          ]}
        />
        <Prose>
          <p>{text.privacyOwnServer}</p>
        </Prose>
      </LegalSection>
      <LegalSection id="basis" title={text.privacyBasisTitle}>
        <Prose>
          <p>{text.privacyBasis}</p>
        </Prose>
      </LegalSection>
      <LegalSection id="retention" title={text.privacyRetentionTitle}>
        <Prose>
          <p>{text.privacyRetention}</p>
        </Prose>
      </LegalSection>
      <LegalSection id="rights" title={text.privacyRightsTitle}>
        <Prose>
          <p>
            {text.privacyRights}{" "}
            <a href={withLanguage(IMPRINT_PATH)} className={LINK}>
              {text.imprintLink}
            </a>
          </p>
        </Prose>
      </LegalSection>
      <LegalSection id="planned" title={text.privacyPlannedTitle}>
        <Prose>
          <p>{text.privacyPlanned}</p>
        </Prose>
      </LegalSection>
    </LegalLayout>
  );
}
