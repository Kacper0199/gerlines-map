/** Requests a client may make per minute (search, statistics, journeys, train details, live keys, data status, photos). */
export const SEARCH_RATE_LIMIT = 120;
export const STATS_RATE_LIMIT = 60;
/** Statistics periods longer than 31 days also count against this limit. */
export const STATS_LONG_RATE_LIMIT = 10;
export const JOURNEY_RATE_LIMIT = 30;
/** Punctuality lookups: each train number the statistics must read costs one. */
export const RELIABILITY_RATE_LIMIT = 60;
export const TRAIN_DETAIL_RATE_LIMIT = 120;
export const LIVE_KEY_RATE_LIMIT = 120;
/** Data status answers a client may ask a minute; the answer itself changes every 30 s. */
export const STATUS_RATE_LIMIT = 60;
/** Photo files a client may fetch a minute: the credits page shows about a hundred at once. */
export const PHOTO_FILE_RATE_LIMIT = 300;
/** Coach sequence calls one client may cause per hour: a twentieth of the 600 an hour all clients share. */
export const SEQUENCE_SHARE_PER_HOUR = 30;

export const RELIABILITY_CACHE_MS = 10 * 60_000;
export const RELIABILITY_CACHE_ENTRIES = 2_000;
export const RELIABILITY_HTTP_CACHE_S = 300;

/** The numbers the privacy page states about what the API counts and keeps, from the code itself. */
export const PRIVACY_FACTS = {
  searchPerMinute: SEARCH_RATE_LIMIT,
  statsPerMinute: STATS_RATE_LIMIT,
  longStatsPerMinute: STATS_LONG_RATE_LIMIT,
  journeysPerMinute: JOURNEY_RATE_LIMIT,
  reliabilityPerMinute: RELIABILITY_RATE_LIMIT,
  trainDetailsPerMinute: TRAIN_DETAIL_RATE_LIMIT,
  liveKeysPerMinute: LIVE_KEY_RATE_LIMIT,
  statusPerMinute: STATUS_RATE_LIMIT,
  photoFilesPerMinute: PHOTO_FILE_RATE_LIMIT,
  sequencePerHour: SEQUENCE_SHARE_PER_HOUR,
  reliabilityCacheMinutes: RELIABILITY_CACHE_MS / 60_000,
  reliabilityCacheEntries: RELIABILITY_CACHE_ENTRIES,
  reliabilityHttpCacheMinutes: RELIABILITY_HTTP_CACHE_S / 60,
} as const;
