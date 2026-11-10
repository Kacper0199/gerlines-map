# Documentation

| Document | Kind | Read it to |
| --- | --- | --- |
| [../README.md](../README.md) | overview | learn what GerLines is, what works today and how to start it |
| [development.md](development.md) | how-to and reference | set up the monorepo, run the checks, add a package, understand CI |
| [KEYS.md](KEYS.md) | how-to | get the API keys and accounts an operator of GerLines supplies |
| [architecture.md](architecture.md) | explanation | understand how data flows from the sources to the moving trains |
| [adr/](adr/) | explanation | read why each major decision was taken |
| [data-sources.md](data-sources.md) | reference | see every data source, its licence and the attribution it needs |
| [statistics.md](statistics.md) | reference | see the statistics routes, how each figure is computed, the segment profile, the validation against DB and the statistics panel |
| [history.md](history.md) | reference and how-to | see how the piebro history is converted and loaded, its limits and its punctuality against DB's figures |
| [predictions.md](predictions.md) | reference | see the B0 and B1 delay forecasts, their backtest, the live shadow check and how the card anchors on the feed |
| [runbooks/delfi-rollover.md](runbooks/delfi-rollover.md) | how-to | take a new weekly DELFI feed through import, shapes, MOTIS, realtime and the live engine, and compare the stop ids of stations without a DHID around the MOTIS switch |
| [runbooks/deploy.md](runbooks/deploy.md) | how-to and reference | see the prepared production stack (not deployed), what is hardened and how `pnpm deploy:check` checks it, the steps and what is left to the operator |
| [PLAN.md](PLAN.md) | plan | see milestones, work packages and the gates that prove each one |
| [decisions.md](decisions.md) | reference | look up a decision the code or a document cites as D-0NN |
| [accessibility.md](accessibility.md) | reference and checklist | see the WCAG 2.2 AA target, what was checked in code and in Chromium and how, the known gaps and the checks still open (screen readers, Safari, Firefox) |
| [screenshots.md](screenshots.md) | how-to and reference | capture the documentation screenshots and check their licences |
| [deployment-options.md](deployment-options.md) | explanation | compare the ways to deploy GerLines (one server behind a CDN, AWS, others) with their cost and effort |
| [assistant.md](assistant.md) | proposal | read the design of a natural-language assistant over the API and the documentation (not built) |
| [../DESIGN.md](../DESIGN.md) | reference | read the design system and the design decisions |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | how-to | contribute a change |
| [../SECURITY.md](../SECURITY.md) | policy | report a security problem |
| [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | policy | see how contributors treat each other and how to report a problem |
| [../NOTICE.md](../NOTICE.md) | reference | see the third-party data, services and fonts and their licences |

Package guides live next to the code: `apps/web`, `apps/api`, `services/ingest`, `services/router`, `packages/db`,
`packages/i18n`, `packages/live-frame`, `pipelines/static_import`, `pipelines/rail_graph`, `pipelines/geo_base`,
`pipelines/catalog`, `pipelines/rollups`, `pipelines/backfill`, `pipelines/predict`, `tools/trainforge`,
`tools/photo-review`, `tools/load`, `catalog/`, `infra/` and each spike under `spikes/` have a `README.md`. `services/live` is
described in [development.md](development.md) (Live engine); the frame format is `packages/live-frame/FORMAT.md`.
