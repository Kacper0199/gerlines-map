---
version: alpha
name: GerLines
description: Live map of every train in Germany. Direction B Fahrplan, the clarity of a printed timetable on a calm warm-graphite map.
colors:
  primary: "#F08C00"
  on-primary: "#1B1A18"
  primary-text: "#A85F00"
  secondary: "#5F97DE"
  neutral: "#F1EFEA"
  surface: "#FBFAF7"
  ink: "#1B1A18"
  ink-muted: "#5F5B54"
  hairline: "#DAD6CC"
  passed: "#8C877D"
  focus: "#1B1A18"
  error: "#C2503F"
  map-land: "#EDEBE5"
  map-water: "#C7CFD3"
  map-sea: "#A2AFB7"
  map-rail: "#B2AEA5"
  map-label: "#625E57"
  map-label-city: "#47433D"
  map-label-water: "#46555D"
  map-land-tint: "#E6E3DC"
  map-green: "#E1E4DA"
  map-building: "#E3E0D8"
  map-building-outline: "#E6E3DC"
  map-road-minor: "#E0DDD5"
  map-road-major-casing: "#E6E3DC"
  map-road-major: "#D6D2C8"
  map-road-motorway-casing: "#E6E3DC"
  map-road-motorway: "#C9C4B8"
  map-mask: "#6E6C66"
  map-outline: "#7A766E"
  map-boundary-state: "#CFCBC1"
  map-boundary-country: "#7C7870"
  map-rail-satellite: "#A7A39B"
  map-boundary-satellite: "#8D8A84"
  cat-hsr: "#26231E"
  cat-ld: "#6A604C"
  cat-rfast: "#3F83D6"
  cat-reg: "#1F5EB0"
  cat-sbahn: "#17814C"
  cat-foreign: "#6F6790"
  delay-ok: "#1F8E78"
  delay-minor: "#9E7A00"
  delay-major: "#C2503F"
  delay-severe: "#7A2A5C"
  primary-dark: "#FFB000"
  on-primary-dark: "#17181A"
  primary-text-dark: "#FFB000"
  neutral-dark: "#1F2023"
  surface-dark: "#17181A"
  ink-dark: "#F1EFEA"
  ink-muted-dark: "#A09D96"
  hairline-dark: "#2C2E32"
  passed-dark: "#66676B"
  focus-dark: "#F1EFEA"
  error-dark: "#E58F8F"
  map-land-dark: "#1A1B1D"
  map-water-dark: "#121315"
  map-sea-dark: "#080C11"
  map-rail-dark: "#3A3B3F"
  map-label-dark: "#8D8A84"
  map-label-city-dark: "#A7A39B"
  map-label-water-dark: "#868480"
  map-land-tint-dark: "#1E1F21"
  map-green-dark: "#1D1F1E"
  map-building-dark: "#1E1F21"
  map-building-outline-dark: "#1E1F21"
  map-road-minor-dark: "#262729"
  map-road-major-casing-dark: "#212224"
  map-road-major-dark: "#2C2D2F"
  map-road-motorway-casing-dark: "#212224"
  map-road-motorway-dark: "#323336"
  map-mask-dark: "#0C0C0D"
  map-outline-dark: "#5A5B60"
  map-boundary-state-dark: "#2F3033"
  map-boundary-country-dark: "#55565B"
  cat-hsr-dark: "#EDE6D6"
  cat-ld-dark: "#B9AF98"
  cat-rfast-dark: "#9CC5F6"
  cat-reg-dark: "#5F97DE"
  cat-sbahn-dark: "#5FC08A"
  cat-foreign-dark: "#8F87A8"
  delay-ok-dark: "#7CC9B4"
  delay-minor-dark: "#E8D7A0"
  delay-major-dark: "#E58F8F"
  delay-severe-dark: "#E86BD0"
typography:
  display: { fontFamily: Overpass Mono, fontSize: 38px, fontWeight: 600, lineHeight: 1, letterSpacing: -0.03em }
  headline: { fontFamily: Overpass, fontSize: 32px, fontWeight: 800, lineHeight: 1.05, letterSpacing: -0.02em }
  wordmark: { fontFamily: Overpass, fontSize: 22px, fontWeight: 800, lineHeight: 1, letterSpacing: -0.02em }
  title: { fontFamily: Overpass, fontSize: 18px, fontWeight: 800, lineHeight: 1.25, letterSpacing: -0.01em }
  body-strong: { fontFamily: Overpass, fontSize: 16px, fontWeight: 600, lineHeight: 1.4 }
  body: { fontFamily: Overpass, fontSize: 14px, fontWeight: 400, lineHeight: 1.45 }
  label: { fontFamily: Overpass, fontSize: 13px, fontWeight: 600, lineHeight: 1.3 }
  caption: { fontFamily: Overpass, fontSize: 12px, fontWeight: 400, lineHeight: 1.45 }
  data: { fontFamily: Overpass Mono, fontSize: 15px, fontWeight: 600, lineHeight: 1.15, letterSpacing: -0.03em }
  data-small: { fontFamily: Overpass Mono, fontSize: 12px, fontWeight: 400, lineHeight: 1.3, letterSpacing: -0.03em }
rounded:
  thumb: 6px
  control: 8px
  card: 10px
  card-phone: 12px
  pill: 999px
spacing:
  s1: 4px
  s2: 8px
  s3: 12px
  s4: 16px
  s5: 24px
  target: 40px
  target-phone: 44px
components:
  page: { backgroundColor: "{colors.surface}", textColor: "{colors.ink}" }
  page-muted: { backgroundColor: "{colors.surface}", textColor: "{colors.ink-muted}" }
  page-raised: { backgroundColor: "{colors.neutral}", textColor: "{colors.ink-muted}" }
  page-selection-text: { backgroundColor: "{colors.surface}", textColor: "{colors.primary-text}" }
  page-dark: { backgroundColor: "{colors.surface-dark}", textColor: "{colors.ink-dark}" }
  page-muted-dark: { backgroundColor: "{colors.surface-dark}", textColor: "{colors.ink-muted-dark}" }
  page-raised-dark: { backgroundColor: "{colors.neutral-dark}", textColor: "{colors.ink-muted-dark}" }
  page-selection-text-dark: { backgroundColor: "{colors.surface-dark}", textColor: "{colors.primary-text-dark}" }
  map-label: { backgroundColor: "{colors.map-land}", textColor: "{colors.map-label}" }
  map-label-dark: { backgroundColor: "{colors.map-land-dark}", textColor: "{colors.map-label-dark}" }
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    padding: 12px
    height: 40px
  button-primary-dark:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.on-primary-dark}"
    rounded: "{rounded.control}"
    padding: 12px
    height: 40px
  button-secondary:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: 12px
    height: 40px
  button-secondary-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.ink-dark}"
    rounded: "{rounded.control}"
    padding: 12px
    height: 40px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: 16px
  card-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.ink-dark}"
    rounded: "{rounded.card}"
    padding: 16px
  live-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    height: 40px
  live-bar-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.ink-dark}"
    rounded: "{rounded.card}"
    height: 40px
---

# Design System: GerLines

Status: direction chosen (B Fahrplan, user, 2026-10-24). Tokens above are normative; the code theme in `packages/ui`
(WP-4.1) is generated from them and then becomes the source, mirrored here.

## Overview
- Name: GerLines (user, 2026-10-24). Mode-agnostic on purpose: trains first, trams, U-Bahn, buses and ferries can join later. Brand written GerLines, lowercase `gerlines` in domains and code; tagline "Every train in Germany, live" (assumed, kept from the variant). Domains gerlines.com, .de and .app were unregistered on 2026-10-24 (not bought).
- Purpose and primary action: watch every train in Germany move live on a 3D map and click one to learn everything about it; secondary actions are journey search and statistics.
- Audience and context, equal weight:
  - Visitors from a LinkedIn post: the map must impress within seconds and invite the first click without explanation.
  - Rail experts: vehicle series, train numbers, formations, speeds, per-segment history, one click deeper.
  - Travellers checking trains and connections: search A to B, delays, platform and status, fast on a phone.
- What only this product can claim: every train in Germany, live, on the real track geometry, with the correct vehicle model and its own delay history per segment. (inferred)
- Scope: product. Platforms: web on phone, tablet, desktop and large screens. Site type: web app around an immersive map (dashboard patterns for panels and statistics, immersive patterns for the map).
- Languages: English, German, Polish.
- Personality, three words (user, design brief, 2026-10-24): precise, not cold; calm, not sleepy; deep, not cluttered.
- Density (user, design brief): balanced. The card and panel show a few key facts at once (category, number, destination, delay, next stop); everything else is one click deeper. Serves all three audiences.
- Character notes: mainly a precise instrument, calm and technical but not cold, the map first and a quiet interface. Borrow from the other directions where they serve the data: a cinematic camera at close zoom (not gimmicky), the information depth of a pro tool (not cluttered), the clarity of data journalism for statistics (not decorative). Data shown concretely and well presented, never overloaded.
- Main device: desktop sets the layout (map plus side panel); phone fully supported with the panel as a bottom sheet and every feature available.
- Theme: dark by default, light as an option; satellite and terrain as separate map styles.
- Budget: free sources while local; about 20 EUR per month allowed at publication.
- **Chosen direction: B Fahrplan** (variant B, chosen 2026-10-24 by the user): the clarity of a printed timetable and of good data journalism on a calm warm-graphite map. Typography carries the hierarchy, times are big and tabular, a train's route reads as a line diagram with a progress dot, and one signal amber is reserved for the selected train. The user: the style of B is the look GerLines should mainly have; all planned functionality is added on top of it. Mockup: `design/variants/b-fahrplan.html`, screenshots `design/variants/shots/b-*.png`.

