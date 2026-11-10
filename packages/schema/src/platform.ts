const TRACK_LABELS = [
  "gleis",
  "gl",
  "tor",
  "kolej",
  "voie",
  "spoor",
  "spor",
  "binario",
  "bin",
  "track",
  "trk",
];
const PLATFORM_LABELS = [
  "bahnsteig",
  "bstg",
  "steig",
  "peron",
  "perron",
  "nástupiště",
  "nastupiste",
  "quai",
  "platform",
  "plat",
  "pl",
  "pf",
  "position",
  "pos",
];
const LABEL_SOURCE = [...TRACK_LABELS, ...PLATFORM_LABELS].join("|");
const LABEL_END = String.raw`(?:\.\s*|\s+|(?=\d))`;
const LABEL = String.raw`(?:(${LABEL_SOURCE})${LABEL_END}|(g|#)(?=\d))`;
const LABELLED = new RegExp(
  String.raw`^${LABEL}(.+?)(?:\s*,?\s+(${LABEL_SOURCE})${LABEL_END}(.+))?$`,
  "iu",
);
const SECTOR_WORD = /\s+(?:abschnitt|abschn\.|sektor|sector|secteur|sek\.)\s*/iu;
const SUFFIX = /(?:\s*\((?:[us]\d*(?:\/[us]?\d+)*)\)|-s|_\d{2})$/iu;
const TRACK = /^(\d{1,3})(?:([A-Za-z]?)| ([a-z]))$/u;
const PAIR = /^(\d{1,3})\s*([/-])\s*(\d{1,3})$/u;
const ROMAN = /^[IVX]{1,4}$/u;

/**
 * Shapes of the stop codes some feeds put in the platform field, measured over the platform values
 * of the 2026-10-19 and 2026-10-26 DELFI feeds and their realtime: "DB", "DB2", "GeoDB"; place
 * abbreviations with an S-Bahn or direction mark ("S-Mue", "SMue3", "RiMue", "SEinw", "Rosen");
 * direction codes ("RiN", "RiDAH"); stop position codes of two or three capitals ("GN", "TS",
 * "BS2"); rail replacement bus stops ("SEV-F", "SEV 2").
 */
const STOP_CODES = [
  /^(?:Geo)?DB\d*$/u,
  /^(?:S-?|Ri)?[A-Za-z][a-z]{2,}\d?$/u,
  /^Ri[A-Z]{1,3}$/u,
  /^[A-Z]{2,3}\d?$/u,
  /^SEV(?:[\s-]|[A-Z][a-z])/u,
];

const VRS_DISTRICTS = ["05314", "05315", "05316", "05362", "05366", "05374", "05378", "05382"];
const OWL_DISTRICTS = ["05711", "05754", "05758", "05762", "05766", "05770", "05774"];

/**
 * DHID districts whose DELFI stop points carry a stop number, not a track, in the platform field,
 * with the lowest such number. The VRS numbers its rail stop points from 70 up (Köln Hbf
 * 83 to 91, Köln Messe/Deutz 84 to 92, Bonn Hbf 78 to 82, Köln Buchforst 74 and 75); the OWL
 * districts write 9 in front of the track (91, 98, 913). Measured against DB IRIS station plans
 * for the same train numbers (recorded 2026-11-08 and 09, DELFI feed of 2026-10-19): none of 39
 * at Köln Hbf, 275 at Köln Messe/Deutz and 98 at Bielefeld Hbf agreed, while the other recorded
 * stations mostly did. The realtime feeds name the same stop points, so the same numbers. Each
 * timetable load rechecks the districts (`pipelines/static_import` `platform_codes.py`, which
 * mirrors these floors, into `platform_stop_numbers` of `load-report.json`); the DELFI rollover
 * runbook says how to revisit the rule when it warns.
 */
const STOP_NUMBER_FROM: ReadonlyMap<string, number> = new Map([
  ...VRS_DISTRICTS.map((district) => [district, 70] as const),
  ...OWL_DISTRICTS.map((district) => [district, 90] as const),
]);
const DHID_DISTRICT = /^[a-z]{2}:(\d{5}):/u;

function isStopNumber(platform: string, dhid: string | null | undefined): boolean {
  const district = DHID_DISTRICT.exec(dhid ?? "")?.[1];
  const from = district === undefined ? undefined : STOP_NUMBER_FROM.get(district);
  return from !== undefined && /^\d+$/u.test(platform) && Number(platform) >= from;
}

function isTrackLabel(label: string | undefined): boolean {
  return label !== undefined && TRACK_LABELS.includes(label.toLowerCase());
}

function unlabelled(text: string): string {
  const match = LABELLED.exec(text);
  if (!match) return text;
  const [, word, short, first, secondWord, second] = match;
  if (second !== undefined && isTrackLabel(secondWord) && !isTrackLabel(word ?? short)) {
    return second;
  }
  return second === undefined ? (first ?? "") : (first ?? "").trim();
}

function pairOf(text: string): string | null {
  const pair = PAIR.exec(text);
  if (!pair) return null;
  const [, from = "", separator, to = ""] = pair;
  if (separator === "-") return `${from}-${to}`;
  return Number(to) === Number(from) + 1 ? `${from}-${to}` : null;
}

/**
 * The platform as a passenger reads it on the station sign, without the word for platform or track
 * (the card prints its own label): "Gl. 1", "Gl1", "Gleis 1", "Bstg. 1", "Pl. 1", "Voie 1", "tor 1"
 * and "Pos. 1" become "1"; "1a_96" (with the platform height) and "1 (U2)" become "1a" and "1";
 * "4 a" becomes "4a" while a sector stays apart ("12 B"); a pair of neighbouring tracks "9/10"
 * becomes "9-10"; with a platform and a track named ("Peron II, tor 3") the track is kept. Values
 * it cannot read, such as "10 A-D" or "1 Süd", stay as the source gave them, trimmed. Stop codes
 * some feeds put in the platform field (`STOP_CODES`) and an empty value become null, and so does a
 * stop number of a district that numbers its stop points (`STOP_NUMBER_FROM`), given the DHID of the
 * stop place or stop point. The function is idempotent; the raw value stays in the stored timetable
 * and realtime rows.
 */
export function normalizePlatform(
  raw: string | null | undefined,
  dhid?: string | null,
): string | null {
  const platform = readPlatform(raw);
  return platform !== null && isStopNumber(platform, dhid) ? null : platform;
}

/**
 * Whether a raw platform code is a stop number of a district that numbers its stop points
 * (`STOP_NUMBER_FROM`), given the DHID of the stop place or stop point: the code `normalizePlatform`
 * reads as a track without the DHID and drops with it.
 */
export function isDistrictStopNumber(
  raw: string | null | undefined,
  dhid: string | null | undefined,
): boolean {
  const platform = readPlatform(raw);
  return platform !== null && isStopNumber(platform, dhid);
}

function readPlatform(raw: string | null | undefined): string | null {
  const text = (raw ?? "")
    .replace(/\s+/gu, " ")
    .replace(/[‐‑‒–—]/gu, "-")
    .trim();
  if (text === "") return null;
  const bare = unlabelled(text).replace(SECTOR_WORD, " ").replace(SUFFIX, "").trim();
  if (bare === "") return null;
  const track = TRACK.exec(bare);
  if (track) return `${track[1]}${track[2] ?? track[3] ?? ""}`;
  const pair = pairOf(bare);
  if (pair !== null) return pair;
  if (ROMAN.test(bare)) return bare;
  return STOP_CODES.some((code) => code.test(bare)) ? null : bare;
}
