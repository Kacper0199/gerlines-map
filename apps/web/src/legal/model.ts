export type LicenceNote = "perProvider" | "perFile";

export interface Licence {
  readonly name: string | LicenceNote;
  readonly url: string | null;
}

export type CreditNote = "perPhoto" | "imageryProviders";

export type SourceStatus = "used" | "planned" | "reference" | "notUsed";

export type SourceGroupId = "rail" | "foreign" | "map" | "history" | "catalogue" | "software";

export interface SourceEntry {
  readonly id: string;
  readonly group: SourceGroupId;
  readonly provider: string;
  readonly url: string | null;
  readonly licences: readonly Licence[];
  readonly attribution:
    | string
    | { readonly note: CreditNote }
    | { readonly note: "changed"; readonly holder: string }
    | { readonly note: "mirror"; readonly holders: string; readonly mirror: string }
    | null;
  readonly status: SourceStatus;
  readonly docNames: readonly string[];
}

export interface ProviderRow {
  readonly coverage: string;
  readonly provider: string;
  readonly dataset: string | null;
  readonly url: string | null;
  readonly licence: string;
  readonly licenceUrl: string | null;
}
