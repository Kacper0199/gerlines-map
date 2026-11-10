CREATE TABLE feed_version (
  feed_version_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL REFERENCES source (source_id),
  raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  published_on date NOT NULL,
  feed_version text,
  valid_from date,
  valid_to date,
  sha256 text NOT NULL,
  category_codes text[] NOT NULL,
  row_counts jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'loading',
  ingest_run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  loaded_at timestamptz,
  CONSTRAINT feed_version_run_fkey FOREIGN KEY (ingest_run_id, source_id)
    REFERENCES ingest_run (ingest_run_id, source_id),
  CONSTRAINT feed_version_source_sha256_key UNIQUE (source_id, sha256),
  CONSTRAINT feed_version_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT feed_version_status_known CHECK (status IN ('loading', 'loaded')),
  CONSTRAINT feed_version_loaded_when_done CHECK ((status = 'loaded') = (loaded_at IS NOT NULL)),
  CONSTRAINT feed_version_valid_order CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CONSTRAINT feed_version_categories_present CHECK (cardinality(category_codes) > 0)
);

CREATE INDEX feed_version_source_published_idx ON feed_version (source_id, published_on DESC);

CREATE TABLE route (
  feed_version_id integer NOT NULL REFERENCES feed_version (feed_version_id) ON DELETE CASCADE,
  route_key text NOT NULL,
  agency_key text,
  operator_id text REFERENCES operator (operator_id),
  short_name text,
  long_name text,
  gtfs_route_type smallint NOT NULL,
  category_code text NOT NULL REFERENCES category (category_code),
  category_rule text NOT NULL,
  is_foreign boolean NOT NULL,
  CONSTRAINT route_pkey PRIMARY KEY (feed_version_id, route_key),
  CONSTRAINT route_key_not_blank CHECK (btrim(route_key) <> ''),
  CONSTRAINT route_category_rule_not_blank CHECK (btrim(category_rule) <> '')
);

CREATE INDEX route_operator_idx ON route (operator_id);

CREATE TABLE service_calendar (
  feed_version_id integer NOT NULL REFERENCES feed_version (feed_version_id) ON DELETE CASCADE,
  service_key text NOT NULL,
  weekdays smallint NOT NULL,
  start_date date,
  end_date date,
  CONSTRAINT service_calendar_pkey PRIMARY KEY (feed_version_id, service_key),
  CONSTRAINT service_calendar_weekdays_range CHECK (weekdays BETWEEN 0 AND 127),
  CONSTRAINT service_calendar_dates_together CHECK ((start_date IS NULL) = (end_date IS NULL)),
  CONSTRAINT service_calendar_date_order CHECK (end_date >= start_date)
);

CREATE TABLE service_calendar_date (
  feed_version_id integer NOT NULL,
  service_key text NOT NULL,
  service_date date NOT NULL,
  exception_type smallint NOT NULL,
  CONSTRAINT service_calendar_date_pkey PRIMARY KEY (feed_version_id, service_key, service_date),
  CONSTRAINT service_calendar_date_service_fkey FOREIGN KEY (feed_version_id, service_key)
    REFERENCES service_calendar (feed_version_id, service_key) ON DELETE CASCADE,
  CONSTRAINT service_calendar_date_exception_known CHECK (exception_type IN (1, 2))
);

CREATE TABLE trip_pattern (
  feed_version_id integer NOT NULL,
  trip_pattern_id uuid NOT NULL,
  route_key text NOT NULL,
  shape_key text,
  stop_count smallint NOT NULL,
  CONSTRAINT trip_pattern_pkey PRIMARY KEY (feed_version_id, trip_pattern_id),
  CONSTRAINT trip_pattern_route_fkey FOREIGN KEY (feed_version_id, route_key)
    REFERENCES route (feed_version_id, route_key) ON DELETE CASCADE,
  CONSTRAINT trip_pattern_stop_count_min CHECK (stop_count >= 2)
);

CREATE INDEX trip_pattern_route_idx ON trip_pattern (feed_version_id, route_key);

CREATE TABLE trip_pattern_stop (
  feed_version_id integer NOT NULL,
  trip_pattern_id uuid NOT NULL,
  stop_index smallint NOT NULL,
  stop_point_id uuid NOT NULL REFERENCES stop_point (stop_point_id),
  CONSTRAINT trip_pattern_stop_pkey PRIMARY KEY (feed_version_id, trip_pattern_id, stop_index),
  CONSTRAINT trip_pattern_stop_pattern_fkey FOREIGN KEY (feed_version_id, trip_pattern_id)
    REFERENCES trip_pattern (feed_version_id, trip_pattern_id) ON DELETE CASCADE,
  CONSTRAINT trip_pattern_stop_index_range CHECK (stop_index >= 0)
);

CREATE INDEX trip_pattern_stop_point_idx ON trip_pattern_stop (stop_point_id);

CREATE TABLE trip (
  feed_version_id integer NOT NULL,
  trip_key text NOT NULL,
  route_key text NOT NULL,
  service_key text NOT NULL,
  trip_pattern_id uuid NOT NULL,
  shape_key text,
  headsign text,
  short_name text,
  direction_id smallint,
  block_key text,
  category_code text NOT NULL REFERENCES category (category_code),
  is_foreign boolean NOT NULL,
  first_departure_s integer NOT NULL,
  last_arrival_s integer NOT NULL,
  wheelchair_accessible smallint,
  bikes_allowed smallint,
  CONSTRAINT trip_pkey PRIMARY KEY (feed_version_id, trip_key),
  CONSTRAINT trip_route_fkey FOREIGN KEY (feed_version_id, route_key)
    REFERENCES route (feed_version_id, route_key) ON DELETE CASCADE,
  CONSTRAINT trip_service_fkey FOREIGN KEY (feed_version_id, service_key)
    REFERENCES service_calendar (feed_version_id, service_key),
  CONSTRAINT trip_pattern_fkey FOREIGN KEY (feed_version_id, trip_pattern_id)
    REFERENCES trip_pattern (feed_version_id, trip_pattern_id),
  CONSTRAINT trip_direction_known CHECK (direction_id IN (0, 1)),
  CONSTRAINT trip_time_order CHECK (last_arrival_s >= first_departure_s AND first_departure_s >= 0)
);

CREATE INDEX trip_pattern_idx ON trip (feed_version_id, trip_pattern_id);
CREATE INDEX trip_route_idx ON trip (feed_version_id, route_key);
CREATE INDEX trip_short_name_idx ON trip (feed_version_id, short_name);

CREATE TABLE stop_time (
  feed_version_id integer NOT NULL,
  trip_key text NOT NULL,
  stop_index smallint NOT NULL,
  stop_sequence integer NOT NULL,
  arrival_s integer,
  departure_s integer,
  pickup_type smallint NOT NULL DEFAULT 0,
  drop_off_type smallint NOT NULL DEFAULT 0,
  CONSTRAINT stop_time_pkey PRIMARY KEY (feed_version_id, trip_key, stop_index),
  CONSTRAINT stop_time_trip_fkey FOREIGN KEY (feed_version_id, trip_key)
    REFERENCES trip (feed_version_id, trip_key) ON DELETE CASCADE,
  CONSTRAINT stop_time_index_range CHECK (stop_index >= 0),
  CONSTRAINT stop_time_order CHECK (departure_s >= arrival_s),
  CONSTRAINT stop_time_pickup_known CHECK (pickup_type BETWEEN 0 AND 3),
  CONSTRAINT stop_time_drop_off_known CHECK (drop_off_type BETWEEN 0 AND 3)
);
