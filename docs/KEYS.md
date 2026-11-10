# Keys and accounts

Most data in this project is keyless. This page lists the few keys and accounts the user provides, where to get
them, the env var names, and which work waits for them (key gating, D-004). Values go only into `.env` at the
project root (git-ignored). Start from the template: `cp .env.example .env`, fill in, then run
`bash scripts/check-keys.sh`. The script never prints secret values.

## Needed before the first build wave

### APP_NAME and APP_CONTACT (no registration)

VBB, Geofabrik and other providers ask every client to identify itself. Each outbound request sends
`User-Agent: <APP_NAME>/<version> (+<APP_CONTACT>)`.

- `APP_NAME`: the product name, `gerlines`.
- `APP_CONTACT`: an e-mail address or URL where providers can reach you about traffic from this project, for example
  a dedicated project mailbox or, later, the GitHub repository URL. It becomes visible to every data provider.

### K1 DB API Marketplace (free)

Gives DB Timetables (IRIS: departures, arrivals, platform changes, messages at DB stations), StaDa (station master
data) and FaSta (lift and escalator status). Licence of the data: CC BY 4.0.

1. Open https://developers.deutschebahn.com/db-api-marketplace/apis/start and register. This creates or links a DB
   customer account and sends an e-mail code.
2. Under Applications, create a new application (any name, for example `germany-map-local`). The page shows the
   **Client ID** and the **Client Secret (API key)**. The secret is shown only once; copy it immediately.
3. In the API catalogue, subscribe this application to three products:
   - Timetables, plan **Free** (60 requests per minute)
   - StaDa Station Data, plan **Free4All**
   - FaSta Station Facilities Status, plan **Free4All**
   - optional: OpenStation (station infrastructure as NeTEx, open data), if its page offers a free plan; the same
     data is on Mobilithek (offer 879076212433727488), which DB recommends for production use
   Do not subscribe to the RIS products, ISR Data Service (1,846 EUR per year, railway undertakings only), Bonvoyo,
   Shared Mobility or parking APIs: they are paid, partner-only or out of scope.
4. In `.env`:
   ```
   DB_CLIENT_ID=<Client ID>
   DB_API_KEY=<Client Secret>
   ```
   Requests send them as the headers `DB-Client-Id` and `DB-Api-Key`.

Waits for K1: SP-2 (realtime coverage check), WP-2.4 (DB adapters), parts of WP-6 and WP-7 validation.

## Recommended now, needed later

### K3 Mobilithek account (free)

Mobilithek is the national mobility data portal. These offers matter (checked in a browser on 2026-10-24):

- DELFI GTFS-RT, the official realtime feed for all 16 Länder and all modes, updated every minute. Public offer,
  but "Abonnement erforderlich": DELFI e.V. approves each organisation. Until then we use the community mirror.
  https://mobilithek.info/offers/858688352316981248
- Bahn-Vorhersage datasets (ODbL), visible only when logged in:
  - parsed train delays since 2021 with forecast history, for ML training: https://mobilithek.info/offers/938616012299546624
  - stations and GTFS stops mapping: https://mobilithek.info/offers/940263406913355776 (open data, not brokered, no
    subscription: `stops.parquet` and `stations.parquet` under "Data Access", ODbL, credit Bahn-Vorhersage,
    Deutsche Bahn, Derf, Trainline and DELFI; documented at https://bahnvorhersage.de/open-data/stops; checked
    2026-10-28)
  - optional raw data: schedule https://mobilithek.info/offers/938849406229053440, realtime
    https://mobilithek.info/offers/938859748233478144 (large; only if the parsed set is not enough)

Steps (from the BASt guide to Mobilithek, checked 2026-10-24):

1. Register at https://mobilithek.info/registration-request with your e-mail address, follow the verification
   link, complete the profile (name, password, language, privacy and terms).
2. Subscribing requires membership in an organisation. A private project cannot register as one: the service desk
   checks that the homepage is reachable and that the e-mail domain matches it, and only official organisations may
   provide data. Register as a private person who only receives data: file a new organisation request and describe
   the purpose of use in the field "Kommentar"; no homepage or GitHub URL is needed (service desk
   OS-SD-Mobilithek@o-s.de). When it is active you get the role "Organisationsadministration".
3. Under "Meine Organisation", open your user and also tick the role "Bestellmanagement" (needed to subscribe).
4. While logged in, open each offer above and click "Abonnieren" at the top of the page, accept the licence terms,
   confirm. The data provider reviews the request and e-mails the result; the status is under "Meine Abonnements".