## Colors
Token names in the front matter: base tokens are the light theme, `-dark` tokens the dark theme (the format has no
themes). **Dark is the default theme.** Hex values were checked for contrast in the variant (computed ratios below).

| Role | Dark | Light | Where |
| --- | --- | --- | --- |
| Surface (cards, sheets) | `#17181A` | `#FBFAF7` | every floating card, the phone sheet, the live bar |
| Raised (fields, secondary buttons, hover) | `#1F2023` | `#F1EFEA` | search field, secondary buttons, selected tab background |
| Hairline | `#2C2E32` | `#DAD6CC` | 1 px card borders and row rules |
| Ink | `#F1EFEA` | `#1B1A18` | text |
| Muted ink | `#A09D96` | `#5F5B54` | secondary text, scheduled times, labels |
| Passed | `#66676B` | `#8C877D` | passed stops and the travelled part of the line diagram |
| Selection (map and fills) | `#FFB000` | `#F08C00` | the selected train, its route ahead, the progress dot, the Follow button fill |
| Selection as text or thin UI part | `#FFB000` | `#A85F00` | when amber must read on the light surface |
| Focus ring | `#F1EFEA` | `#1B1A18` | 2 px outline, 2 px offset |
| Error | `#E58F8F` | `#C2503F` | failed loads and cancelled states, never for delay values |

Map palette (OpenMapTiles style built from the `map-*` tokens; the style builder reads them and holds no hand-copied
values): land `#1A1B1D` / `#EDEBE5`, water `#121315` / `#C7CFD3`, roads minor, major and motorway `#262729` `#2C2D2F`
`#323336` with casing `#212224` (dark) and `#E0DDD5` `#D6D2C8` `#C9C4B8` with casing `#E6E3DC` (light), railways
`#3A3B3F` / `#B2AEA5` from zoom 8, labels `#8D8A84` (cities `#A7A39B`, water `#6C6A66`) / `#625E57` (cities `#47433D`,
water `#5F6F78`), Germany mask `map-mask` at 55 % (dark) and 34 % (light) opacity with outline `map-outline`, state
and country borders `map-boundary-*`. The mask opacities are not tokens (the format has no opacity type). Ocean
(OpenMapTiles water class ocean) is coloured in the ground water layer under the mask, with `map-sea` inverted through
the mask so that abroad it shows as the token (`#080C11` / `#A2AFB7`), cooler and darker than masked land; lakes and
rivers keep `map-water`, and roads, bridges and buildings inside Germany draw over the sea unchanged. Every style draws
the ocean coast as a line above the mask in `map-boundary-country`, 0.6 px at zoom 3, 0.9 px at 8, 1.2 px at 12 and
1.6 px at 16. Germany's outline comes first: `map-outline` 1.2 px at zoom 4 growing to 2.1 px at zoom 10, above the tile
country lines; it fades out between zoom 11 and 12 in the national view, where the exact tile line is the border (the
outline is a simplified BKG polygon). Neighbour country lines are `map-boundary-country`, 0.7 px at zoom 3, 1.0 px at 8
and 1.4 px from zoom 12. In Land focus the national outline keeps 0.8 px at zoom 4 and 1.4 px from zoom 10, with no
fade, below the focus outline (ink 1.6 px). Layer order: ground (water, roads, buildings), mask, coastline, rails,
train anchor, state and country lines, national outline, Land focus lines, labels.

