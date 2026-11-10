import {
  DB_API_BASE_URL,
  DB_API_PATHS,
  type DbCredentials,
  dbApiHeaders,
  dbApiSecrets,
  type IrisEndpoint,
  irisPath,
} from "./db-apis/client.ts";
import { DB_API_LIMITS, IRIS_PLAN_AHEAD_HOURS, IRIS_RECORDER_CADENCE } from "./db-apis/limits.ts";
import { IRIS_LONG_DISTANCE_COVER, type IrisStation } from "./db-apis/stations.ts";
import type { ClientCertificate } from "./fetch/client-certificate.ts";
import type { SegmentPeriod } from "./storage/paths.ts";

export type SourceKind = "gtfs-rt" | "static-file" | "static-redirect" | "http-document";

export interface SourceMetadata {
  readonly name: string;
  readonly homepageUrl: string;
  readonly licence: string;
  readonly licenceUrl: string | null;
  readonly attribution: string;
}

export interface ProviderLimit {
  readonly capacity: number;
  readonly refillEveryMs: number;
  /** One request of the provider at a time, its token taken once it holds a shared in-flight slot. */
  readonly serial?: boolean;
}

export interface SourceDefinition {
  readonly id: string;
  readonly kind: SourceKind;
  readonly url: string | null;
  readonly provider: string;
  readonly periodMs: number;
  readonly offsetMs: number;
  readonly jitterMs: number;
  readonly segmentPeriod: SegmentPeriod;
  readonly maxBytes: number;
  readonly headersTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly contentType: string;
  readonly fileName?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
  readonly redirectHosts: readonly string[];
  readonly skipReason: string | null;
  readonly metadata: SourceMetadata;
  /** For a URL that depends on the slot, such as the DB Timetables plan three hours ahead. */
  readonly urlAt?: (slotMs: number) => string;
  /**
   * URLs a start without a success within the period still owes, one request each before the
   * regular one: the DB Timetables plans of the current hour to the one before `urlAt`'s.
   */
  readonly catchUpUrlsAt?: (slotMs: number) => readonly string[];
  /** For an XML `http-document` source, the root element a valid answer has. */
  readonly documentRoot?: string;
  /** How long the feed header may stand still before status calls the source stale. */
  readonly staleAfterMs?: number;
  /** Mutual TLS: the source is fetched over node:https with this certificate. */
  readonly clientCertificate?: ClientCertificate;
}

/** The Mobilithek subscription with its opened certificate, or why it cannot be used. */
export interface MobilithekAccess {
  readonly certificate: ClientCertificate | null;
  readonly subscriptionId: string | null;
  readonly problem: string | null;
}