5. If an offer lists downloads under "Dateien oder Inhalte", open data can be downloaded without a subscription.
6. Machine access to a subscription goes through `https://mobilithek.info:8443/mobilithek/api/v1.0/…` with a client
   certificate issued by Mobilithek (technical interface description 1.3.2 of 2025-11-07, chapter 8). The
   organisation administrator requests it under "My Organisation", tab "Machine Accounts"; it arrives by e-mail and
   its password by SMS to the phone number given in the form. Keep the certificate file and its password out of the
   repository and out of chat. The spec says the server certificate is signed by Mobilithek; on 2026-10-28 port 8443
   presented a public chain (`*.mobilithek.info`, Telekom Security OV RSA CA 26A, Telekom Security TLS RSA Root 2023),
   so the default trust store works and the CA certificates inside the `.p12` only sign client certificates.
7. Put the certificate at `secrets/mobilithek/gerlines-recorder.p12` (ignored by git) and fill `.env`:
   ```
   MOBILITHEK_CERT_P12=secrets/mobilithek/gerlines-recorder.p12
   MOBILITHEK_CERT_PASSWORD=<password from the SMS>
   MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID=<Subscription-ID>
   ```
   Type the password in your own terminal with hidden input, for example
   `read -rs "P?Mobilithek password: " && printf "\nMOBILITHEK_CERT_PASSWORD='%s'\n" "$P" >> .env && unset P`.
   `bash scripts/check-keys.sh` then checks K3 with one conditional request.

The DELFI GTFS-RT subscription was activated at once on 2026-10-28 (no provider approval), read with a machine
account certificate. The subscription page shows delivery mode Pull and the access
point `…/api/v1.0/container/subscription?subscriptionID=<Subscription-ID>`. Measured on 2026-10-28: an HTTPS GET with
the client certificate and `Accept-Encoding: gzip` returned 200, `application/octet-stream`, `Content-Encoding: gzip`,
1,188,505 bytes, which decode to a plain GTFS-RT FeedMessage of 5,054,531 bytes (version 2.0, full dataset, 16,925 trip
updates, 98,368 stop time updates, header timestamp 61 s before the response), not the XML container of the spec. The
response carries `Last-Modified` and `ETag`; `If-Modified-Since` returns 304 without a body. Without a client
certificate the endpoint answers 400. Leave "Relevant according to MDV/PBefG" unticked.

Recorded as `delfi-mobilithek-rt` (primary DELFI source, D-041) since WP-1.3b: 60 s at hh:mm:12, about 1.49 MB gzip a
minute, a 304 for an unchanged minute; the password is read from the environment only.

The Bahn-Vorhersage delays subscription was approved on 2026-10-29. It needs no variables: the subscription page shows
no delivery mode, and the files appear on the offer's "Data Access" tab only for a logged-in subscriber, downloaded in
the browser (no direct URL). Yearly `.tar` archives of daily Parquet files: 2021 1.8 GB, 2022 5.2 GB, 2023 8.3 GB,
2024 20.6 GB, 2025 19.9 GB (55.8 GB in total, listed 2026-10-29), schema at
https://bahnvorhersage.de/open-data/parsed-train-delays; forecast evolution only from September 2023. ODbL, credit
Bahn-Vorhersage, Deutsche Bahn, OpenStreetMap, Trainline and DELFI.

### K2 opentransportdata.swiss key (free, optional)

Swiss realtime for trains near Basel, Schaffhausen and Lake Constance. Plan GTFS-RT: five calls per minute, unlimited quota (checked 2026-10-24).

1. Register at https://api-manager.opentransportdata.swiss/ (e-mail, name, password of at least 12 characters with
   a number and a special character) and confirm the e-mail.
2. Create an application (for example `germany-map-local`).
3. In the API overview open GTFS Realtime (GTFS-RT), choose "read more", then "access with this plan", and add it to
   the application. One key per API.
4. In `.env`: `OTD_CH_API_KEY=<key>`. Requests send `Authorization: Bearer <key>`, a User-Agent and follow redirects.
5. Optional, same steps: Train Formation Service (formations of most Swiss trains, for vehicle identity of SBB
   trains in Germany) into `OTD_CH_FORMATION_API_KEY`.

The key is the TOKEN shown under "my apps", not the TOKEN HASH. A revoked token cannot be recreated for the same API
without contacting opendata@sbb.ch.

Waits for K2: the Swiss adapter in WP-2.3 (the rest of the work proceeds without it).