Satellite: imagery darkened with raster brightness max 0.62, saturation −0.35, contrast 0.08, mask `map-mask` at 62 %,
rails `map-rail-satellite`, country lines and the coast line `map-boundary-satellite` at 70 % opacity, the German
outline in `map-rail-satellite`, the imagery kept for the sea (single values: Satellite always uses the dark interface). Terrain: hillshade highlight `surface`, accent `map-outline`, shadow `ink` up to zoom 6 easing to `map-label`
at zoom 9, exaggeration 1 to 0.6 over the same zooms. The imagery tones in the Satellite thumbnail (#3D4632, #4A5238,
#2C3527, #4E4B45, #1B2329) illustrate a photo and are not product colours.

Terrain 3D (WP-5.3): rails on the relief are drawn in `map-label`, not
`map-rail`, 1.4 px at zoom 11, 1.8 at 12 and 3.2 at 16, with the sleeper dashes at 40 % opacity on open track. From
zoom 12 a rail on a bridge is drawn at 50 % under the deck line (below zoom 12 the bridge keeps full strength, since no
deck line exists there; 30 % read as a break on a short overpass), and a rail in a tunnel at 40 % and dashed, so no
track runs into a gorge or climbs a ridge. The deck line runs from zoom 12 under the trains for every shape in view
where the straight path between two shape vertices is more than 12 m above the drawn terrain: `map-label` 1.8 to 3.2 px
over a `map-land` casing at 85 % opacity, joined to the terrain at both ends and lifted from the rail at a 5 % grade,
so no step shows at an abutment. A chevron hidden behind the relief, a tunnel mountain or an extruded building is
drawn again as a ghost at 40 % opacity; the click lands on its train; the selected train is never hidden. 3D
buildings rise from zoom 14.5 over one zoom level in `map-building` under a style light of intensity 0.22 (MapLibre's
default 0.5 shades the walls too dark), so walls stay at `#B0ADA6` or lighter and roofs keep the token; no wall or
roof token is needed.

Labels: `name:<lang>`, then `name:latin`,
then `name`; German never shows a German exonym for a place outside Germany (Wrocław, not Breslau); Polish falls back
to the local name for border twin towns whose `name:pl` names the town across the river (Görlitz stays Görlitz).

Category colours (colour mode Category, the default; user, design brief):

| Category | Dark | Light | Note |
| --- | --- | --- | --- |
| ICE and high speed (`hsr`) | `#EDE6D6` ivory | `#26231E` | |
| IC, EC, FLX (`ld`) | `#B9AF98` | `#6A604C` | same hue family as high speed |
| Night trains (`night`) | `#EDE6D6` hollow | `#26231E` hollow | hollow shape keeps ivory to one meaning |
| RE, IRE, MEX (`rfast`) | `#9CC5F6` | `#3F83D6` | |
| RB and regional (`reg`) | `#5F97DE` | `#1F5EB0` | two lightness steps of one blue |
| S-Bahn (`sbahn`) | `#5FC08A` | `#17814C` | |
| Neighbouring countries (`foreign`) | `#8F87A8` at 70 % | `#6F6790` at 70 % | muted by design |

Delay colour mode (WP-4.4): on time under 3 min (early counts as on time) `#7CC9B4` / `#1F8E78`,
3 to 5 min `#E8D7A0` / `#B08A12`, 6 to 14 min `#E58F8F` / `#C2503F`, 15 min or more `#E86BD0` / `#7A2A5C`, no realtime
data and neighbouring countries `#8F87A8` / `#6F6790` (foreign at 70 % and smaller; a domestic train without a delay
value is no realtime, never on time). Worse delays draw on top. Lightness rule: the worse the delay, the more contrast
with the land (15 min or more at least 6:1 on dark). Colour-blind check, not a validation: Machado 2009 matrices,
CIEDE2000, floors 6 simulated and 15 unsimulated (`apps/web/src/modes/delay-colours.test.ts`). Legend in Delay mode:
six rows summing to the total, then the label control (Off, Line, Delay) with its zoom hint, then a
collapsed Show on the map disclosure with the category and foreign checkboxes; the right column fits by a measured
ladder (Layout, Right column fit). Labels from zoom 10.5, 12 px Overpass Mono 600 with a 3 px land outline,
Delay labels only from 3 min as whole minutes cut off, one label per box placed worst first. Night trains draw after
the normal layer (accepted until the layers split).

Operator colour mode: a train takes the colour of its operator group, the first
parent organisation `catalog/operators.yaml` lists (its Wikidata item), with one company's items folded together: the
DB Regio items into Deutsche Bahn, the Transdev items, Transdev Regio Ost and Bayerische Oberlandbahn into Transdev,
BeNEX, Regentalbahn and Die Länderbahn into Netinera. An operator without a parent is its own group, and a feed name
starting with DB without one is Deutsche Bahn (`apps/web/src/modes/operator-group-rules.ts`). Deutsche Bahn and the five
largest groups whose colours stay apart in every pair have a colour (`operator-group-list.ts`); every other operator is
Other, and a train without an operator, or with one the catalogue does not list, is Unknown, never Other (missing shown
as missing). The colours encode groups and are not brand colours; they are not tokens yet and live in
`apps/web/src/modes/operator-colours.ts`. No amber, which stays the selection.

| Group | Dark | Light | Share of trips in one timetable-only hour (4,960 trips) |
| --- | --- | --- | --- |
| Deutsche Bahn | `#EDE6D6` | `#26231E` | 61.2 %, the ivory and charcoal of the high speed mark |
| Transdev | `#9B5724` | `#B87240` | 6.0 % |
| Netinera | `#2697F0` | `#0E8AE2` | 4.7 % |
| KVVH | `#6254CC` | `#482AB4` | 3.5 % |
| Hessische Landesbahn | `#DB5DAB` | `#DE459F` | 2.6 % |
| SWEG | `#849E4E` | `#465C00` | 1.8 % |
| Other | `#B5B7BA` | `#46484A` | 17.4 %, drawn at 0.8 times the size |
| Unknown | `#736371` | `#79635F` | not measured, drawn at 0.8 times the size |

- Validation (dataviz validator in its any-pair mode, since a map puts any two trains side by side; OKLab distance
  times 100, colour-blind views from the Machado 2009 matrices for protanopia and deuteranopia;
  `operator-colours.test.ts`): the five hues normal at least 17.0 dark and 19.2 light (floor 15), colour-blind at
  least 11.9 and 12.0 (floor 8), chroma at least 0.1, every group at least 3:1 against `map-land` (KVVH dark 3.0 is the
  lowest). All eight groups, the neutrals included: colour-blind at least 10.1 dark and 10.0 light (test floor 9.5),
  normal at least 11.1 dark (Transdev and Unknown) and 11.9 light (SWEG and Other), below the validator's 15.
- Second channel: Other and Unknown draw their dots and chevrons at 0.8 times the size, as foreign trains do,
  and their legend swatch has radius 4 instead of 5 (`NEUTRAL_GROUP_SIZE`), so a neutral pair that falls under the
  normal floor is told apart by size as well. Hue is never the only carrier for the five named groups either: the
  legend counts and hides each group, and the card names the operator.
- Draw order: Unknown, then Other, then Deutsche Bahn, then the five hues, so the smaller groups draw over the many
  Deutsche Bahn trains (`OPERATOR_DRAW_ORDER`).
- Tritanopia (Machado 2009 like the other views, in the same test): the five hues at least 10.4 dark and 8.6
  light (floor 8; the light KVVH and Hessische Landesbahn were moved for it), all groups at least 8.7 dark and 4.6 light
  (floor 4.5; SWEG and Other, told apart by Other's smaller size).
- Known limits: the light Transdev is the group colour nearest to the light selection `#F08C00`
  (12.8 normal, 11.1 colour-blind); the selected train keeps its ring and route ahead. The palette is not checked on
  screen yet.

Journey on the map (WP-8.2): each train leg is its route line in the leg's category colour (`ink-muted` for
a category without a map colour) over a `surface` casing, 3 to 7 px over a 5 to 11 px casing from zoom 5 to 14; a walk
is a dashed `ink-muted` line of 2 px; the two ends are `ink` dots with a `surface` ring, every change a `surface` dot
with an `ink` ring. The journey draws below the trains and the labels and above the rails, and never in amber, which
stays the selected train.

Rules:
- Interaction states are derived, not new colours: hover and active mix the raised colour with ink (12 percent, then
  10 and 20 percent); the selection mixes with ink in dark (8 and 16 percent) and with `primary-text` in light (16 and
  32 percent) so it keeps its hue. Non-selection primary actions (a dialog's confirm) use a solid ink button; checked
  checkboxes and switches are ink, never amber. (inferred, WP-4.1)
- A selected row of a list (the shown journey) is raised with a 2 px `ink` rule on its left edge, the same idiom as
  the active style thumbnail's ink outline; never amber. (WP-8.2)
- A pressed panel button (Plan a journey, Statistics) is a raised fill with ink text and a 2 px ink inset outline. The
  chosen side of a two-way toggle in a form (Depart at, Arrive by) is a raised fill with ink text; the solid ink fill
  stays for the one primary action of a form. (WP-8.2)
- On the light surface the progress dot and the route line ahead use `primary-text` `#A85F00` (3:1 for a graphic),
  while the Follow fill stays `#F08C00`. (inferred, WP-4.1 design review)
- `error` is for borders, dots and icons, never for text in light (`#C2503F` is 4.45:1 on the light surface); `passed`
  (3.1 and 3.4:1) only for lines and dots. (inferred, WP-4.1)
- Amber is the selection, nothing else: never a category, never a delay, never decoration. At most the selected train,
  its route ahead, the progress dot and the Follow button carry it.
- Delay values are shown in ink, not in red: amber is taken and a red would approach the DB look.
- No DB red anywhere as an identity colour.
- Computed contrast (variant B): dark ink on surface 15.5, muted on surface 6.6, muted on raised 6.0, amber on surface
  9.7, dark text on amber 9.7, map labels on land 5.0 (cities 6.9); light ink on surface 16.7, muted 6.5, dark text on
  `#F08C00` 7.2, `#A85F00` on surface 4.7, map labels on land 5.4. Category marks on land 5.1 to 13.9 (dark), 3.0 to
  13.1 (light; foreign deliberately muted below 3:1 at 70 %).

## Typography
- **Overpass** (UI and headings, weights 400, 600, 800) and **Overpass Mono** (times, delays, platforms, counts and
  every other number; weights 400, 600). Both SIL Open Font License 1.1; self-hosted through Fontsource in the product,
  never loaded from Google at runtime. Map labels use Noto Sans glyph PBFs, because map glyph stacks cannot use web fonts;
  they come from OpenFreeMap with the base map today and are self-hosted with the production tiles (planned, WP-10.1).
- Hierarchy: next stop time 38 px mono 600 (34 px on phone); train title 32 px 800 (28 px on phone); delay 28 px 600
  (24 px on phone) with a 16 px unit; wordmark 22 px 800; next stop name 18 px 800; destination 16 px 600; body 14 px;
  labels 13 px 600; captions, platforms and credits 12 px; attribution 11 px.
- Every number uses tabular figures (`font-variant-numeric: tabular-nums`) with letter-spacing `-0.03em`. Overpass Mono
  colons and thousands separators are narrowed (negative margins on the punctuation cell) so `21:35` and `2,665` do not
  read with gaps.
- Scheduled times next to a predicted time are struck through in muted ink (`20:44` under `21:35`).
- Prose measure in panels stays within 45 to 75 characters; long station names wrap, never truncate silently.

## Layout
- Desktop: the map fills the window. Floating cards with a 16 px margin: top left the search card (wordmark, tagline,
  search field with the panel pair at the end of its row, colour mode tabs), below it one card slot 380 px wide that
  holds the train card, the station card, the statistics panel or the journey planner, one at a time, with the Land
  focus chip between the search card and the slot; the search card never shrinks for the slot; top right the language switch, the map style
  picker as four labelled thumbnails (Dark, Light, Satellite, Terrain) and the category legend card with live counts
  and toggles; bottom centre the live bar (Live, data time, date, zoom stage line; centred from 1280 px wide, left
  aligned below); bottom right the zoom controls with the attribution beside them on their left (above them at compact
  sizes); the right column is limited by the zoom controls' height only.
- Phone: search card collapsed to a one-line wordmark (GerLines, no tagline) above the field and the colour tabs on top; layers behind one icon button, with the panel pair before it in the search row; the train card is a
  bottom sheet with a peek state (304 px) that shows category, number, destination, delay, the next stop with its big
  time and platform, and the three actions; the sheet expands to the full stop list; the attribution sits above the
  sheet. The phone live bar is stacked: status and data time on the first row, the zoom stage line under it. The
  layers popover starts with a labelled Language row. One bottom sheet serves the train card, the station card, the
  statistics panel and the planner, whichever opened last; it expands only to below the search card, and the data
  sources button hides while a sheet is expanded over it. (WP-7.3, WP-8.2)
- Tablet (834 and 1194 wide): the desktop layout with the train card 360 px (up to 1200 px wide). Compact sizes (at most 1100 px wide or
  860 px high, tablets and small laptops) show the legend card collapsed to its header with the totals; it opens on
  demand. Compact sizes also show the style card folded from the start (one 44 px row; thumbnails and switches in its
  popover), so the column ends at about 251 px on a tablet.
- Tablet overview: up to 1100 px wide the national view uses a stacked padding, top 268 (below the
  folded right column) and 16 px sides, whenever that fits Germany larger than the side paddings (834x1194: zoom 5.59);
  with a panel or card in the left slot it uses top 268, bottom 72, left 392, right 16; opening a panel over the
  untouched overview eases to it and closing eases back (instant under reduced motion); a selected train or station
  keeps its own flight. Landscape tablets keep the side paddings. The hard bounds hold the union of the open and closed
  slot views.
- Right column fit: the column walks a measured ladder whenever its content grows: full, style card
  folded (one 44 px row with Map style and the current style; thumbnails and every switch row in a popover), label
  control folded (a 40 px disclosure), legend collapsed to its header. While Show on the map, the label disclosure or
  the legend header is open by the user the walk stops at the folded step and the column scrolls; closing it walks back;
  data arrival never restarts the walk. Measured at 1440x900 in EN, DE and PL: Category and Delay at the style-folded
  step, Operator at the label-folded step, every legend open.
- Attribution: every required credit is visible when the map loads, at every size (OSMF safe harbour: no interaction
  needed to see it). On phone and compact sizes it collapses to an info button on the first map interaction (pan,
  zoom, click) or after five seconds; the info button reopens the full credits. Above the compact size it stays open.
  Link texts never wrap mid-link. The attribution is the app's footer line: it ends with the links Photo credits,
  Sources and licences, Privacy and Impressum and the sentence Not affiliated with Deutsche Bahn or any operator.
  (WP-9.6)
- Large screens (2560): cards keep their widths; the map gets the space.
- Device tiers (WP-5.3): the tier comes from the WebGL renderer string (`gl.RENDERER` first, else the
  unmasked renderer), device memory and cores, never from the network. Low (no WebGL2, software renderers, Adreno
  under 650, Mali-G under 77, Xclipse under 920, Intel UHD and HD, a hidden phone renderer, little memory or few
  cores) opens the Terrain style flat with buildings off; mid (Adreno 650 and up, Mali-G77 and up, Immortalis, Xclipse
  920 and up, PowerVR B, C and D series, Apple GPU including desktop Safari, Intel Iris, a hidden desktop renderer)
  opens the relief on and buildings off; high (Apple M series, GeForce, Radeon RX, Intel Arc) opens both on.
  The user's switches are stored (`gerlines-terrain-3d`, `gerlines-buildings-3d`) and win over the tier. Buildings
  exist only in Terrain 3D: since WP-5.4 Dark, Light and Satellite tilt while a train is selected, without extruded
  buildings (a later item may allow them there behind the tilt switch, measured first).
- Spacing scale 4, 8, 12, 16, 24; targets 40 px desktop, 44 px phone.

## Elevation & Depth
- Cards: 1 px hairline border plus one shadow `0 8px 24px rgba(0,0,0,.35)` (dark) or `0 8px 24px rgba(40,34,20,.16)`
  (light). No blur, no glass, no gradient.
- Layer order on the map: base layers, Germany mask, rail lines, trains, the selected train and its route, then place
  labels and boundaries above the trains so city names stay readable (finding from the variants: labels under the dots
  were hard to read at national zoom).
- On the relief (Terrain 3D): the selected marker and its route ignore the depth test and write no depth, so
  a ridge or the coarse terrain mesh never hides the selection (R-14); other markers keep the depth test and rise 3
  screen pixels above the surface (at least 30 m below zoom 13), cars 0.5 m.
- While the map is tilted (selection tilt in a flat style) the selected route and markers ignore the depth test, as on
  the relief.

## Shapes
- Radius 10 px cards (12 px on phone), 8 px fields and buttons, 6 px thumbnails, pill only for small status chips.
- Icons: Lucide, one stroke weight (2 px at 24 px); category glyphs are our own map shapes: dots below zoom 10, oriented
  chevrons from zoom 10, hollow shapes for night trains.

## Components
- **Train card, collapsed**: category badge (dot plus name), close button; title (line and number) 32 px; delay right
  aligned with Realtime state below; destination and operator as text (no operator logo in the card head); the route
  strip with the last passed stop, the progress dot labelled Now, and the next stop as a hollow amber ring with its name,
  platform (Platform 8, was 7) and the big predicted time over the struck scheduled time; All N stops toggle; vehicle
  block (series, set, cars, length, confidence label with its source, photo thumbnail with full credit); provenance line
  (position estimated between reports, data time); actions Follow (amber), Route, Share. The Now label stays at least
  24 px from the row edges; the row between the passed and the next stop is 84 px (68 px in the collapsed phone sheet,
  which hides the passed stop so the next stop fits the peek). The delay slot uses the mono face for numbers (`+6 min`,
  `2 min early`) and the text face for words (`On time`, `No data`). The head delay is the delay of the next stop's
  prediction; when the next stop has none, the slot shows the live delay with the muted label Now before it (Now +1 min).
- **Train card, expanded**: the full route strip with every stop (passed stops muted, times right aligned, delay per stop
  in muted mono), photo full width with credit. The collapsed desktop card shows one line under All N stops: the series
  in ink, then units, cars and length in muted figures, truncated with an ellipsis, the confidence in its title; nothing
  when the vehicle is not identified or only a generic model of the category stands in (layer L4, confidence 0.1); the
  vehicle block names that generic model with its confidence label (Typischer Dieseltriebzug, Typowy spalinowy zespół
  trakcyjny, Generic diesel multiple unit). With All N stops open the full vehicle block replaces the line, and it is in the
  expanded phone sheet; the phone peek has no line. The vehicle block's facts line gives units, cars and length (2
  units, 139 m; 2 Einheiten; 2 jednostki), each only when the data has it. German and Polish name a DB Class series by
  the API's `br` (Baureihe 422, Baureihen 483 und 484, Seria DB 422, Serie DB 483 i 484); product names stay. The source
  reads as the display name the API sends from the catalogue (Wikipedia (de), S-Bahn Rhein-Ruhr); GerLines curation and
  the bahn.de coach sequence read in the language of the page; a source the API sends without a name is left out, never
  printed. The vehicle block names the livery drawn on the map: a Livery row with
  the livery's name, or that the catalogue has no livery of this operator for the series (decided, not built
  yet).
