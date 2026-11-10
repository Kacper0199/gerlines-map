CREATE TABLE trip_instance (
  trip_instance_id uuid PRIMARY KEY,
  service_date date NOT NULL,
  feed_version_id integer REFERENCES feed_version (feed_version_id),
  trip_key text,
  operator_id text REFERENCES operator (operator_id),
  train_number text,
  category_code text REFERENCES category (category_code),
  origin_stop_place_id uuid NOT NULL REFERENCES stop_place (stop_place_id),
  origin_departure timestamptz NOT NULL,
  is_added boolean NOT NULL,
  first_source_id text NOT NULL REFERENCES source (source_id),
  first_observed_at timestamptz NOT NULL,
  first_raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  CONSTRAINT trip_instance_static_or_added CHECK (
    is_added OR (feed_version_id IS NOT NULL AND trip_key IS NOT NULL AND category_code IS NOT NULL)
  ),
  CONSTRAINT trip_instance_train_number_not_blank CHECK (btrim(train_number) <> '')
);

CREATE INDEX trip_instance_service_date_idx ON trip_instance (service_date);
CREATE INDEX trip_instance_trip_idx ON trip_instance (feed_version_id, trip_key);

CREATE TABLE match_backlog (
  source_id text NOT NULL REFERENCES source (source_id),
  entity_key text NOT NULL,
  service_date date NOT NULL,
  reason text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  first_observed_at timestamptz NOT NULL,
  first_raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  last_seen_hour timestamptz NOT NULL,
  CONSTRAINT match_backlog_pkey PRIMARY KEY (source_id, entity_key, service_date, reason),
  CONSTRAINT match_backlog_entity_key_not_blank CHECK (btrim(entity_key) <> ''),
  CONSTRAINT match_backlog_reason_format CHECK (reason ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT match_backlog_seen_order CHECK (last_seen_hour >= date_trunc('hour', first_observed_at))
);

CREATE INDEX match_backlog_reason_idx ON match_backlog (source_id, reason, service_date);

CREATE TABLE stop_event (
  service_date date NOT NULL,
  trip_instance_id uuid NOT NULL REFERENCES trip_instance (trip_instance_id),
  stop_index smallint NOT NULL,
  source_id text NOT NULL REFERENCES source (source_id),
  stop_place_id uuid NOT NULL REFERENCES stop_place (stop_place_id),
  scheduled_arrival timestamptz,
  scheduled_departure timestamptz,
  predicted_arrival timestamptz,
  predicted_departure timestamptz,
  arrival_delay_s integer,
  departure_delay_s integer,
  prediction_kind text,
  final_arrival timestamptz,
  final_departure timestamptz,
  final_quality text,
  platform_scheduled text,
  platform_actual text,
  cancelled boolean NOT NULL,
  additional boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  CONSTRAINT stop_event_pkey PRIMARY KEY (service_date, trip_instance_id, stop_index, source_id),
  CONSTRAINT stop_event_stop_index_range CHECK (stop_index >= 0),
  CONSTRAINT stop_event_prediction_kind_known CHECK (prediction_kind IN ('explicit', 'propagated')),
  CONSTRAINT stop_event_final_quality_known CHECK (final_quality IN ('live', 'carried')),
  CONSTRAINT stop_event_final_quality_present CHECK (
    (final_quality IS NULL) = (final_arrival IS NULL AND final_departure IS NULL)
  )
);

SELECT create_hypertable(
  'stop_event', by_range('service_date', INTERVAL '7 days'), create_default_indexes => false
);

CREATE INDEX stop_event_instance_idx ON stop_event (trip_instance_id, stop_index);

CREATE TABLE stop_event_forecast (
  trip_instance_id uuid NOT NULL REFERENCES trip_instance (trip_instance_id),
  stop_index smallint NOT NULL,
  source_id text NOT NULL REFERENCES source (source_id),
  observed_at timestamptz NOT NULL,
  service_date date NOT NULL,
  predicted_arrival timestamptz,
  predicted_departure timestamptz,
  arrival_delay_s integer,
  departure_delay_s integer,
  cancelled boolean NOT NULL,
  explicit boolean NOT NULL,
  raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  CONSTRAINT stop_event_forecast_pkey PRIMARY KEY (trip_instance_id, stop_index, source_id, observed_at),
  CONSTRAINT stop_event_forecast_stop_index_range CHECK (stop_index >= 0)
);

SELECT create_hypertable(
  'stop_event_forecast', by_range('observed_at', INTERVAL '1 day'), create_default_indexes => false
);

CREATE TABLE segment_obs (
  service_date date NOT NULL,
  trip_instance_id uuid NOT NULL REFERENCES trip_instance (trip_instance_id),
  from_index smallint NOT NULL,
  source_id text NOT NULL REFERENCES source (source_id),
  to_index smallint NOT NULL,
  from_stop_place_id uuid NOT NULL REFERENCES stop_place (stop_place_id),
  to_stop_place_id uuid NOT NULL REFERENCES stop_place (stop_place_id),
  dep_delay_from_s integer NOT NULL,
  arr_delay_to_s integer NOT NULL,
  delay_gain_s integer NOT NULL,
  run_sched_s integer NOT NULL,
  run_act_s integer NOT NULL,
  dwell_delay_s integer,
  distance_m double precision,
  speed_sched_kmh double precision,
  speed_impl_kmh double precision,
  observed_at timestamptz NOT NULL,
  raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  CONSTRAINT segment_obs_pkey PRIMARY KEY (service_date, trip_instance_id, from_index, source_id),
  CONSTRAINT segment_obs_leg_order CHECK (from_index >= 0 AND to_index > from_index),
  CONSTRAINT segment_obs_gain CHECK (delay_gain_s = arr_delay_to_s - dep_delay_from_s)
);

SELECT create_hypertable(
  'segment_obs', by_range('service_date', INTERVAL '7 days'), create_default_indexes => false
);

CREATE INDEX segment_obs_places_idx ON segment_obs (from_stop_place_id, to_stop_place_id, service_date);

CREATE TABLE alert (
  source_id text NOT NULL REFERENCES source (source_id),
  alert_key text NOT NULL,
  content_hash text NOT NULL,
  cause smallint,
  effect smallint,
  severity smallint,
  active_periods jsonb NOT NULL,
  selectors jsonb NOT NULL,
  header jsonb NOT NULL,
  description jsonb NOT NULL,
  url jsonb NOT NULL,
  trip_instance_ids uuid[] NOT NULL,
  stop_place_ids uuid[] NOT NULL,
  first_observed_at timestamptz NOT NULL,
  first_raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  last_seen_hour timestamptz NOT NULL,
  CONSTRAINT alert_pkey PRIMARY KEY (source_id, alert_key, content_hash),
  CONSTRAINT alert_key_not_blank CHECK (btrim(alert_key) <> ''),
  CONSTRAINT alert_content_hash_hex CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT alert_seen_order CHECK (last_seen_hour >= date_trunc('hour', first_observed_at))
);

CREATE INDEX alert_trip_instances_idx ON alert USING gin (trip_instance_ids);

CREATE TABLE event (
  event_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  event_type text NOT NULL,
  source_id text NOT NULL REFERENCES source (source_id),
  trip_instance_id uuid REFERENCES trip_instance (trip_instance_id),
  stop_index smallint,
  payload jsonb NOT NULL,
  raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  CONSTRAINT event_pkey PRIMARY KEY (event_id, occurred_at),
  CONSTRAINT event_type_known CHECK (
    event_type IN ('TripDelayChanged', 'TripCancelled', 'PlatformChanged', 'FeedStale', 'IngestRunCompleted')
  )
);

SELECT create_hypertable('event', by_range('occurred_at', INTERVAL '7 days'), create_default_indexes => false);

CREATE INDEX event_instance_idx ON event (trip_instance_id, occurred_at);

CREATE TABLE rt_payload (
  raw_object_id uuid PRIMARY KEY REFERENCES raw_object (raw_object_id),
  source_id text NOT NULL REFERENCES source (source_id),
  observed_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL,
  counts jsonb NOT NULL,
  error text
);

CREATE INDEX rt_payload_source_observed_idx ON rt_payload (source_id, observed_at);
