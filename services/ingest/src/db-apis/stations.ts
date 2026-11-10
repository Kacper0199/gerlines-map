export type IrisStationRole = "hub" | "regional" | "border" | "cover" | "meta";

export interface IrisStation {
  readonly eva: number;
  readonly label: string;
  readonly role: IrisStationRole;
}

/**
 * The stations polled for SP-2's coverage check and long-distance validation. EVA numbers and names come
 * from `stop_place` in the WP-2.1 load of the DELFI feed of 2026-10-19 (`gerlines_wp21`); labels are for logs.
 */
export const IRIS_STATIONS: readonly IrisStation[] = [
  { eva: 8011160, label: "S+U Berlin Hauptbahnhof", role: "hub" },
  { eva: 8002549, label: "Hamburg Hbf", role: "hub" },
  { eva: 8000261, label: "München Hbf", role: "hub" },
  { eva: 8000207, label: "Köln Hbf", role: "hub" },
  { eva: 8000105, label: "Frankfurt (Main) Hauptbahnhof", role: "hub" },
  { eva: 8000096, label: "Stuttgart Hauptbahnhof", role: "hub" },
  { eva: 8000085, label: "Düsseldorf Hbf", role: "hub" },
  { eva: 8000152, label: "Hannover Hauptbahnhof", role: "hub" },
  { eva: 8010205, label: "Leipzig Hbf", role: "hub" },
  { eva: 8000284, label: "Nürnberg Hbf", role: "hub" },
  { eva: 8000244, label: "Mannheim, Hauptbahnhof", role: "hub" },
  { eva: 8010101, label: "Erfurt Hbf", role: "hub" },
  { eva: 8010304, label: "Rostock Hauptbahnhof", role: "regional" },
  { eva: 8010073, label: "Cottbus, Hauptbahnhof", role: "regional" },
  { eva: 8002924, label: "Hof Hbf", role: "regional" },
  { eva: 8000001, label: "Aachen, Hbf", role: "border" },
  { eva: 8010113, label: "Frankfurt (Oder), Bahnhof", role: "border" },
  { eva: 8000298, label: "Passau Hbf", role: "border" },
  { eva: 8000026, label: "Basel Bad Bf", role: "border" },
  { eva: 8000879, label: "Bad Bentheim", role: "border" },
];

/**
 * The recorder's long-distance IRIS poller (D-041 item 1): the first 50 stations of the greedy cover of hsr, ld
 * and night runs with gaps of at most 60 minutes over the whole weekday 2026-11-06 (Friday, 00:00 to 24:00
 * Europe/Berlin) of the DELFI feed of 2026-11-02 (`spikes/sp-2-coverage/scripts/iris-cover-weekday.sh`, results in
 * `spikes/sp-2-coverage/results/iris-station-cover-gap60-2026-11-06.txt`), in cover order, each followed by its
 * meta EVAs that IRIS serves and long-distance trains use (`meta_evas`, `is_active_iris` and
 * `available_transports` in the Bahn-Vorhersage `stations.parquet` of 2026-10-28, ODbL; bus stops, street exits
 * and regional-only stops left out). Labels are the Bahn-Vorhersage names, for logs.
 */
export const IRIS_LONG_DISTANCE_COVER: readonly IrisStation[] = [
  { eva: 8000152, label: "Hannover Hbf", role: "cover" },
  { eva: 8000105, label: "Frankfurt(Main)Hbf", role: "cover" },
  { eva: 8011160, label: "Berlin Hbf", role: "cover" },
  { eva: 8098160, label: "Berlin Hbf", role: "meta" },
  { eva: 8000207, label: "Köln Hbf", role: "cover" },
  { eva: 8000244, label: "Mannheim Hbf", role: "cover" },
  { eva: 8010101, label: "Erfurt Hbf", role: "cover" },
  { eva: 8002549, label: "Hamburg Hbf", role: "cover" },
  { eva: 8000080, label: "Dortmund Hbf", role: "cover" },
  { eva: 8000261, label: "München Hbf", role: "cover" },
  { eva: 8098261, label: "München Hbf Gl.27-36", role: "meta" },
  { eva: 8098262, label: "München Hbf Gl.5-10", role: "meta" },
  { eva: 8000096, label: "Stuttgart Hbf", role: "cover" },
  { eva: 8000284, label: "Nürnberg Hbf", role: "cover" },
  { eva: 8000115, label: "Fulda", role: "cover" },
  { eva: 8010205, label: "Leipzig Hbf", role: "cover" },
  { eva: 8000050, label: "Bremen Hbf", role: "cover" },
  { eva: 8000260, label: "Würzburg Hbf", role: "cover" },
  { eva: 8000085, label: "Düsseldorf Hbf", role: "cover" },
  { eva: 8003200, label: "Kassel-Wilhelmshöhe", role: "cover" },
  { eva: 8010224, label: "Magdeburg Hbf", role: "cover" },
  { eva: 8000191, label: "Karlsruhe Hbf", role: "cover" },
  { eva: 8000036, label: "Bielefeld Hbf", role: "cover" },
  { eva: 8000013, label: "Augsburg Hbf", role: "cover" },
  { eva: 8000322, label: "Rottweil", role: "cover" },
  { eva: 8010089, label: "Dresden-Neustadt", role: "cover" },
  { eva: 8070003, label: "Frankfurt(M) Flughafen Fernbf", role: "cover" },
  { eva: 8070004, label: "Frankfurt(M) Flughafen Regionalbf", role: "meta" },
  { eva: 8000107, label: "Freiburg(Breisgau) Hbf", role: "cover" },
  { eva: 8010159, label: "Halle(Saale)Hbf", role: "cover" },
  { eva: 8000049, label: "Braunschweig Hbf", role: "cover" },
  { eva: 8000263, label: "Münster(Westf)Hbf", role: "cover" },
  { eva: 8000320, label: "Rosenheim", role: "cover" },
  { eva: 8000206, label: "Koblenz Hbf", role: "cover" },
  { eva: 8002041, label: "Frankfurt(Main)Süd", role: "cover" },
  { eva: 8000170, label: "Ulm Hbf", role: "cover" },
  { eva: 8000142, label: "Hagen Hbf", role: "cover" },
  { eva: 8000183, label: "Ingolstadt Hbf", role: "cover" },
  { eva: 8010324, label: "Schwerin Hbf", role: "cover" },
  { eva: 8000147, label: "Hamburg-Harburg", role: "cover" },
  { eva: 8010382, label: "Wittenberge", role: "cover" },
  { eva: 8011102, label: "Berlin Gesundbrunnen", role: "cover" },
  { eva: 8002553, label: "Hamburg-Altona", role: "cover" },
  { eva: 8000073, label: "Singen(Hohentwiel)", role: "cover" },
  { eva: 8003368, label: "Köln Messe/Deutz", role: "cover" },
  { eva: 8073368, label: "Köln Messe/Deutz Gl.11-12", role: "meta" },
  { eva: 8000664, label: "Augustfehn", role: "cover" },
  { eva: 8000108, label: "Freilassing", role: "cover" },
  { eva: 8001055, label: "Böblingen", role: "cover" },
  { eva: 8001774, label: "Emmerich(Gr)", role: "cover" },
  { eva: 8010338, label: "Stralsund Hbf", role: "cover" },
  { eva: 8000128, label: "Göttingen", role: "cover" },
  { eva: 8001751, label: "Ellwangen", role: "cover" },
  { eva: 8000156, label: "Heidelberg Hbf", role: "cover" },
  { eva: 8000294, label: "Osnabrück Hbf", role: "cover" },
];