- **Forecast block** (WP-7.5, D-065): after the vehicle block, with All N stops open and
  in the expanded phone sheet; the collapsed card has none. Label (13 px, muted) Forecast from history, or Forecast with
  a range from history when a shown row is based on the feed; a From line (the current delay at the stop it was read);
  up to 5 rows, each the stop name over a muted caption and, right aligned in `data-small` mono, the typical delay and
  the 8 in 10 bound (`+4 min, 8 in 10 under +9 min`); a row's caption names where its spread comes from: This train,
  Trains of this kind here, Trains of this kind, or for a feed-based row Live forecast, spread of this train (of trains
  of this kind here, of trains of this kind); N more stops; then a muted caption that says it is a forecast and not
  measured, the months it was learned from, the method (the feed's forecast where the feed has one, as it came closer
  than B1 in the live check, with B1's spread for the bound; At stops without a live forecast, both values come from
  those runs when bases mix), the source and the licence link. Never coloured, never amber, never in the delay slot. All N stops scrolls the Now row to the middle and keeps Fewer stops in a
  band stuck to the bottom of the list. Follow is a toggle with one label and a check icon when pressed (aria-pressed).
- **Segment profile block** (WP-7.4b; `apps/web/src/profile/ProfileBlock.tsx`,
  `ProfileLegend.tsx`, `ProfileLegList.tsx`, `subject.ts`, `use-profile-range.ts`; slot `ProfileSlot` in
  `components/train/card/TrainCard.tsx`): one section with a top border and the card's 16 px side padding, after the
  forecast block and before the speed row, in the desktop card (collapsed and expanded) and in the expanded phone sheet;
  never in the phone peek. Shown only for a train the map draws that has a train number; a playback fetches and draws no
  profile. The label Segment profile (`type-label`, muted) at the left and a toggle button at the right with the Lucide
  Layers icon, Show segment profile in the secondary style, Hide segment profile in the selection (amber) style when on
  (`aria-pressed`); nothing is asked of the API until it is on. On: a two-item toggle group of full width, Median and
  80th percentile; the period caption (Period {from} to {to}), the statistics panel's period except Today, which becomes
  the last 30 days; the group line (Profile of {category} {operator}, {runs} in the period) and, when the number has
  more trains, {count} more trains use this number; the legend; a quiet Show {count} segments button (`aria-expanded`)
  that opens the list of every leg, each with a 6 by 10 px round swatch in its class colour (dashed outline for no
  figures), the leg title {from} to {to} and the lines This train, All trains and the difference in the chosen measure,
  the same words the map tooltip shows; under the list, when it applies, {count} segments of this route are in the data
  under other station ids, so they show no figures here (legs are matched by stop place ids, never by name), and the
  method note (delay gain is the delay at the end of a segment minus the delay at its start, in whole minutes). States:
  Loading the profile (polite live region); an error notice (`role="alert"`) with Try again, disabled with Try again in
  {seconds} s while the API's Retry-After runs; No segments of this train in this period; The profile cannot be placed
  on the route drawn for this run, so it is not shown on the map (the detail's stops do not match the worker's stop
  times within 60 s, `profile/placement.ts`). Never amber except the pressed switch.
- **Segment profile legend and scale** (`apps/web/src/profile/scale.ts`, `ProfileLegend.tsx`): title Delay gain of this
  train against all trains; seven whole-minute classes of this train's gain minus all trains' gain in the chosen
  measure, rounded and clamped at 3 minutes each side, as a strip of seven 10 px high swatches with ticks -3, 0 and +3
  in muted mono and the words Loses less time, Same, Loses more time under it; a 32 px line, 3 px dashed, for No
  figures; with the route placed, the line Curtain height: minutes this train loses on the segment, up to 10 min.
  Diverging, blue for less time lost, grey for the same, red for more. The colours are not tokens yet:

  | Class | -3 | -2 | -1 | 0 | +1 | +2 | +3 | No figures |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | Dark | `#6AA8FF` | `#4E8DE0` | `#3D6FB0` | `#77746E` | `#B8594C` | `#E0705F` | `#FF8E7A` | `#8D8A84` |
  | Light | `#104281` | `#2A64B8` | `#5B93D8` | `#8F8B81` | `#E0715E` | `#C2412C` | `#8E1F14` | `#6F6B63` |

  Every colour keeps at least 3:1 against the card surface the route is drawn on (`scale.test.ts`; lowest dark 3.47 at
  -1, light 3.01 at +1, no figures 5.16 dark and 5.08 light), and contrast grows away from the middle on both arms. The
  blue arm shares its hue family with the regional category blue; the selection amber is never used.
