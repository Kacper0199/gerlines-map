# Accessibility

What GerLines promises, what was checked and how, what is known to fall short, and what a later pass in a real browser
must still check. Design values live in [DESIGN.md](../DESIGN.md) (Accessibility, Colors, Motion); this file is
the evidence and the checklist.

## Target

- **WCAG 2.2 level AA** for the whole web client: the map page with its cards and panels, the photo credits page and the
  legal pages (Sources, Privacy, Impressum). Phone, tablet and desktop layouts, English, German and Polish, dark and
  light.
- Not claimed: level AAA criteria, native apps (there are none), PDF or e-mail output.
- The state after the browser pass (November 2026): the code pass plus a real axe-core 4.14 run in Chromium over the
  shell, panels and legal pages, the zoom, reflow, text spacing, forced colors, reduced motion and focus checks below,
  and the fixes the pass and decision D-070 asked for.
  **Not run: VoiceOver, NVDA, TalkBack, Safari and Firefox.** No conformance statement is published before
  a screen reader pass.

## What was checked, and how

| Check | Where | Run with |
| --- | --- | --- |
| axe-core 4.14.0 (WCAG 2.0 to 2.2 A and AA rules plus best practices) over every panel and state: shell controls, both whole shells with a skip link, search with results and after an error, layers popover, status popover, train card (loading, error, collapsed, expanded), station card (found, missing, failed), statistics (loading, network figures, phone), timeline (picking, playing, error), planner, photo credits, legal pages, map failure notice | `apps/web/src/a11y/*.a11y.test.tsx` and the older tests of `status`, `train`, `journeys`, `legal` | `pnpm --filter @gerlines/web exec vitest run src/a11y` |
| The axe helper itself, proved to catch a nameless button, an image without text and loose text outside a landmark | `apps/web/src/a11y/axe-helper.test.ts`, helper `apps/web/test/helpers/axe.ts` | same |
| Contrast of 16 text pairs and 26 interface part pairs in both themes, hover and pressed colours mixed in oklab from the shipped `theme.generated.css`, plus the pairs that fall short with their recorded floors | `packages/ui/src/theme/contrast-table.test.ts` (and the older `contrast.test.ts`) | `pnpm --filter @gerlines/ui exec vitest run src/theme` |
| Keyboard behaviour: skip link, focus after a card closes, Escape, timeline focus, search retry with Enter, result counts | `apps/web/src/a11y/focus.test.tsx`, `search.a11y.test.tsx`, `states.a11y.test.tsx` | same |
| Reduced motion: the global CSS rule exists, every smooth scroll and camera move outside the map folder reads the preference, the pulsing legend rows have a still version | `apps/web/src/a11y/reduced-motion.test.ts` | same |
| Copy: the new strings in EN, DE and PL, plural forms, copy lint | `packages/i18n/src/copy-a11y.test.ts`, `pnpm lint:copy` | |
| axe-core 4.14.0 in Chromium against the dev server over a replay (25 October 2026 15:00 UTC) with every rule of WCAG 2.0 to 2.2 A and AA plus best practices, including colour contrast, target size, region and landmarks: idle map, search results and no match, station card, train card, statistics, planner, timeline, status popover, layers popover (phone), Trains in view; desktop 1440 dark and light in EN, DE and PL, phone 390 and 360, tablet 834 and 1194, the Sources, Privacy, Impressum and credits pages at 1440 and 320 | `playwright-cli run-code` with the file injected from `apps/web/node_modules/axe-core` | |

axe in happy-dom has no layout and no CSS, so the rules that measure a rendered page are switched off in the helper (`BROWSER_ONLY_RULES`: colour contrast, target size, link in text block, scrollable region focus, orientation lock) and a test proves a 10 px button is not reported as a pass. Zoom and reflow cannot run there either.
That is why contrast is computed from the tokens and why the browser pass is needed.

## Conventions the code follows

- **Names and roles.** Every control has an accessible name; icon buttons take it from the `label` prop of
  `IconButton`; the visible text of a control is contained in its name (2.5.3). Toggles use `aria-pressed`, disclosures
  `aria-expanded` with `aria-controls`, the search field is an ARIA combobox with `aria-activedescendant`.
- **Landmarks.** The app is one `main`. Inside it: the map section, the `search` landmark around the search field, the
  legend card as a named region, the credits as a named complementary area, and the cards as named articles or
  sections. One `h1` (the wordmark in the search card); cards and panels use `h2`, groups inside them `h3`. The legal
  and credits pages have `header`, `nav`, one `main` and one `h1`, and set the document title.
