CREATE TABLE source_holder (
  source_id text NOT NULL,
  position smallint NOT NULL,
  name text NOT NULL,
  role text NOT NULL,
  url text,
  CONSTRAINT source_holder_pkey PRIMARY KEY (source_id, position),
  CONSTRAINT source_holder_source_id_format CHECK (source_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT source_holder_position_range CHECK (position >= 0),
  CONSTRAINT source_holder_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT source_holder_role_known CHECK (role IN ('publisher', 'aggregator', 'mirror')),
  CONSTRAINT source_holder_url_https CHECK (url ~ '^https://[^\s/?#@]+(/[^\s]*)?$')
);

COMMENT ON TABLE source_holder IS
  'Holders a source''s licence asks to name, in order, so clients join them per locale. Keyed by source id '
  'without a foreign key: sources are written by the loaders that use them, after migrations run.';

INSERT INTO source_holder (source_id, position, name, role, url) VALUES
  ('delfi-gtfs', 0, 'DELFI e.V.', 'publisher', 'https://www.delfi.de/'),
  ('delfi-gtfs-rt', 0, 'DELFI e.V.', 'publisher', 'https://www.delfi.de/'),
  ('delfi-gtfs-rt', 1, 'traines.eu', 'mirror', 'https://mirror.traines.eu/'),
  ('delfi-gtfs-rt-deincr', 0, 'DELFI e.V.', 'publisher', 'https://www.delfi.de/'),
  ('delfi-gtfs-rt-deincr', 1, 'traines.eu', 'mirror', 'https://mirror.traines.eu/'),
  ('delfi-gtfs-sa', 0, 'DELFI e.V.', 'publisher', 'https://www.delfi.de/'),
  ('delfi-gtfs-sa', 1, 'traines.eu', 'mirror', 'https://mirror.traines.eu/'),
  ('mobilithek-delfi-gtfs-rt', 0, 'DELFI e.V.', 'publisher', 'https://www.delfi.de/'),
  ('gtfsde-rt', 0, 'DELFI e.V.', 'publisher', 'https://www.delfi.de/'),
  ('gtfsde-rt', 1, 'GTFS.de', 'aggregator', 'https://gtfs.de/'),
  ('gtfsde-static-fv', 0, 'DELFI e.V.', 'publisher', 'https://www.delfi.de/'),
  ('gtfsde-static-fv', 1, 'GTFS.de', 'aggregator', 'https://gtfs.de/'),
  ('gtfsde-static-rv', 0, 'DELFI e.V.', 'publisher', 'https://www.delfi.de/'),
  ('gtfsde-static-rv', 1, 'GTFS.de', 'aggregator', 'https://gtfs.de/'),
  ('vbb-gtfs-rt', 0, 'VBB Verkehrsverbund Berlin-Brandenburg GmbH', 'publisher', 'https://www.vbb.de/'),
  ('vbn-gtfs-rt', 0, 'VBN Verkehrsverbund Bremen/Niedersachsen', 'publisher', 'https://www.vbn.de/'),
  ('ch-otd-gtfs-rt', 0, 'opentransportdata.swiss', 'publisher', 'https://opentransportdata.swiss/'),
  ('cz-czptt-gtfs-rt', 0, 'Správa železnic', 'publisher', 'https://www.spravazeleznic.cz/'),
  ('cz-czptt-gtfs-rt', 1, 'motis.obehy.cz', 'aggregator', 'https://motis.obehy.cz/'),
  ('fr-sncf-gtfs-rt', 0, 'SNCF', 'publisher', NULL),
  ('fr-sncf-gtfs-rt', 1, 'transport.data.gouv.fr', 'mirror', 'https://transport.data.gouv.fr/'),
  ('ovapi-train-updates', 0, 'OVapi', 'publisher', 'https://gtfs.ovapi.nl/'),
  ('pl-pkpic-gtfs-rt', 0, 'PKP Intercity', 'publisher', NULL),
  ('pl-pkpic-gtfs-rt', 1, 'gtfs.kasznia.net', 'aggregator', 'https://gtfs.kasznia.net/'),
  ('pl-trains-gtfs-rt', 0, 'PKP PLK', 'publisher', NULL),
  ('pl-trains-gtfs-rt', 1, 'Mikołaj Kuranowski', 'aggregator', 'https://mkuran.pl/gtfs/'),
  ('be-sncb-gtfs-rt', 0, 'NMBS-SNCB', 'publisher', NULL);

CREATE TABLE stop_place_display_name (
  stop_place_id uuid PRIMARY KEY REFERENCES stop_place (stop_place_id) ON DELETE CASCADE,
  name text NOT NULL,
  source_id text NOT NULL REFERENCES source (source_id),
  rule text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stop_place_display_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT stop_place_display_name_rule_format CHECK (rule ~ '^[a-z][a-z0-9_:-]{1,62}$')
);

COMMENT ON TABLE stop_place_display_name IS
  'A stop place name that names its town where the timetable name does not (T-073), with its source.';

CREATE TABLE trip_product (
  feed_version_id integer NOT NULL,
  trip_key text NOT NULL,
  product text NOT NULL,
  source_id text NOT NULL REFERENCES source (source_id),
  rule text NOT NULL,
  CONSTRAINT trip_product_pkey PRIMARY KEY (feed_version_id, trip_key),
  CONSTRAINT trip_product_trip_fkey FOREIGN KEY (feed_version_id, trip_key)
    REFERENCES trip (feed_version_id, trip_key) ON DELETE CASCADE,
  CONSTRAINT trip_product_format CHECK (product ~ '^[A-Za-z]{1,8}$'),
  CONSTRAINT trip_product_rule_format CHECK (rule ~ '^[a-z][a-z0-9_:-]{1,62}$')
);

COMMENT ON TABLE trip_product IS
  'The product a timetable trip runs as (ICE, IC, NJ, RE ...) where the route name alone does not say it.';