export interface SourceEnvironment {
  readonly otdChApiKey: string | null;
  readonly sncbApiKey: string | null;
  readonly dbCredentials?: DbCredentials | null;
  readonly mobilithek?: MobilithekAccess | null;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;

const SNCB_PROVIDER = "api-management-opendata-production.azure-api.net";
const SNCB_FEED_URL = `https://${SNCB_PROVIDER}/api/gtfs/feed/nmbssncb/rt`;
export const SNCB_KEY_HEADER = "bmc-partner-key";
const TRAINES_MIRROR = "https://stc.traines.eu/mirror/german-delfi-gtfs-rt";
const DELFI_STATIC_SHARING_LINK =
  "https://www.opendata-oepnv.de/ht/de/datensaetze/sharing?tx_vrrkit_view%5Bsharing%5D=eyJkYXRhc2V0IjoiZGV1dHNjaGxhbmR3ZWl0ZS1zb2xsZmFocnBsYW5kYXRlbi1ndGZzIn0";

export const MOBILITHEK_SOURCE_ID = "delfi-mobilithek-rt";
export const MOBILITHEK_API = "https://mobilithek.info:8443/mobilithek/api/v1.0";
const MOBILITHEK_PROVIDER = "mobilithek.info";

export const PROVIDER_LIMITS: Readonly<Record<string, ProviderLimit>> = {
  "stc.traines.eu": { capacity: 4, refillEveryMs: 10 * SECOND },
  [MOBILITHEK_PROVIDER]: { capacity: 2, refillEveryMs: 30 * SECOND },
  "opendata-oepnv.de": { capacity: 2, refillEveryMs: MINUTE },
  "gtfs.de": { capacity: 2, refillEveryMs: 20 * SECOND },
  "gtfsrt.vbb.de": { capacity: 5, refillEveryMs: SECOND },
  "opentransportdata.swiss": { capacity: 1, refillEveryMs: 12 * SECOND },
  [SNCB_PROVIDER]: { capacity: 2, refillEveryMs: 10 * SECOND },
  "db-timetables": { ...DB_API_LIMITS.timetables, serial: true },
  "db-stada": DB_API_LIMITS.stada,
  "db-fasta": DB_API_LIMITS.fasta,
};

export const DEFAULT_PROVIDER_LIMIT: ProviderLimit = { capacity: 2, refillEveryMs: 20 * SECOND };

const PROTOBUF = "application/x-protobuf";

const DELFI_RT_METADATA: SourceMetadata = {
  name: "DELFI GTFS-RT (Prognosedaten) via the traines.eu community mirror",
  homepageUrl: "https://mobilithek.info/offers/858688352316981248",
  licence: "LicenseRef-dcat-ap-de-cc-by-sa",
  licenceUrl: "http://dcat-ap.de/def/licenses/cc-by-sa",
  attribution: "DELFI e.V., mirrored by traines.eu",
};

interface FeedSpec {
  readonly id: string;
  readonly url: string | null;
  readonly provider: string;
  readonly maxMiB: number;
  readonly metadata: SourceMetadata;
  readonly offsetSeconds: number;
  readonly periodMs?: number;
  readonly segmentPeriod?: SegmentPeriod;
  readonly headers?: Record<string, string>;
  readonly secrets?: readonly string[];
  readonly redirectHosts?: readonly string[];
  readonly skipReason?: string | null;
  readonly staleAfterMs?: number;
  readonly clientCertificate?: ClientCertificate;
}

function realtimeFeed(spec: FeedSpec): SourceDefinition {
  const periodMs = spec.periodMs ?? MINUTE;
  return {
    id: spec.id,
    kind: "gtfs-rt",
    url: spec.url,
    provider: spec.provider,
    periodMs,
    offsetMs: spec.offsetSeconds * SECOND,
    jitterMs: 3 * SECOND,
    segmentPeriod: spec.segmentPeriod ?? "hour",
    maxBytes: spec.maxMiB * MIB,
    headersTimeoutMs: 20 * SECOND,
    totalTimeoutMs: Math.min(periodMs - 5 * SECOND, 5 * MINUTE),
    contentType: PROTOBUF,
    headers: spec.headers ?? {},
    secrets: spec.secrets ?? [],
    redirectHosts: spec.redirectHosts ?? [],
    skipReason: spec.skipReason ?? null,
    metadata: spec.metadata,
    ...(spec.staleAfterMs ? { staleAfterMs: spec.staleAfterMs } : {}),
    ...(spec.clientCertificate ? { clientCertificate: spec.clientCertificate } : {}),
  };
}

interface StaticSpec {
  readonly id: string;
  readonly kind: "static-file" | "static-redirect";
  readonly url: string;
  readonly provider: string;
  readonly maxMiB: number;
  readonly offsetMs: number;
  readonly fileName: string;
  readonly metadata: SourceMetadata;
}

function staticFeed(spec: StaticSpec): SourceDefinition {
  return {
    id: spec.id,
    kind: spec.kind,
    url: spec.url,
    provider: spec.provider,
    periodMs: DAY,
    offsetMs: spec.offsetMs,
    jitterMs: 5 * MINUTE,
    segmentPeriod: "day",
    maxBytes: spec.maxMiB * MIB,
    headersTimeoutMs: 60 * SECOND,
    totalTimeoutMs: 30 * MINUTE,
    contentType: "application/zip",
    fileName: spec.fileName,
    headers: {},
    secrets: [],
    redirectHosts: [],
    skipReason: null,
    metadata: spec.metadata,
  };
}

function gtfsDeStatic(id: string, folder: string, label: string): SourceDefinition {
  return staticFeed({
    id,
    kind: "static-file",
    url: `https://download.gtfs.de/germany/${folder}/latest.zip`,
    provider: "gtfs.de",
    maxMiB: 256,
    offsetMs: 6 * HOUR + 30 * MINUTE,
    fileName: "latest.zip",
    metadata: {
      name: `gtfs.de static GTFS, ${label}`,
      homepageUrl: "https://gtfs.de/",
      licence: "CC-BY-4.0",
      licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "DELFI e.V. and GTFS.de",
    },
  });
}

const SNCB_METADATA: SourceMetadata = {
  name: "NMBS-SNCB GTFS-RT (Belgium)",
  homepageUrl: "https://data.belgianmobility.io/",
  licence: "CC-BY-4.0",
  licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Source: NMBS-SNCB, Open Data",
};

/**
 * The Belgian Mobility Company gateway answers 200 without a key too (an anonymous tier of 100 requests per
 * day), so the sources run only with `SNCB_API_KEY`, sent as the `bmc-partner-key` header and never in the URL.
 */
function sncbFeed(
  spec: Pick<FeedSpec, "id" | "maxMiB" | "offsetSeconds" | "periodMs"> & {
    path: string;
    name: string;
  },
  apiKey: string | null,
): SourceDefinition {
  return realtimeFeed({
    id: spec.id,
    url: `${SNCB_FEED_URL}/${spec.path}`,
    provider: SNCB_PROVIDER,
    maxMiB: spec.maxMiB,
    offsetSeconds: spec.offsetSeconds,
    ...(spec.periodMs ? { periodMs: spec.periodMs } : {}),
    headers: apiKey ? { [SNCB_KEY_HEADER]: apiKey } : {},
    secrets: apiKey ? [apiKey] : [],
    skipReason: apiKey ? null : "SNCB_API_KEY is empty",
    metadata: { ...SNCB_METADATA, name: spec.name },
  });
}

/**
 * The official DELFI GTFS-RT through the Mobilithek subscription (K3), the primary DELFI source (D-041); the
 * traines mirror stays as the fallback. Mobilithek answers only with the machine account's client certificate,
 * sends gzip, and answers an unchanged minute to If-Modified-Since or If-None-Match with a 304. The
 * subscription id in the URL is redacted wherever the URL is stored or logged.
 */
export function mobilithekFeed(
  access: MobilithekAccess | null,
  api: string = MOBILITHEK_API,
): SourceDefinition {
  const subscriptionId = access?.subscriptionId ?? null;
  const usable = access?.certificate && subscriptionId;
  return realtimeFeed({
    id: MOBILITHEK_SOURCE_ID,
    url: `${api}/container/subscription?subscriptionID=${encodeURIComponent(subscriptionId ?? "")}`,
    provider: MOBILITHEK_PROVIDER,
    maxMiB: 64,
    offsetSeconds: 12,
    staleAfterMs: 10 * MINUTE,
    secrets: subscriptionId ? [subscriptionId] : [],
    skipReason: usable
      ? null
      : (access?.problem ??
        "MOBILITHEK_CERT_P12, MOBILITHEK_CERT_PASSWORD or the subscription is empty"),
    ...(access?.certificate ? { clientCertificate: access.certificate } : {}),
    metadata: {
      name: "DELFI GTFS-RT (Prognosedaten) via Mobilithek",
      homepageUrl: "https://mobilithek.info/offers/858688352316981248",
      licence: "LicenseRef-dcat-ap-de-cc-by-sa",
      licenceUrl: "http://dcat-ap.de/def/licenses/cc-by-sa",
      attribution: "DELFI e.V., via Mobilithek",
    },
  });
}

/** Every source the recorder polls, with the provider limits and cadences of WP-1.3. */
export function recorderSources(env: SourceEnvironment): SourceDefinition[] {
  return [
    mobilithekFeed(env.mobilithek ?? null),
    realtimeFeed({
      id: "delfi-gtfs-rt",
      url: `${TRAINES_MIRROR}/latest.original.gtfs-rt.pbf`,
      provider: "stc.traines.eu",
      maxMiB: 64,
      offsetSeconds: 20,
      staleAfterMs: 10 * MINUTE,
      metadata: DELFI_RT_METADATA,
    }),
    realtimeFeed({
      id: "delfi-gtfs-rt-deincr",
      url: `${TRAINES_MIRROR}/latest.gtfs-rt.pbf`,
      provider: "stc.traines.eu",
      maxMiB: 160,
      offsetSeconds: 25 * 60 + 40,
      periodMs: HOUR,
      segmentPeriod: "day",
      metadata: {
        ...DELFI_RT_METADATA,
        name: "DELFI GTFS-RT de-incremented by the traines.eu mirror (last 6 hours), hourly checkpoint",
      },
    }),
    realtimeFeed({
      id: "delfi-gtfs-sa",
      url: `${TRAINES_MIRROR}/latest.original.gtfs-sa.pbf`,
      provider: "stc.traines.eu",
      maxMiB: 16,
      offsetSeconds: 50,
      periodMs: 5 * MINUTE,
      staleAfterMs: 60 * MINUTE,
      metadata: {
        ...DELFI_RT_METADATA,
        name: "DELFI GTFS-RT service alerts via the traines.eu community mirror",
        homepageUrl: "https://mobilithek.info/offers/747118037921857536",
      },
    }),
    staticFeed({
      id: "delfi-gtfs",
      kind: "static-redirect",
      url: DELFI_STATIC_SHARING_LINK,
      provider: "opendata-oepnv.de",
      maxMiB: 1536,
      offsetMs: 8 * HOUR + 15 * MINUTE,
      fileName: "delfi-gtfs.zip",
      metadata: {
        name: "DELFI national GTFS timetable (Sollfahrplandaten)",
        homepageUrl: "https://www.opendata-oepnv.de/",
        licence: "CC-BY-4.0",
        licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
        attribution: "DELFI e.V.",
      },
    }),
    realtimeFeed({
      id: "gtfsde-rt",
      url: "https://realtime.gtfs.de/realtime-free.pb",
      provider: "gtfs.de",
      maxMiB: 64,
      offsetSeconds: 35,
      metadata: {
        name: "gtfs.de realtime (free, beta)",
        homepageUrl: "https://gtfs.de/",
        licence: "CC-BY-SA-4.0",
        licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        attribution: "DELFI e.V. and GTFS.de",
      },
    }),
    gtfsDeStatic("gtfsde-static-rv", "rv_free", "regional rail"),
    gtfsDeStatic("gtfsde-static-fv", "fv_free", "long distance rail"),
    realtimeFeed({
      id: "vbb-gtfs-rt",
      url: "https://production.gtfsrt.vbb.de/data",
      provider: "gtfsrt.vbb.de",
      maxMiB: 48,
      offsetSeconds: 5,
      metadata: {
        name: "VBB GTFS-RT",
        homepageUrl: "https://production.gtfsrt.vbb.de/",
        licence: "CC-BY-4.0",
        licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
        attribution: "VBB Verkehrsverbund Berlin-Brandenburg GmbH",
      },
    }),
    realtimeFeed({
      id: "vbn-gtfs-rt",
      url: "https://gtfsr.vbn.de/gtfsr_connect.bin",
      provider: "gtfsr.vbn.de",
      maxMiB: 32,
      offsetSeconds: 10,
      metadata: {
        name: "VBN GTFS-RT",
        homepageUrl: "https://www.vbn.de/",
        licence: "CC-BY-SA-4.0",
        licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        attribution: "VBN Verkehrsverbund Bremen/Niedersachsen",
      },
    }),
    realtimeFeed({
      id: "ovapi-train-updates",
      url: "https://gtfs.ovapi.nl/nl/trainUpdates.pb",
      provider: "gtfs.ovapi.nl",
      maxMiB: 32,
      offsetSeconds: 15,
      staleAfterMs: 20 * MINUTE,
      metadata: {
        name: "OVapi GTFS-RT train updates (Netherlands)",
        homepageUrl: "https://gtfs.ovapi.nl/",
        licence: "LicenseRef-ovapi-free-use",
        licenceUrl: null,
        attribution: "OVapi",
      },
    }),
    realtimeFeed({
      id: "cz-czptt-gtfs-rt",
      url: "https://motis.obehy.cz/get-feeds/cz-czptt-gtfs-rt.pb",
      provider: "motis.obehy.cz",
      maxMiB: 16,
      offsetSeconds: 25,
      metadata: {
        name: "Czech national rail GTFS-RT (CZPTT) via motis.obehy.cz",
        homepageUrl: "https://motis.obehy.cz/",
        licence: "LicenseRef-unstated",
        licenceUrl: null,
        attribution: "Správa železnic, via motis.obehy.cz",
      },
    }),
    realtimeFeed({
      id: "pl-trains-gtfs-rt",
      url: "https://mkuran.pl/gtfs/polish_trains/updates.pb",
      provider: "mkuran.pl",
      maxMiB: 48,
      offsetSeconds: 30,
      metadata: {
        name: "Polish trains GTFS-RT (mkuran.pl)",
        homepageUrl: "https://mkuran.pl/gtfs/",
        licence: "CC-BY-4.0 AND LicenseRef-PKP-PLK-reuse",
        licenceUrl: "https://bip.plk-sa.pl/ponowne-wykorzystywanie",
        attribution:
          "PKP Polskie Linie Kolejowe S.A. open data, processed by Mikołaj Kuranowski (mkuran.pl)",
      },
    }),
    realtimeFeed({
      id: "pl-pkpic-gtfs-rt",
      url: "https://gtfs.kasznia.net/rt/pkpicshim.pb",
      provider: "gtfs.kasznia.net",
      maxMiB: 16,
      offsetSeconds: 40,
      staleAfterMs: 10 * MINUTE,
      metadata: {
        name: "PKP Intercity GTFS-RT shim (gtfs.kasznia.net)",
        homepageUrl: "https://gtfs.kasznia.net/",
        licence: "CC-BY-4.0 AND LicenseRef-PKP-PLK-reuse",
        licenceUrl: "https://bip.plk-sa.pl/ponowne-wykorzystywanie",
        attribution:
          "PKP Intercity and PKP Polskie Linie Kolejowe S.A. (data via mkuran.pl), via gtfs.kasznia.net",
      },
    }),
    sncbFeed(
      {
        id: "be-sncb-gtfs-rt",
        path: "trip-update?format=protobuf&unroll=false",
        maxMiB: 16,
        offsetSeconds: 45,
        name: "NMBS-SNCB GTFS-RT trip updates (Belgium)",
      },
      env.sncbApiKey,
    ),
    sncbFeed(
      {
        id: "be-sncb-gtfs-sa",
        path: "alert?format=protobuf",
        maxMiB: 4,
        offsetSeconds: 2 * 60 + 15,
        periodMs: 5 * MINUTE,
        name: "NMBS-SNCB GTFS-RT service alerts (Belgium)",
      },
      env.sncbApiKey,
    ),
    realtimeFeed({
      id: "fr-sncf-gtfs-rt",
      url: "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates",
      provider: "transport.data.gouv.fr",
      maxMiB: 16,
      offsetSeconds: 52,
      metadata: {
        name: "SNCF GTFS-RT trip updates via the transport.data.gouv.fr proxy",
        homepageUrl: "https://transport.data.gouv.fr/",
        licence: "ODbL-1.0",
        licenceUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
        attribution: "SNCF, via transport.data.gouv.fr",
      },
    }),
    realtimeFeed({
      id: "ch-otd-gtfs-rt",
      url: "https://api.opentransportdata.swiss/la/gtfs-rt",
      provider: "opentransportdata.swiss",
      maxMiB: 64,
      offsetSeconds: 55,
      headers: env.otdChApiKey ? { authorization: `Bearer ${env.otdChApiKey}` } : {},
      redirectHosts: ["largeapi.opentransportdata.swiss"],
      secrets: env.otdChApiKey ? [env.otdChApiKey] : [],
      skipReason: env.otdChApiKey ? null : "OTD_CH_API_KEY is empty",
      metadata: {
        name: "opentransportdata.swiss GTFS-RT (Switzerland)",
        homepageUrl: "https://opentransportdata.swiss/",
        licence: "LicenseRef-opentransportdata-swiss-terms",
        licenceUrl: "https://opentransportdata.swiss/en/terms-of-use/",
        attribution: "opentransportdata.swiss",
      },
    }),
  ];
}

export const DB_METADATA = {
  licence: "CC-BY-4.0",
  licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Deutsche Bahn AG",
} as const;

export const DB_MARKETPLACE = "https://developers.deutschebahn.com/db-api-marketplace/apis/product";
type PolledEndpoint = Exclude<IrisEndpoint, "rchg">;
const IRIS_PERIOD_MS: Readonly<Record<PolledEndpoint, number>> = {
  fchg: IRIS_RECORDER_CADENCE.fchgEveryMs,
  plan: IRIS_RECORDER_CADENCE.planEveryMs,
};
const IRIS_MAX_MIB: Readonly<Record<IrisEndpoint, number>> = { rchg: 4, fchg: 2, plan: 4 };
const DB_KEYS_MISSING = "DB_CLIENT_ID or DB_API_KEY is empty";

interface DbDocumentSpec {
  readonly id: string;
  readonly provider: string;
  readonly path: string;
  readonly periodMs: number;
  readonly offsetMs: number;
  readonly segmentPeriod: SegmentPeriod;
  readonly maxMiB: number;
  readonly contentType: string;
  readonly name: string;
  readonly homepageUrl: string;
  readonly urlAt?: (slotMs: number) => string;
  readonly catchUpUrlsAt?: (slotMs: number) => readonly string[];
  readonly documentRoot?: string;
  readonly totalTimeoutMs?: number;
}

function dbDocument(spec: DbDocumentSpec, credentials: DbCredentials | null): SourceDefinition {
  return {
    id: spec.id,
    kind: "http-document",
    url: `${DB_API_BASE_URL}${spec.path}`,
    provider: spec.provider,
    periodMs: spec.periodMs,
    offsetMs: spec.offsetMs,
    jitterMs: 2 * SECOND,
    segmentPeriod: spec.segmentPeriod,
    maxBytes: spec.maxMiB * MIB,
    headersTimeoutMs: 20 * SECOND,
    totalTimeoutMs: spec.totalTimeoutMs ?? Math.min(spec.periodMs - 5 * SECOND, MINUTE),
    contentType: spec.contentType,
    headers: credentials ? dbApiHeaders(credentials) : {},
    secrets: dbApiSecrets(credentials),
    redirectHosts: [],
    skipReason: credentials ? null : DB_KEYS_MISSING,
    metadata: { ...DB_METADATA, name: spec.name, homepageUrl: spec.homepageUrl },
    ...(spec.urlAt ? { urlAt: spec.urlAt } : {}),
    ...(spec.catchUpUrlsAt ? { catchUpUrlsAt: spec.catchUpUrlsAt } : {}),
    ...(spec.documentRoot ? { documentRoot: spec.documentRoot } : {}),
  };
}

function irisSource(
  endpoint: PolledEndpoint,
  station: IrisStation,
  index: number,
  count: number,
  credentials: DbCredentials | null,
): SourceDefinition {
  const periodMs = IRIS_PERIOD_MS[endpoint];
  const base = `${DB_API_BASE_URL}${DB_API_PATHS.timetables}`;
  const planAt = (slotMs: number, hours: number) =>
    `${base}${irisPath("plan", station.eva, slotMs + hours * HOUR)}`;
  const aheadPlan = (slotMs: number) => planAt(slotMs, IRIS_PLAN_AHEAD_HOURS);
  const catchUpPlans = (slotMs: number) =>
    Array.from({ length: IRIS_PLAN_AHEAD_HOURS }, (_, hours) => planAt(slotMs, hours));
  return dbDocument(
    {
      id: `db-iris-${endpoint}-${station.eva}`,
      provider: "db-timetables",
      path: `${DB_API_PATHS.timetables}/${endpoint}/${station.eva}`,
      periodMs,
      offsetMs: Math.floor((index * periodMs) / count),
      segmentPeriod: endpoint === "plan" ? "day" : "hour",
      maxMiB: IRIS_MAX_MIB[endpoint],
      contentType: "application/xml",
      documentRoot: "timetable",
      name: `DB Timetables (IRIS) ${endpoint} for ${station.label} (EVA ${station.eva})`,
      homepageUrl: `${DB_MARKETPLACE}/timetables`,
      ...(endpoint === "plan" ? { urlAt: aheadPlan, catchUpUrlsAt: catchUpPlans } : {}),
    },
    credentials,
  );
}

/**
 * The DB API sources (K1): for each EVA of the long-distance cover (D-041) the DB Timetables full changes every
 * 3 minutes and once an hour the plan of the hour three hours ahead (a start without a recent plan also asks the
 * current hour and the two after it), about 19 requests a minute through the one `db-timetables`
 * bucket (at most 41 requests in any minute against the plan's 60); StaDa's full station list once a day as a
 * JSON document (one full list per day per key); FaSta's facility states every 15 minutes. The keys travel
 * only as the `DB-Client-Id` and `DB-Api-Key` headers and are redaction secrets. Not part of
 * `recorderSources`: the recorder adds them only when `RECORDER_DB_APIS=1` (`configuredSources`).
 */
export function dbApiSources(
  env: Pick<SourceEnvironment, "dbCredentials">,
  stations: readonly IrisStation[] = IRIS_LONG_DISTANCE_COVER,
): SourceDefinition[] {
  const credentials = env.dbCredentials ?? null;
  const iris = (["fchg", "plan"] as const).flatMap((endpoint) =>
    stations.map((station, index) =>
      irisSource(endpoint, station, index, stations.length, credentials),
    ),
  );
  const stada = dbDocument(
    {
      id: "db-stada-stations",
      provider: "db-stada",
      path: `${DB_API_PATHS.stada}/stations`,
      periodMs: DAY,
      offsetMs: 5 * HOUR + 40 * MINUTE,
      segmentPeriod: "day",
      maxMiB: 64,
      contentType: "application/json",
      totalTimeoutMs: 5 * MINUTE,
      name: "DB StaDa station data, full list",
      homepageUrl: `${DB_MARKETPLACE}/stada`,
    },
    credentials,
  );
  const fasta = dbDocument(
    {
      id: "db-fasta-facilities",
      provider: "db-fasta",
      path: `${DB_API_PATHS.fasta}/facilities`,
      periodMs: 15 * MINUTE,
      offsetMs: 7 * MINUTE + 30 * SECOND,
      segmentPeriod: "day",
      maxMiB: 16,
      contentType: "application/json",
      name: "DB FaSta lift and escalator states",
      homepageUrl: `${DB_MARKETPLACE}/fasta`,
    },
    credentials,
  );
  return [...iris, stada, fasta];
}