- **Skip links.** The first two stops of the page are "Skip to search", which moves the focus over the map canvas to
  the search field, and "Skip to trains in view", which opens the Trains in view list and focuses its heading. Each is
  visible only while it has the focus.
- **Text alternative of the map (1.1.1).** The map is pixels, so the Trains in view list (`apps/web/src/inview`) names
  what it shows: the 20 shown trains nearest the middle of the map, each a button with its line or number, kind, delay,
  distance and compass direction, opening that train's card. It opens from the button in the legend header or the
  second skip link, takes the card slot (a sheet on phones) and asks the live worker (`nearest` message,
  `apps/web/src/live/nearest-trains.ts`, trains counted inside the unprojected screen quad) when it opens, when the data first
  goes live while it is open, 300 ms after a move the user makes, every 20 s while no row has the focus, and on the Update
  list button; a failed request reads "The list of trains could not be loaded.". A one sentence summary of the
  view ("412 trains in view") sits in a polite, visually hidden status region; it changes only after the user moved
  the map and at most every 10 seconds (`inview/announcer.ts`), so dragging does not chatter.
- **Keyboard shortcuts (2.1.4).** The slash key (focus the search) can be switched off with Keyboard shortcuts in the
  layers area; it is on by default and stored like the terrain switch (`gerlines-keyboard-shortcuts`, listed on the
  Privacy page).
- **Choices without panels are radio groups (4.1.2).** The colour mode and the label mode are native radios in a
  `radiogroup` that look like the tab lists they replaced (`RadioTabs`); real tab lists stay where tabs have panels.
- **Content on hover or focus (1.4.13).** The segment profile tooltip can be hovered (it outlives the leg for 400 ms
  and stays while the pointer rests on it), is dismissed with Escape and stays until then or until the pointer leaves.
- **Focus.** Focus rings are 2 px in the `focus` token with a 2 px offset (`focus-ring`). Controls that touch the edge
  of a clipping card use an inset ring (`focus-visible:outline-offset-[-2px]`). The active option of a combobox list has
  a 3 px bar in the `focus` token in addition to the raised fill. Tab lists keep 4 px of room around their triggers so
  the ring is not clipped by their scroller. Scrollers with a sticky bar keep `scroll-padding` for it (2.4.11).
- **Focus return.** Closing the train card or the station card (button or Escape) returns the focus to the map
  canvas, closing the statistics panel returns it to the Statistics button, the planner returns it to its button, the
  timeline to History, popovers to their trigger (Base UI). The focus is only moved when closing dropped it to the page.
- **Escape** closes, in this order: an open list or popover, then the card or panel. Cards listen on `window` and
  skip an event that was already handled.
- **Live regions.** Status messages use one polite `role="status"` per surface, and only for short messages: loading,
  empty, error, a result count ("5 results"), copy or share feedback, the data state in the live bar. Result lists,
  the timer, counts that tick and hover tooltips are never live. Errors that need action use `role="alert"`.
- **Reduced motion.** `prefers-reduced-motion: reduce` cuts every CSS animation and transition (one rule in
  `packages/ui/src/styles/index.css`), turns smooth scrolling into jumps, turns camera flights into cuts and removes
  train fades. Trains still move on the map: that movement is live data, which WCAG exempts as essential (2.2.2), and
  the timeline offers pause.
- **Target size.** 40 px on desktop and 44 px on phone (`--gl-target`); WCAG needs 24 px (2.5.8). The timeline speed
  buttons use the token since the browser pass. Inline links in running text (the credits line) use the inline exception; stacked
  links in a list keep 8 px between them (the Sources page licence list).
- **Colour is never the only carrier.** Delay is a number in ink, category marks differ in shape as well as colour,
  night trains have their own shape, state dots sit beside a word.
- **Language.** `html lang` follows the interface language; the language switch options carry their own `lang`; the
  map canvas is named in the interface language.
- **No pointer-only paths.** The bottom sheet drags but also has a handle button; the map pans with arrow keys and
  zooms with plus and minus or the zoom buttons.

## Fixed in the browser pass