- **Segment profile on the map** (`apps/web/src/map/profile-layers.ts`, `map/train-map.ts`): drawn over the selected
  train's amber route, which stays: a 10 px casing in the `surface` token at alpha 230, then each leg of the route 6 px
  wide in its class colour, cut from the route's own vertices between the shape's stop positions (never a straight
  line); legs without figures as 4 px grey dashes of 12 px with 9 px gaps, square ends; legs the train has passed at
  alpha 120. Hover or tap on a leg (16 px hit line) draws a 12 px outline in the `ink` token and opens the tooltip; a
  tap on a leg does not deselect the train. The tooltip (`ProfileTooltip.tsx`) is a 288 px card surface 14 px from the
  pointer, flipped to the left when it does not fit, with the leg title and the same lines as the card's list; Escape
  closes it. In Terrain 3D or any view pitched over 5 degrees a translucent curtain (alpha 120, soft shading) rises
  along the shape at its baked height, 4 px wide (narrower on tight arcs), in the leg's class colour, its height the
  minutes this train loses on the leg in the chosen measure at 12 px per minute at any zoom, capped at 10 minutes, none
  where the train gains time; in Terrain 3D it draws over the relief without a depth test (an open issue). Colour is
  relative (this train against all trains), height is absolute (minutes lost), so a leg slow for every train stays grey
  but tall.
- **Speed row** (`apps/web/src/components/train/SpeedRow.tsx`): one section with a top border and the
  card's 16 px side padding, after the segment profile block and before the provenance line, in the desktop card
  (collapsed and expanded), in the expanded phone sheet and in the frame card; never in the phone peek. The label Speed
  estimate (`type-label`, muted) at the left; at the right the speed in the mono face (`num type-data-small`, ink),
  rounded to 5 km/h and at least 5 km/h while the train moves (`120 km/h`, `120 km/godz.`), or the words Standing at a
  station (`type-body-strong`) only when the plan speed is exactly 0, in a dwell. Under it a muted caption with the
  basis: From the timetable and the latest realtime report, From the timetable only, or in a playback From the
  timetable and the report known at that moment. No row when the plan has ended or the worker has not sent the
  selected train's update yet. Never coloured, never amber, no gauge or icon.
- **Train card rules**: the title is product and number (ICE 597); with no product
  `Train 597` with `Line 12` under it; with no number the line as written (FLX10); never a bare number. The
  destination is To plus the last stop's name; the headsign appears only when it adds information. The phone peek keeps
  the train number visible. Times to the next stop use the engine's clock, never the device clock. Follow keeps the
  train centred while the map is still and pauses while a pointer, wheel, button or key moves the map; dragging or the
  arrow keys end it. Route fits the route ahead with room for the card, the live bar and the attribution. Share copies
  a link that reopens the selection.
- **Train card states**: Detail unavailable (the detail API answers an error: the frame card stays with one sentence
  that the stops are not available, retried in the background); Not on the map (the train is known but not drawn:
  Follow and Route are hidden, Share stays, one sentence says so, and the actions return once it is drawn).
- **Station card**: Back to {train} and Close; the label Station; the name 24 px (28 px from 640 px) that takes focus
  without a ring; This train with an arrival and a departure line, each with its own delay only where no struck pair
  already says it; the platform in mono (Platform 4, was 5) or Stop cancelled; Departures and arrivals with the Soon tag
  until the board exists.
- **Search card**: wordmark and tagline, search field (Search for a train, line or station; four strings per language,
  full, medium, short and one word, the longest that fits the field in its own font), colour mode radio group
  Category, Delay, Operator under the label Train colours, with an underline on the active tab.
- **Not yet available**: a control whose feature is not built yet (search until WP-4.7, the Delay mode until WP-4.4,
  the Operator mode until it was built, the Satellite and Terrain styles until WP-4.5) is shown disabled with one visible Soon tag in the same
  place and style everywhere, and the same words for screen readers. A disabled control without the tag reads as broken.
  The Soon tag is a 20 px pill (11 px text, hairline border, muted ink) under the label of tabs and thumbnails and at
  the end of a disabled field; screen readers hear the tag plus Not available yet.
- **Map error state**: when the map cannot load (a failed chunk, no WebGL) a centred card with a title, one sentence
  and a Reload page button replaces the map while the shell stays.
- **Map style picker**: four labelled thumbnails; the active one has a 2 px ink outline. The style picker is the only
  theme switch: Dark and Satellite use the dark interface, Light and Terrain the light one, and the app opens in Dark.
  In the Terrain style a 3D terrain switch shows under the thumbnails, in production too;
  while 3D terrain is on, a 3D buildings switch shows under it (no buildings
  switch in Dark, Light or Satellite); a Tilt on selection switch shows in the layers area in every style, on by
  default, stored as `gerlines-selection-tilt` and listed on the Privacy page; off, selection still flies and zooms but
  keeps the pitch; there is no free tilt gesture; on a low tier the hint 3D can run slowly on this device shows only
  while a 3D switch is on.
- **Land focus**: a focused Land keeps the national mask colour and opacity of the style outside its border, its
  outline in `ink` 1.6 px drawn above every other border, the other Länder borders in `map-outline` 0.8 px, and the
  dashed state borders of the tiles hidden; the camera fits the Land with the panel or phone padding. It opens from the
  statistics panel area selector (WP-7.3) and a Land search result (WP-4.7); a chip under the search card clears it,
  with an accessible name holding the Land name and a 44 px target on phone.
- **Map bounds**: an elastic box of the Germany bbox plus 60 km, a rubber band of 200 km beyond it, hard bounds Germany
  plus 400 km, widened east and west on wide screens so the national view fits above the live bar. After a user gesture
  the camera eases back to the box in 280 ms with the design curve, a cut under reduced motion; a gesture that starts
  outside the box eases back only what it added; no ease back while the selected train is outside the box; flights to a
  train and Land fits are never damped.
- **Phone peek (304 px)** (inferred, WP-4.1): the handle in its own row at the top; a head row with the category badge and
  close; title and delay on one row; destination; the Now row 68 px; the next stop with its big time and platform;
  the three actions with at least 12 px above them. The Realtime caption and the operator line appear only when
  expanded; a timetable-only train shows that state in the peek. Content beyond the peek is not reachable by keyboard
  while collapsed. With the passed stop hidden, the route line starts at the Now dot, never above it. The short-run line
  (Ends at …) also shows in the peek, under the destination. The category badge sits left of the handle; when it does
  not fit there it moves, on one line, to its own row above the title and the peek grows by that row. The peek height
  is measured: 304 px at least, more when the content needs it, and the attribution sits above the real peek.
- **Panel pair** (WP-8.2): Plan a journey (Lucide Route) and Statistics
  (Lucide ChartColumn) are two secondary icon buttons of the same form at the end of the search row on desktop and
  phone (phone: before the layers button), their names as tooltips, pressed as in Colors, at most one pressed: they
  share one card slot. Opening one closes the other; a train or station picked on the map takes the slot and closing
  its card brings the panel back. Statistics is no longer under the search card or in the layers sheet.
- **Panel head**: every card in the shared slot heads with its name as a muted label (13 px),
  close and its own actions at the right and a hairline under it, staying at the top while the body scrolls on
  desktop; on phone the name is the sheet
  head's leading label beside the handle.
- **Panel set aside**: a panel the other one replaces keeps its state in the address without its
  open flag and comes back with it; closing a panel with its own button forgets it.
- **Statistics panel** (WP-7.3): area tabs Germany, State (DE Land,
  PL Kraj związkowy; the field label says German state), Station, Line, Train; period tabs Today, 7 days, 30 days, Month
  with a stepper, Custom with two day fields that apply 400 ms after typing or on leaving the field, held inside
  2024-01-01 and today. The result: the scope as heading (28 px 800) with the period line muted, the headline share in
  the display style (34 px mono) with a % unit, hairline fact rows (label muted left, value mono right), sections with
  13 px label headings (delay distribution, by category, by hour, by day), and a provenance footer with the disclosure
  How this is measured. A train is titled by the product letters of its lines when they agree (IC35 gives IC), else
  Train 596, never from the category. Phone: a bottom sheet with a peek of min(440 px, half the screen).
  - Numbers: shares to one decimal, rounded half up on the API's four decimals, never on binary error; separators
    narrowed like the card's times; the percent sign follows the language (German with a no-break space); minutes
    always with one decimal, else seconds or hours and minutes.
  - Charts: own SVG, no library. Delay bars take the four Delay mode colours by class (marks only, text stays ink);
    their height is the share of stops per minute of delay on a minutes scale (1 unit a minute up to 16, a quarter
    unit after a double-slash break at 16, bins before -5 squeezed, open bins 3 units at 55 % opacity), ticks on bin
    edges (-30, -5, 0, 5, 10, 16, 30, 60, 120+), the tooltip adds Per minute of delay. Category bars list every map
    category in legend order with No data where the answer has no row, night as the outlined bar like its legend mark;
    neutral `passed` for urban, bus and other. Hour and day charts use `ink` (62 % bars; 2 px line with an 8 px end dot
    and a 2 px surface ring), since one series needs no hue and amber is taken. 2 px gaps, a 3 px rounded data end,
    hairline grid, 11 px mono muted ticks, shares on a 0 to 100 % axis; an hour with no arrival is a short `passed`
    tick, not a zero bar. Hover or the arrow keys read a mark in a `card-surface` tooltip and a live region; every
    chart has a table twin behind one switch.
  - Missing data: no stops, no realtime value, no observed arrival, a new service day (before 04:00 Berlin time) and
    every API failure each have their own sentence; a null figure reads No data in muted ink, never 0.
  - Land sync: the State tab focuses the Land on the map; clearing the focus or focusing another Land elsewhere moves
    the panel along; closing the panel keeps the focus and forgets the Land tab.
  - Method note: names only counts above zero; the sentence on the gap to Deutsche Bahn's published figures shows for
    Germany over whole months only.
