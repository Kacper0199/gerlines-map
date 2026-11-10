# Catalogue seeds

Versioned seed data for categories, operators, Verkehrsverbünde, vehicle series, liveries and line colours.
Every row names its source (`source`, and `field_sources` for single fields) from `sources.yaml`, which holds
the licence of each source. Values no source gives stay empty, with the reason in `missing`. The models,
loader and coverage report live in [pipelines/catalog](../pipelines/catalog/README.md).

| File | Rows | Built from | How it is made |
| --- | --- | --- | --- |
| `sources.yaml` | every source with its SPDX licence | | by hand |
| `categories.yaml` | the nine canonical categories of migration 0010, names in English, German and Polish | GerLines | by hand; German and Polish names wait for a maintainer's review |
| `operators.yaml` | the 144 train operators of the DELFI feed of 2026-10-19, keyed by the static import slug | Wikidata (CC0), Träwelling operator matching (CC0), DELFI agency names (CC BY 4.0) | Wikidata items from the Träwelling mapping or a reviewed Wikidata search; facts from Wikidata; the first of an operator's `parents` decides its group in the Operator colour mode, so after a change run `pnpm --filter @gerlines/web operator-groups` |
| `verbuende.yaml` | 81 Verkehrsverbünde with Länder and SPNV integration | German Wikipedia list (CC BY-SA 4.0), Wikidata (CC0) | `gerlines-catalog verbuende`, do not edit |
| `vehicle-series.yaml` | 80 priority series chosen by hand | Wikidata (CC0), German Wikipedia infoboxes (CC BY-SA 4.0) | Wikidata facts, plain infobox values where Wikidata has none |
| `liveries.yaml` | liveries with a cited colour source; a livery that names an operator and a series is a rule of the 3D car layer (optional `lines`, `valid_from`, `valid_to` and `also_operator_ids`, the other operators whose trains of the series wear it, such as DB Fernverkehr on the SNCF TGV) | German Wikipedia (CC BY-SA 4.0), Wikidata (CC0) for hex values, Wikimedia Commons photos (CC0, CC BY, CC BY-SA) sampled for the operator liveries | by hand from the cited articles; hex values sampled from a photo name it in `hex_source` and `sources.yaml` records the boxes |
| `fleet-rules.yaml` | which series runs a line (layer L2), an operator (L3, its dominant series) or a category (L4, the generic model) | German Wikipedia line lists and network articles (CC BY-SA 4.0), GerLines for the generic models | ICE lines by `gerlines-catalog fleet-ice-lines`; IC, EC, RE and RB lines by `gerlines-catalog fleet-ic-regional-lines` from the IC line list and the column Fahrzeuge im Regelbetrieb of the Länder line lists (rows matched to one DELFI feed by operator, line and terminal stops, match share at least 0.95 with listed exceptions, the feed file and its sha256 in the generated header); the other rows by hand; each with the quoted evidence; rebuilt for each timetable year ([pipelines/catalog](../pipelines/catalog/README.md#fleet-rules-for-a-new-timetable-year)) |
| `identical-bodies.yaml` | pairs of series whose car bodies are the same, so a series without a 3D model can show the model of the other: `accepted` rows (a citable source says the bodies are identical, no chains, the related series has a forge model, the series has none) and `rejected` rows that record examined pairs | German Wikipedia article revisions (CC BY-SA 4.0) | by hand with a verbatim sentence as evidence; `gerlines-catalog validate` checks it, and after a change run `pnpm --filter @gerlines/web identical-bodies` |
| `photos.yaml` | vehicle photos from Wikimedia Commons: file, author, licence, links, crop focus, approval record and the SHA-256 of the local copies | Wikimedia Commons API metadata, GerLines review | `gerlines-catalog photos` and `tools/photo-review`, do not edit by hand |
| `line-colours.csv` | line badge colours of catalogue operators | Träwelling line-colors (CC0) | `gerlines-catalog line-colours`, do not edit |

The picks in `photos.yaml` were pre-selected automatically and wait for a maintainer's review (`user_review: pending`).

Licences of this folder (REUSE.toml): `categories.yaml` and `sources.yaml` CC0-1.0 (our curation);
`operators.yaml` and `line-colours.csv` CC0-1.0 AND CC-BY-4.0 (Wikidata, Träwelling and our curation under CC0,
DELFI agency names under CC BY 4.0); `verbuende.yaml`, `vehicle-series.yaml`, `liveries.yaml` and `fleet-rules.yaml` CC-BY-SA-4.0 AND
CC0-1.0 (facts from German Wikipedia, share-alike, with Wikidata and our curation); `identical-bodies.yaml` CC-BY-SA-4.0
(passages of German Wikipedia articles and our curation).

Operator aliases in `operators.yaml` never use a source the static import writes aliases under (`delfi-gtfs`,
`traines-delfi-eva`): the loader replaces every alias of the sources it uses, so such an alias would remove the
static import's aliases.