| WCAG | Finding | Fix |
| --- | --- | --- |
| 1.1.1, 2.1.1 | The map had no text alternative | Trains in view list, view summary, second skip link (D-070) |
| 2.1.4 | The slash shortcut could not be turned off | Keyboard shortcuts switch, on by default |
| 1.4.3, 1.4.11 | Water labels, delay minor on land (light) below their ratio | `map-label-water` dark `#868480`, light `#46555D`; `delay-minor` light `#9E7A00` (`#9A7710`, the first candidate, failed the colour blind distance test of `delay-colours.test.ts`) |
| 2.5.8 | Timeline speed buttons 36 px; stacked licence links on the Sources page under 24 px with no room | `h-target min-w-target`; 8 px between the links |
| 1.4.13 | Profile tooltip not hoverable | Hoverable, held 400 ms, dismissed by Escape |
| 4.1.2 | Colour and label mode were tab lists without panels | Radio groups |
| 4.1.2 | `aria-controls` of the History button named a panel that does not exist | Set only while the timeline is open (axe, 39 nodes) |
| 1.3.1, 4.1.2 | Two landmarks named "Map of trains in Germany" (section and canvas) | One named landmark: the canvas (axe, 47 nodes) |
| 2.1.1 | The scrolling source list of the status popover could not be reached by keyboard | Focusable group named Source list (axe, 5 nodes) |
| 1.4.1, 1.4.11 | Forced colors lost the state of switches, checkboxes, toggles and radio tabs | `forced-colors:` variants |
| 1.4.3 | Muted text on a hovered list row in the light theme: 4.46 | Hover uses the raised fill, which passes (axe) |
| follow-up | Reduced motion read once at start | The worker takes a `reduced-motion` message; the media query change reaches it |

## Fixed in the code pass

| WCAG | Finding | Fix |
| --- | --- | --- |
| 2.4.1 Bypass blocks | No skip link; the search field had no landmark | Skip link as first stop, `search` landmark |
| 2.4.3 Focus order | Closing the train, station or statistics card dropped the focus to the page | Focus returns to the map canvas or the opening button (`apps/web/src/a11y/focus.ts`) |
| 2.4.3 Focus order | The timeline opened before the History button in reading order, so Tab skipped it | The focus moves into the timeline when History opened it; Escape returns it |
| 2.1.1 Keyboard | Search error: the Try again button disappears when the field loses the focus, so the keyboard could not retry | Enter retries, and a hidden hint says so |
| 4.1.3 Status messages | Search and station field gave no result count; the statistics station search read its whole list on every keystroke | One short count in the polite region; the list is no longer live |
| 4.1.3 Status messages | The hover tooltip of the segment profile was a status region and announced on every mouse move | Plain element, no role |
| 1.4.13 Content on hover | The profile tooltip could not be dismissed | Escape dismisses it (hoverable and persistent are open, see gaps) |
| 3.1.2 Language of parts, 4.1.2 | The map library names its canvas "Map" in English | Named in the interface language, described by the keys that move the map |
| 1.3.1 Info and relationships | The legend heading was inside a button | The button sits inside the heading |
| 2.4.7 Focus visible | Rings clipped at the edge of cards (legend toggles, zoom buttons) and by tab list scrollers; the active combobox option showed only a faint fill | Inset rings, room around tab lists, a bar on the active option |
| 2.4.11 Focus not obscured | Focusing a stop under the sticky "all stops" bar | `scroll-pb-16` on the card scroller |

## Known gaps

The browser pass: axe went from 91 violations in 47 states
(`aria-valid-attr-value` 39, `landmark-unique` 47, `scrollable-region-focusable` 5) to 0 in 46 states, and the Sources page
from 2 `target-size` violations to 0. What stays:

| Gap | WCAG | Note |
| --- | --- | --- |
| Selection fill `primary` `#F08C00` is 2.08 on land and 2.38 on surface in the light theme (needs 3). On the map the ink outline carries the marker: a zoomed screenshot (not committed) shows an amber chevron with an ink outline and the route with an ink casing, so no extra halo was added (D-070). | 1.4.11 | Held at its floor by `contrast-table.test.ts` |
| No screen reader, Safari or Firefox pass. | all | Needs a person with VoiceOver and NVDA |
| The profile tooltip was checked in unit tests only: the replay database has no segment figures, so no leg could be hovered in the browser. | 1.4.13 | Check on a database with `stats_train_segments` |
| The switch (36 by 20 px) and the live bar status button (54 by 21 px) are below 24 px and pass 2.5.8 by spacing only; axe agrees. | 2.5.8 | Components unchanged |
| The attribution folds itself after five seconds on phones and compact sizes; the button restores it at any time. Treated as a collapse, not a time limit. | 2.2.1 | Judgement |
| Fixed pixel font sizes (11 px attribution, 12 px captions): page zoom to 200 percent works with no clipping at 640 by 400 and 320 by 256; text-only zoom does not scale them. | 1.4.4 | Page zoom is the supported path |
| The Trains in view summary counts trains, not stations (no station query exists in the map layer yet). | 1.1.1 | Follow up |