- **Journey planner** (WP-8.2): opens from Plan a
  journey into the card slot (desktop) or the sheet (phone, a 196 px peek of the chosen journey). From and To through
  the station search, Depart at or Arrive by a Berlin time, Trains and operator collapsed by default with a summary line
  (All trains, any operator), then five journeys with Earlier and Later. A result row: times, duration (h and min in
  the text face, numbers in mono; 3 h, not 3 h 0 min), changes, the legs' categories, and the punctuality of the
  journey's least punctual train: a share only from 5 recorded runs, read since that train's first recorded day, else
  the run count and that it is too few to rate. The journey detail lists each change once (station, arrival over
  departure, minutes to change, walk). Leg titles follow the train card title rule; legs carry no product yet, so a
  high-speed leg reads Train 1028 with Line 42 under it until a product per leg is built. The planner's state
  lives in the address (`plan=1` and `j` parameters, Berlin wall clock time). A train leg whose train runs now (start,
  window and number match a live run) offers Show the train live (quiet button, TrainFront icon) under its duration;
  it opens the train card, and the planner comes back when the card closes.
- **Legal pages** (WP-9.6): own paths `/sources`, `/privacy`, `/impressum` and `/credits`
  without the map, one shared header (wordmark, Back to the map, a legal nav with `aria-current`), prose at most 65
  characters wide. Source and provider rows are one row form: a grid from 1024 px (sources: provider strong, use,
  licence, credit; imagery and elevation providers: area, credit, licence) and below it a stacked row with inline
  Licence and Credit labels; licence names are the page's own
  (CC BY 4.0, DL-DE BY 2.0, DL-DE ZERO 2.0, CC0 1.0). A missing value is an outline chip Missing, a status a muted
  caption with a hollow dot, a draft the Notice pattern. The not-affiliated notice stands on `/sources` and
  `/impressum`.
- **Buttons while loading**: the spinner replaces the leading icon, never sits beside it.
- **Category legend card**: title Trains with the totals on their own line below it (2,665 total, 2,234 realtime; one
  row does not fit at 224 px; in Polish the totals line breaks only after the comma), one row per category with its mark, name and count, foreign trains separated by a rule;
  trains without track geometry are counted in a short note, not drawn; rows toggle visibility; counts of visible
  categories are in ink and a hidden category's count turns muted (never struck through: strikethrough means a
  replaced scheduled time); the count aligns with the first line of a name that wraps. Until the first keyframe is
  applied (`DataStatus.framed`) the totals line reads Loading trains and the counts are missing bars, never 0; totals then
  grow while shapes load, and a failed first load gives way to the error state.
- **Legend in Operator mode** (`components/shell/LegendOperatorRows.tsx`, `LegendCard.tsx`):
  the title and totals as in the other modes, then one row per group in legend order (Deutsche Bahn, Transdev,
  Netinera, KVVH, Hessische Landesbahn, SWEG), then Other operators and Operator unknown after a hairline rule; each row
  a checkbox, a 14 px round swatch in the group colour (radius 5, radius 4 for Other and Unknown), the name and the
  count right aligned, at least the 40 px target high. A hidden group's name turns muted and its swatch drops to 40 %
  opacity; a count not known yet is a pulsing placeholder bar, never 0. Under the rows a muted caption Grouped
  by parent organisation; then the label control and the collapsed Show on the map disclosure with the category and
  foreign rows, as in Delay mode. A group toggle acts only in the Operator mode and is not stored; group names are
  proper names, Other and Unknown are translated (Andere Betreiber, Betreiber unbekannt; Pozostali przewoźnicy,
  Przewoźnik nieznany). At 1440x900 the Operator legend stays open with the label control folded (measured).
- **Colour key (phone)** (`components/shell/ColourKey.tsx`): a one-row card 8 px above the live bar, left aligned, from
  the first paint and without data: a swatch and a short label for each colour of the active colour mode, using the
  legend's own colour tokens. Category shows the seven marks (ICE, IC, Night as the hollow ring, RE, RB, S-Bahn,
  Foreign at its reduced opacity); Delay the five classes with the unit on the first (Under 3 min, 3 to 5, 6 to 14, 15
  plus, No data) and Foreign; Operator the six groups by short name (DB, Transdev, Netinera, KVVH, HLB, SWEG), then
  Other and Unknown as the smaller neutral dots. It names colours, not counts, and follows the mode. Hidden categories
  and groups are dimmed and named hidden for screen readers; each swatch carries the full legend name as its accessible
  name. It is hidden while a sheet is open, as the live bar is. A mode with more colours than the row holds (Delay and
  Operator at 390 px) scrolls sideways under a 24 px fade overlay at its right edge that never covers the focus ring,
  and takes keyboard focus only while it overflows. The phone live bar's second row is target high (44 px) from the
  first paint, so the key does not move when the History button attaches.
- **Live bar**: Live with a status dot, data time in mono, date, zoom stage line. While the data is a replay it says
  Recorded sample instead of Live. When the live address answers with something that is not live data (no engine
  running), it says No live server is running in place of the zoom stage line (the development link to the Transitous path is gone). The bar never exceeds the room beside the bottom-right corner: on compact screens it leaves the
  zoom column, above compact sizes the attribution card and the zoom column; from 1280 px it sits in the middle track
  of a grid whose right track keeps the corner's room, centred while it fits and shifted left only as far as it must.
  History and Back to live are rows of the bar, so Back to live takes a row of its own when it does not fit.
- **Train card states** (WP-4.3): Loading, a skeleton of the head and the route strip with the status Loading train.
  Error, an error notice (error border and icon, ink text) with Try again under it. Not found, a note that the train is
  no longer in the data. Cancelled train, a Cancelled chip with an error dot in the delay slot, the notice This train is
  cancelled and is not shown on the map, first and last stop on a grey rail, only Share. Cancelled stop, an error ring
  marker, Stop cancelled with an error dot, its time unstruck and muted; a skipped next stop stays ahead of Now. Ends
  early, a line under the destination with an error dot (Ends at Günzburg, 4 stops cancelled), the rail after the last
  served stop in passed grey, the cancelled stops between Now and the next served stop shown in the collapsed strip.
  Timetable only, No data in muted ink, a hollow dot with Timetable only, single times, no delay values, provenance
  without a data time. Stale, from the server's feed age or a last successful fetch older than three minutes (never the
  device clock alone), a hollow dot with Data is stale and the sentence in the provenance. Refresh failed, the
  provenance adds Updating failed, trying again. Long names wrap in rows, head and station title. Missing vehicle and
  photo read Not identified yet with a reason. Motion: the card enters with opacity and 8 px; the rail ahead draws in
  600 ms; the dot glides 600 ms; reduced motion cuts all of them.
- **Search states** (WP-4.7; `apps/web/src/search/SearchBox.tsx`, `use-search.ts`): the results area under
  the search field opens while the field has the focus and the query holds a digit or two letters; it runs edge to
  edge in the card with a hairline above and below and scrolls inside min(55 % of the screen, 480 px). Its states are
  one status line at the top of that area, body type (14 px), 16 px side and 8 px vertical padding, inside a polite
  live region; never over the train card.
  - Searching: Searching in muted ink, only while no list is shown yet. A list already shown stays at 60 % opacity
    and is marked busy until the answer to the typed query arrives; Enter waits for that answer and then picks its
    first result.
  - Results: grouped by kind under 13 px muted group labels; screen readers hear the count (3 results).
  - Empty: No train, line, station or place matches {query} in ink, a long query wrapping and broken where it
    overflows, and nothing else, no illustration.
  - Error: Search is not available right now in ink with a secondary Try again button at the end of the line, 12 px
    apart; the list goes, the typed query stays in the field, Enter also tries again and screen readers hear Press
    Enter to try again. One line for every failure: no connection, a 503 while the index loads, a 429 and an answer
    that cannot be read.
  - Station from a link (station card): Station not found with The link names a station that is not in the
    timetable and no action; Station details are not available right now with a secondary Try again that reads
    Loading station and is disabled while it retries.
  - The statistics area picker uses the Searching and error words as captions (12 px).
  - A 429 or a 503 names no time: Try again waits for the Retry-After the API sent, as the segment profile does
    (decided 2026-11-08; today the client reads every answer other than 200 as the one error).

## Do's and Don'ts
- UI copy is concrete and short, without double dashes, slashes, quotation marks, semicolons or middle dots.
- No AI-slop look: buttons and icons must be designed, not vibe-coded.
- Never (user, design brief): purple-to-blue gradients, frosted glass panels, glowing outlines; the dashboard template look (big-number tiles with a sparkline in every corner, icons in circles, identical cards everywhere); anything that imitates Deutsche Bahn's own app or brand (DB red and logo as our identity; legally the site must never pass as an official DB product); neon or cyberpunk styling.
- Do keep amber for the selection only; do keep numbers in Overpass Mono with tabular figures; do strike the scheduled
  time rather than hiding it; do say where a value comes from (provenance line, confidence label, photo credit).