### SNCB realtime key (free, optional)

Belgian realtime (NMBS-SNCB trip updates and service alerts) for trains running to and from Aachen. Published by
the Belgian Mobility Company on https://data.belgianmobility.io (terms effective 2026-01-01: CC BY 4.0, the operator
is the licensor, attribution "Source: NMBS-SNCB – Open Data – <date>"; checked 2026-10-25).

1. Sign up at https://api-management-opendata-production.developer.azure-api.net/signup and confirm the e-mail.
2. Under Products, subscribe to **Standard** (free: 12,000 requests per day, 500 per minute) and name the
   subscription, for example `gerlines`.
3. Under Profile, copy that subscription's **Primary key** into `.env`: `SNCB_API_KEY=<key>`.
4. Requests send it in the header `bmc-partner-key` (not `Ocp-Apim-Subscription-Key`) to
   `https://api-management-opendata-production.azure-api.net/api/gtfs/feed/nmbssncb/rt/trip-update?format=protobuf&unroll=false`
   and `.../nmbssncb/rt/alert?format=protobuf`. The key never goes into a URL.
5. Check: the gateway answers 200 also without a key or with a wrong key (the anonymous tier, 100 requests per day
   and 10 per minute), so `check-keys.sh` cannot test the key by status code. The portal's Reports page counts only
   keyed calls on your subscription, about 30 minutes after they happen (verified 2026-10-26).

The recorder reads `SNCB_API_KEY` (passed through by `infra/compose.yaml`) and polls trip updates every 60 s and alerts
every 5 min, 1,728 keyed requests a day within the Standard tier; both sources are skipped while the key is empty. The
old variable `SNCB_GTFS_RT_URL` is gone. Before the first run with a key, check on the Reports page after an hour that
the calls are counted as keyed.

### IRIS polling by the recorder or the CLI (K1)

`RECORDER_DB_APIS=1` lets the recorder poll IRIS for the long-distance cover of D-041 (`IRIS_LONG_DISTANCE_COVER`: 50
cover stations and 5 meta EVAs, 55 EVAs), capped at 41 per rolling minute in its own lane (one token every 1.5 s, every
IRIS source paused together after a 429 or 503), plus StaDa and FaSta once a day. Budget:

| Item | Requests |
| --- | --- |
| Full changes (`fchg`) every 3 minutes per EVA | 55 / 3 = 18.33 a minute |
| Plan of the hour 3 hours ahead, once an hour per EVA | 55 / 60 = 0.92 a minute |
| Steady total | 55 x (1/3 + 1/60) = **19.25 a minute**, under the 41 of the bucket and the 60 of the plan |
| Start without a plan in the last hour: plans of the current hour and the two after it | 3 x 55 = 165 once, about 4 minutes at 40 a minute |
| Ceiling at this cadence | 41 / (1/3 + 1/60) = about **117 EVAs** |

A larger cover needs a slower full-changes cadence first. The cover is recomputed over a full weekday with
`spikes/sp-2-coverage/scripts/iris-cover-weekday.sh` (no IRIS call; see the SP-2 README). Only one
process may poll IRIS: the recorder and `pnpm db-apis sample` or `iris-run` share the lease file
`data/recordings/.db-timetables.lease`, and the CLI needs `--recordings <host recordings folder>` to find it. The CLI
refuses to start while the recorder holds the lease, and the recorder skips IRIS while the CLI holds it. A lease frees
itself 90 s after its poller stops; remove a stale file only when no poller runs.

## Only when publishing (milestone M10)

Nothing here is needed while the site runs locally. The maintainer decides on each of these.

| Service | Purpose | Env vars |
| --- | --- | --- |
| GitHub (`Kacper0199/gerlines-map`) | code hosting, CI | none (the `gh` CLI is signed in) |
| Domain registrar | the site's domain | none |
| Cloudflare (free plan) | DNS, CDN, R2 storage for map tiles, frames, archive and backups | `CLOUDFLARE_API_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `TILES_BASE_URL` |
| Hetzner Cloud | the server | `HCLOUD_TOKEN` |
| GlitchTip (self-hosted) or Sentry free | error tracking | `GLITCHTIP_DSN` |

## Not needed

- geOps realtime API: we compute trajectories ourselves; same input data.
- MapTiler, Stadia, Mapbox: keyless OpenFreeMap, VersaTiles and Mapterhorn cover development; production
  self-hosts PMTiles. Their free plans are non-commercial anyway.
- Hugging Face token: the piebro dataset is public.