## Results of the browser pass

| Check | Result |
| --- | --- |
| 200 percent zoom (640 by 400 CSS px) and 320 px reflow (320 by 256) | no horizontal page scroll, no clipped control, the phone layout takes over (screenshots not committed) |
| Text spacing 1.4.12 (line 1.5, letters 0.12, words 0.16, paragraphs 2) in German on desktop and phone | nothing clipped or overlapping (screenshots not committed); the layers popover and the list scroll |
| Focus order and focus not obscured | skip to search, skip to trains in view, map canvas, search, panel buttons, language, styles, shortcuts switch, legend, Trains in view, live bar, History, attribution links, zoom; nothing covered by another element; list rows clear the sticky close button |
| Forced colors | focus rings, borders and text stay; the state of switches, checkboxes, toggles and radio tabs was lost and is fixed (underline for pressed and chosen, Highlight for checked) |
| Reduced motion, also changed while the page is open | animation and transition durations drop to 0.00001 s at once; no console error; the worker takes the new value for the next playback start |
| Contrast in context | popover text of the status and layers popovers measured by hand: at least 6.47 in both themes (axe could not decide: the popovers sit over the canvas) |
| Document title per language | already localised at start and on change (EN, DE, PL checked) |
| Keyboard shortcuts switch | slash focuses the search when on, nothing when off; stored as `gerlines-keyboard-shortcuts`, kept after a reload |
| Legal and credits pages | 0 axe violations at 1440 and 320 after the licence list fix; no table overflows, so no `tabindex` was added |

## Browser checklist (the browser pass ran 1 to 6 and 8 to 10 except the profile tooltip; 7 is open)

Use a built preview (`pnpm --filter @gerlines/web build && preview`) in a real browser, never the dev server. Record
the results and, when all pass, write the conformance statement.

1. **axe in the page.** Run axe-core (including the `color-contrast`, `target-size` and `region` rules) on: the map page
   with nothing selected, with a train card, with a station card, with statistics, with the planner and its results,
   with the layers popover (phone), the status popover, the timeline, in dark and light, EN, DE and PL.
2. **Contrast in context.** Spot check the pairs listed as gaps, text over satellite imagery, the live bar over the map,
   the selection amber on land in light, forced colors (`playwright-cli set-forced-colors active`) and
   `set-contrast more`.
3. **200 percent zoom and 320 px reflow (1.4.4, 1.4.10).** 1280 px wide at 200 percent, 320 px wide at 400 percent: no
   horizontal scroll of the page, no clipped controls, the phone layout takes over, the sheet scrolls.
4. **Text spacing (1.4.12).** Apply the WCAG text spacing bookmarklet values (line 1.5, paragraph 2, letter 0.12,
   word 0.16): the live bar (nowrap), chips, buttons and cards must not clip text. German first.
5. **Keyboard only.** Tab through the whole page in both shells: order matches reading order, nothing is skipped or
   trapped, every ring is visible and not covered by a sticky bar (2.4.11), the skip link appears on the first Tab.
   Open and close with Escape: train card, station card, statistics, planner, timeline, layers, status, attribution;
   check where the focus lands each time. Use arrows, plus and minus on the map canvas.
6. **Target size (2.5.8).** axe `target-size` on phone and desktop; measure the switches, checkboxes, tab triggers
   and the timeline speed buttons.
7. **Screen reader spot checks.** VoiceOver on macOS with Safari and on iOS; NVDA with Firefox if available. Read: the
   landmark list (rotor), the search combobox with results and the count, the live bar state change, the status
   popover, the train card and its stops list, the timeline controls and its scrubber value text, a statistics chart
   with arrow keys and with the table switched on, the planner form errors and results. Check that nothing chatters
   while trains move and the data time ticks.
8. **Reduced motion.** `playwright-cli set-reduced-motion reduce`: route draw, progress dot, camera flights, sheet and
   card transitions, spinners, train fades all cut; change the setting while the page is open.
9. **Touch.** Phone: targets 44 px, the sheet handle works by tap, drag is optional, pinch zoom of the page is not
   blocked.
10. **Pointer and hover content (1.4.13).** Tooltips on icon buttons: hoverable, dismissible with Escape, persistent.