- Don't put monospace on labels or headings (monospace is for numbers only); don't use tracked all-caps eyebrow labels;
  don't append arrows to links; don't colour delays red; don't draw place labels under the trains (the selected train's
  marker and its own label are the one exception: they draw above the place labels).

## Motion
- Signature moment (user, design brief): click a train, the camera flies and tilts into 3D, the route ahead draws itself, and the camera can follow the train. Everything else stays functional and quiet.
  Built in WP-5.4: click, list, search and link selection fly the camera to the train in 0.7 to
  1.4 s (longer for a longer way) with `cubic-bezier(.2,.7,.2,1)`, closing in to at least zoom 11.5 and tilting to 55
  degrees; the map stays north up. The route ahead draws along the track in 600 ms, linear, from the train outward,
  starting 45 % into the flight. Closing the card tilts the map back in 600 ms and keeps the zoom. Any drag, wheel or
  key stops the flight where it is. Follow settles at zoom 11.5 or closer and pitch 55 with the train off the middle
  of the free area (lower for a northbound train, higher for a southbound one, 20 % of the free height times the
  cosine of the heading); Route fits the route in plan view (pitch 0) except in Terrain 3D.
- Route strip: the route ahead draws in 600 ms; the progress dot glides with `cubic-bezier(.2,.7,.2,1)` over 600 ms
  when the position updates.
- Panels open and close in 160 to 220 ms with an ease-out; no fade-and-slide on every element. Popovers, menus,
  tooltips and dialogs fade only (200 ms, `cubic-bezier(.2,.7,.2,1)`), they do not slide or zoom. (inferred, WP-4.1)
- Reduced motion: the route appears at once, the dot jumps, camera flights become cuts; trains still move on the map.
  On selection the camera cuts to the train at zoom 11.5 and pitch 55 and the map comes up from 40 % opacity in 180 ms
  (opacity only); tilt back is a cut.
- Vehicle figures (user, design brief): faithful lightweight models with correct proportions, nose shape, car count, single or double deck, operator livery colours, windows and doors as geometry; every car placed on the track separately; smooth on phones with thousands of trains.

## Accessibility
- Target WCAG 2.2 AA; contrast as computed above; focus ring 2 px with 2 px offset in ink; targets 40 px desktop, 44 px
  phone; every toggle reachable by keyboard; category marks differ in hue and lightness and night trains also in shape.
- Conventions of the code pass (WP-9.2; [docs/accessibility.md](docs/accessibility.md), Conventions):
  - Skip link: the first stop of the page is Skip to search, a button that moves the focus over the map canvas to the
    search field and is visible only while it has the focus (`apps/web/src/a11y/SkipLink.tsx`).
  - Landmarks: one `main` with the map section, a `search` landmark around the search field, the legend as a named
    region; one `h1` (the wordmark), `h2` for cards and panels, `h3` for groups inside them.
  - Focus rings: a control that touches the edge of a clipping card takes an inset ring (`outline-offset` -2 px); tab
    lists keep 4 px of room around their triggers; a scroller with a sticky bar keeps scroll padding for it.
  - Active option: the active option of a combobox list (search, station field) is the raised fill plus a 3 px bar in
    the `focus` token on its left edge (`shadow-[inset_3px_0_0_var(--gl-focus)]`), on hover as well.
  - Focus return: closing the train or station card returns the focus to the map canvas; closing statistics, the
    planner or the timeline returns it to the button that opened it; popovers to their trigger; only when closing left
    the focus on the page (`apps/web/src/a11y/focus.ts`). A panel that comes back after a card closes does not take the
    focus from the map; the statistics heading takes the focus only when the user opens it.
  - Escape closes one layer at a time: an open list, popover or the profile tooltip first, then the card or panel.
  - Live regions: one polite status region per surface, only for short messages (loading, empty, error, a result count,
    copy feedback, the live bar's data state); result lists, timers, ticking counts and hover tooltips are never live;
    errors that need action use `role="alert"`.
- Known limit: the light theme selection fill `primary` `#F08C00` is 2.08 on `map-land` and 2.38 on `surface` (needs
  3); the selected train carries its ink outline on the map, checked in the browser (docs/accessibility.md). The water
  labels and the light minor delay were raised in the browser pass (D-070; `delay-minor` light `#9E7A00` instead of the proposed
  `#9A7710`, which failed the deuteranopia check).
- Conventions of the browser pass:
  - Skip links: two, Skip to search and Skip to trains in view (opens the list and focuses its heading).
  - Text alternative of the map: the Trains in view list (nearest 20 shown trains to the map centre, each opens its
    card; a legend header button; a sheet on phones) and a polite view summary that changes only after a user move and
    at most every 10 s, never while an editable field has the focus.
  - A Keyboard shortcuts switch in the layers area (on by default, stored like the terrain switch) turns the slash key
    off (2.1.4).
  - Choices without panels (colour mode, label mode) are radio groups; tabs only with panels.
  - Tooltips are hoverable (400 ms hold, they stay while the pointer is over them), dismissable with Escape and
    persistent until the pointer leaves (1.4.13).
  - Timeline speed buttons use the target token (40 px, 44 px phone).
  - Tooltips of the Plan a journey and Statistics buttons open below the buttons.
- Languages EN, DE, PL; German strings are the longest and Polish carries diacritics (ą ć ę ł ń ó ś ź ż): both are part
  of every screenshot check.

## Platforms
- Web on phone, tablet, desktop and large screens. Verification viewports: 390×844, 360×780, 834×1194,
  1194×834, 1440×900, 2560×1440, dark and light, plus German and Polish strings.
- Component library: shadcn/ui style base-nova on Base UI 1.9 with Tailwind v4.3, in `packages/ui`, themed entirely
  from these tokens, our own `cn` from clsx and tailwind-merge (2026-10-25, after WP-4.1 compared nova, vega and
  maia: base-nova needs the fewest overrides for 8 px controls, 10 px cards and pill-only chips).

## References
- test.offentligdata.com. Reference screenshot: dark teal basemap, thin light-blue track lines, extruded buildings in muted teal-grey, roads at close zoom drawn as light-grey ribbons with dashed centre lines, a 3D articulated train model placed car by car on the track, a selected train marked by a small white ring with a leader line to a dark translucent info card. Card: small uppercase monospace category label with an icon ("TRAINS"), large title (train line "FLY1"), label/value rows in monospace labels and proportional values (Destination, Operator, Delay, Position updated), footer naming the source and stating "motion estimated between fixes". Take: quiet dark palette, articulated cars on the track, the card anatomy and its honesty about estimated motion. Leave: Norway-specific content, the stutter and off-track motion seen on the site. Measured details: card 310 px, radius 7 px, kicker IBM Plex Mono 10/700, title Manrope 14/700; panel base #080c12, panel rgba(13,19,28,.84), one cool accent #72b7ff. Also take: zoom-gated layers with live counts and "appears at zoom N" hints, a context legend listing only what is on screen, a zoom-stage line, theme switch. Also leave: the serif headline mixed with two other faces, raw snake_case keys, 60+ layer list, marker clutter at zoom 11 to 17, pins with stalks over vehicles, rigid meshes across platforms, a phone drawer covering 82 % of the screen with a card that never appears.
- Mini Tokyo 3D: take articulated cars that bend with the track, camera follow with a timetable panel and a progress dot between stops, playback with a time editor, underground mode, a phone layers sheet. Leave: 13 MB of static JSON and a 766 MB heap, box cars without detail, an unlabelled icon column, generic Helvetica UI.
- Flightradar24: take one loud selection colour against a calm fleet colour, the trail of the past path, the card hierarchy (identity, photo with credit, origin and destination, times, progress, actions), follow as an explicit action, a phone bottom sheet with a peek state, a bottom action dock on phone. Leave: overplotting thousands of identical icons at low zoom, ads and upsells, filters behind an account.
- Windy.com: take the layer picker as labelled thumbnails, a legend bar with units bound to the active layer, a bottom timeline with play for history playback, sheets sliding up on phone. Leave: saturated full-screen colour fields (trains must stay the focus), consent walls.
- geOps Mobility Portal: take the delay ring around a category-coloured badge, the selected route in line colour with a stop list and delay chips. Leave: flat 2D dots only, promo cards over the map.
- Rendered directions (2026-10-24): A Stellwerk, C Atlas and D Nachtfahrt stay in `design/variants/` as the design
  record. Candidates to borrow later (proposed, not decided): the Ctrl K command palette from D for power users, the
  fine national rail network from D (needs our own rail graph, WP-2.2), the relief and landuse tones from C for the
  Terrain style, the compact stop table with platform columns from A for an expert view.

## Decisions
- 2026-10-23 Audience is three groups with equal weight.
- 2026-10-23 Languages EN, DE, PL.
- 2026-10-23 Product scope, web on all screen sizes.
- 2026-10-23 Desktop-led layout, phone in full; precise instrument with selected traits of the other directions; dark default plus light; free data now, about 20 EUR per month later.
- 2026-10-23 Avoid gradients and glass, dashboard template, DB imitation, neon; references Mini Tokyo 3D, Flightradar24, Windy; faithful lightweight 3D models; signature moment click and fly to train.
- 2026-10-23 Colour encodes category by default, delay and operator as modes; first load shows all of Germany in motion; deep links to a train or place.
- 2026-10-23 Content rule: every number shown comes from a source or our own database; no invented statistics, photos only with licence and attribution.
- 2026-10-23 Stack chosen after research.
- 2026-10-24 Stack decided in ADR-0010: Vite, React 19, TanStack Router and Query, Zustand, MapLibre GL JS 6 with deck.gl 9.4; component library default shadcn/ui on Base UI with Tailwind v4, confirmed or changed with the chosen direction.
- 2026-10-24 Personality precise, calm, deep (each with its opposite to avoid); balanced density.
- 2026-10-24 Four directions rendered from real data (A Stellwerk, B Fahrplan, C Atlas, D Nachtfahrt); the rubric
  scores were D 23, B 22, A 21, C 19 of 25; the maintainer chose **B Fahrplan** as the main look.
- 2026-10-24 Light palette, delay palette and stage line strings from variant B.
- 2026-10-24 Place labels above the trains on the map.
- 2026-10-25 From the design system build (WP-4.1): base-nova on Base UI, derived
  interaction states, solid ink button, ink checked controls, light selection graphics in `primary-text`, light error
  never as text, the phone peek anatomy, loading spinner replaces the icon, muted hidden counts, popups fade only;
  targets stay 40 px desktop and 44 px phone with no exemptions.
- 2026-10-24 From the first light build (WP-1.4): `map-*` tokens for every basemap colour; legend totals on
  their own line; Now label and row heights of the route strip; collapsed phone sheet hides the passed stop; text face
  for words in the delay slot; Recorded sample wording in the live bar; trains without track geometry are counted, not
  drawn.
- 2026-10-26 The phone keeps a small wordmark: one line with GerLines above the search field, without the tagline,
  so a first visit from a phone sees the name at once.
- 2026-10-26 From the layout build (WP-4.2): compact sizes collapse the legend to its
  header; attribution visible on load everywhere and collapsing only after interaction or five seconds (OSMF
  Attribution Guidelines 2021); one visible Soon convention for controls not built yet; the peek route line starts at
  the Now dot and the expanded sheet fits its content until WP-4.3; visible counts in ink; attribution beside the zoom
  controls, stacked phone live bar, map error card, the Soon pill.
- 2026-10-29 Map styles (WP-4.5): the style picker is the only theme switch (Dark and Satellite dark, Light and Terrain
  light); satellite tokens `map-rail-satellite` and `map-boundary-satellite`; German shows local names abroad and Polish
  keeps border twin towns apart; Land focus look and entry point; soft bounds values; 3D terrain hidden until trains
  carry elevation.
- 2026-10-29 Train card (WP-4.3): every card state, the station card, the measured phone peek with the short-run line,
  the vehicle block only when expanded, Follow as one-label toggle (APG), Polish Kierunek {to}.
- 2026-11-08 Statistics panel (WP-7.3): one card slot with the train and station cards, area and period tabs, State
  with DE Land and one Polish term, the number rules, own SVG charts with the delay distribution on a minutes scale
  (equal-width bins rejected) and night as the outlined bar, missing data as missing, Land sync, the DB comparison only
  for Germany over whole months, lazy messages.
- 2026-11-08 Terrain 3D (WP-5.3): the 3D terrain switch in the Terrain style, buildings and their switch only
  in Terrain 3D until WP-5.4, device tiers with the stored choice winning, the selection over the relief, hidden trains
  as ghosts, the deck line on bridges, rails on the relief with bridge rails at 50 % and tunnel rails at 40 % dashed,
  building light 0.22 in place of new wall and roof tokens.
- 2026-11-08 Journey planner and the panel pair (WP-8.2): Plan a journey and Statistics as an exclusive pair of icon
  buttons in the search row on every size, one slot, the panel head, a set-aside panel kept in the address, the journey
  in category colours and never amber, the selected row rule, pressed and toggle states, the punctuality hint from 5
  runs, change rows, the data sources button hidden under an expanded sheet.
- 2026-11-08 Forecast block on the train card (WP-7.5): labelled as a forecast, anchored on the feed's own
  forecast where it has one with B1's spread for the 8 in 10 bound, B1 alone elsewhere, the method and source in its
  caption.
- 2026-11-08 Legal pages and the footer line (WP-9.6 part): own paths with one header, one row form for sources and
  providers, Missing as a chip, the attribution ending with the legal links and the not-affiliated sentence; the
  livery row in the vehicle block decided but not built.
- 2026-11-08 Speed row on the train card: the plan speed of the selected train from the worker, rounded to
  5 km/h, standing only in a dwell, its basis in a caption, never coloured.
- 2026-11-08 Operator colour mode: groups by the catalogue's first parent organisation with the named company
  aliases, Deutsche Bahn and five hues that pass the validator's any-pair mode in both themes, Other and Unknown as
  smaller neutral marks, the legend rows with counts and session-only hide toggles, colours that encode groups and not
  brands.
- 2026-11-08 Accessibility conventions of the WP-9.2 code pass (skip link, landmarks, inset rings, the active option
  bar, focus return, Escape by layer, quiet live regions) recorded as built; the five contrast shortfalls kept as a
  known limit until the browser pass decides.
- 2026-11-08 Segment profile on the train card and the map (WP-7.4b): a switch in the card for a train the map draws,
  Median or 80th percentile, a seven-class diverging whole-minute scale of this train against all trains in its own
  colours, missing legs dashed with the reason, legs matched by stop place ids, a curtain in pitched views whose height
  is the minutes lost.
- 2026-11-08 Signature moment built (WP-5.4): fly and tilt on selection, the route ahead drawn along the track,
  Follow at the chase view, tilt back on close, a stored Tilt on selection switch, reduced motion as a cut with a short
  fade.
- 2026-11-08 Shell fit and tablet rules: the measured
  right-column ladder with the style-card fold, the folded style card on compact sizes, the tablet overview padding and
  the left-slot ease, the playback panel (width min(560 px, 100vw - 32 px); from 1040 to 1279 px right of the card
  slot, below 1040 px aligned with the live bar at 16 px; Day and Hour selects in the field style, 40 px and 44 px on a
  phone), the planner leg headsign (a headsign that is not a stop of the answer becomes the trip's last stop display
  name, the card rule), Photo credits Try again (error states), the pinned 40 px title and delay bar of the expanded
  phone sheet (aria-hidden, no room in the flow), four placeholder strings per language.
- 2026-11-08 The live bar beside the corner; the card of a train
  picked from Trains in view takes the focus on its heading only while the focus is free, and the next heading takes it
  when the frame card is replaced by the detail card; the Trains in view sheet names its handle for the list (Show the
  whole list, Show less of the list) and Escape closes it, focus to the entry button; list rows follow the card title
  rule (one module, components/train/train-naming.ts); the selected marker and its label draw above place labels, every
  other train layer under them; the desktop train card pins a 40 px bar with title, delay and Close once its head
  scrolls away, with 3 rem of scroll padding, focus moving to the head's Close when the bar goes; the right column pads
  each side by a card shadow's reach (16 px top and right, 24 left, 32 bottom) cancelled by a negative margin, and
  reserves the zoom hint line only while a label mode is on; the phone layers popover is as tall as the room left; the
  playback Day select takes 3 parts to the Hour select's 2; the German and Polish high-speed legend rows are product lists like the
  others (ICE, TGV, RJX); a retry button keeps the focus while it retries (aria-disabled, never disabled) and the focus
  goes to the result when it succeeds.
- 2026-11-08 Below 1280 px (width < 1280px), including compact
  sizes from 1040 px, the credits fold to their info button the moment the timeline opens and return when it closes
  above compact size (a card the user reopened stays until closed; focus inside is never pulled away, the card folds
  once focus leaves it); the left column ends one 12 px gap above the measured live bar wherever it runs under it, and
  with the timeline open it runs beside the timeline from 1040 to 1279 px and from 1650 px and ends above the whole
  bottom stack from 1280 to 1649 px; the Polish high-speed legend row is the product list ICE, TGV, RJX; the pinned
  bar of the train card draws the delay at the title's size.
- 2026-11-09 From the WP-9.8 fixes: the phone colour key above the live bar, the
  collapsed card's vehicle line, the vehicle block's facts, series names by `br` and source names from the API, the legend
  while loading; the head delay from the next stop's prediction with the Now label, and the planner leg's Show the
  train live.
- 2026-11-09 From the WP-9.8 recheck fixes: the collapsed vehicle line leaves out a generic L4 model,
  German and Polish name the generic models (Typischer, Typowy), the phone live bar holds its second row from the first
  paint, and the legend counts stay missing until the first train is drawn.

## Open questions
- Tagline and wordmark: keep "Every train in Germany, live" and the Overpass 800 wordmark, or design a mark later.
- Collapsed card height: the vehicle block with photo makes the collapsed desktop card tall; WP-4.3 tests a shorter
  collapsed card with the vehicle one click deeper.
- Delay palette checked under deuteranopia and protanopia simulation (WP-4.4).
- Reduced-motion behaviour (default: respect prefers-reduced-motion, camera cuts instead of flights, vehicles still move). (assumed)
